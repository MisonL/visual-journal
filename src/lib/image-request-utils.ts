import { GPT_IMAGE_MODELS, isGptImage2Model } from './cost-utils';
import { MAX_OPENAI_UPLOAD_BYTES, MAX_PROMPT_LENGTH } from './image-request-limits';
import {
    IMAGE_UPSTREAM_PROFILES,
    isIntegerWithinRange,
    type ImageUpstreamProfile,
    type NumericRange
} from './image-upstream-profile';
import { isLoopbackIpAddress } from './network-security';
import { validateGptImage2Size, validatePositiveIntegerImageSize } from './size-utils';
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';
import type OpenAI from 'openai';

export const VALID_IMAGE_FILENAME_PATTERN = /^\d{13}(?:-[a-f0-9]{16})?-\d+\.(png|jpe?g|webp)$/i;
export const MAX_IMAGE_COUNT = 10;
export const MAX_UPLOAD_BYTES = MAX_OPENAI_UPLOAD_BYTES;
export { MAX_PROMPT_LENGTH } from './image-request-limits';

const VALID_MODE_VALUES = ['generate', 'edit'] as const;
// Keep the broadly compatible model as the implicit request default when no
// deployment-specific model is configured.
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const MAX_MODEL_NAME_LENGTH = 200;
const VALID_OUTPUT_FORMAT_VALUES = ['png', 'jpeg', 'webp'] as const;
const VALID_GENERATE_QUALITY_VALUES = ['low', 'medium', 'high', 'auto'] as const;
const VALID_EDIT_QUALITY_VALUES = ['low', 'medium', 'high', 'auto'] as const;
const VALID_BACKGROUND_VALUES = ['transparent', 'opaque', 'auto'] as const;
const VALID_MODERATION_VALUES = ['low', 'auto'] as const;
const VALID_LEGACY_SIZE_VALUES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
const VALID_UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const IMAGE_UPLOAD_CONTROL_FIELDS = new Set(['image_backend', 'image_streaming_strategy']);
const DEFAULT_IMAGE_PROFILE = IMAGE_UPSTREAM_PROFILES['openai-compatible'];
const DEFAULT_OUTPUT_FORMAT = 'webp';
const DEFAULT_LOSSY_OUTPUT_COMPRESSION = 100;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_IHDR_LENGTH = 13;
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_CRC_BYTES = 4;
const PNG_SCANLINE_FILTER_BYTES = 1;
const MAX_PNG_MASK_DECODE_BYTES = 128 * 1024 * 1024;
const inflateAsync = promisify(inflate);

type ImageDimensions = {
    width: number;
    height: number;
};

type PngInfo = ImageDimensions & {
    bitDepth: number;
    colorType: number;
    interlace: number;
    idatChunks: Uint8Array[];
    paletteAlpha?: Uint8Array;
    transparentGray?: number;
    transparentRgb?: [number, number, number];
};

export type ImageMode = (typeof VALID_MODE_VALUES)[number];
export type GptImageModel = string;
export type ValidOutputFormat = (typeof VALID_OUTPUT_FORMAT_VALUES)[number];
export type GenerateQuality = (typeof VALID_GENERATE_QUALITY_VALUES)[number];
export type EditQuality = (typeof VALID_EDIT_QUALITY_VALUES)[number];
export type Background = (typeof VALID_BACKGROUND_VALUES)[number];
export type Moderation = (typeof VALID_MODERATION_VALUES)[number];
export type StorageMode = 'fs' | 'indexeddb';
export type ImageRequestValidationOptions = {
    forceRequest?: boolean;
};

export function resolveDefaultImageModel(env: Record<string, string | undefined> = process.env): GptImageModel {
    const configured = env.OPENAI_IMAGE_MODEL?.trim();
    return configured && configured.length <= 200 ? configured : DEFAULT_IMAGE_MODEL;
}

export class RequestValidationError extends Error {
    readonly status: number;
    readonly details?: Record<string, unknown>;
    readonly code?: string;

    constructor(message: string, status = 400, details?: Record<string, unknown>, code?: string) {
        super(message);
        this.name = 'RequestValidationError';
        this.status = status;
        this.details = details;
        this.code = code;
    }
}

function isOneOf<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
    return (allowed as readonly string[]).includes(value);
}

export function readRequiredText(formData: FormData, field: string, maxLength = MAX_PROMPT_LENGTH): string {
    const value = formData.get(field);
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new RequestValidationError(`缺少必填参数：${field}`);
    }
    if (value.length > maxLength) {
        throw new RequestValidationError(`${field} 超过 ${maxLength} 个字符的最大长度。`);
    }
    return value;
}

export function readMode(formData: FormData): ImageMode {
    const value = formData.get('mode');
    if (typeof value !== 'string' || !isOneOf(value, VALID_MODE_VALUES)) {
        throw new RequestValidationError('mode 无效，必须是 generate 或 edit。');
    }
    return value;
}

export function readModel(formData: FormData): GptImageModel {
    const value = formData.get('model');
    if (value === null) return resolveDefaultImageModel();
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_MODEL_NAME_LENGTH) {
        throw new RequestValidationError('model 必须是 1 到 ' + MAX_MODEL_NAME_LENGTH + ' 个字符的非空字符串。');
    }
    return value.trim();
}

export function readCount(
    formData: FormData,
    field: string,
    fallback: number,
    min: number,
    max: number,
    range?: NumericRange
): number {
    const rawValue = formData.get(field);
    if (rawValue === null) return fallback;
    if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
        throw new RequestValidationError(`${field} 必须是整数。`);
    }
    const value = Number(rawValue);
    const effectiveRange = range ?? { min, max };
    if (!isIntegerWithinRange(value, effectiveRange)) {
        throw new RequestValidationError(
            effectiveRange.allowedValues
                ? `${field} 必须是以下值之一：${effectiveRange.allowedValues.join(', ')}。`
                : `${field} 必须在 ${min} 到 ${max} 之间。`
        );
    }
    return value;
}

export function readOutputFormat(formData: FormData): ValidOutputFormat {
    const rawValue = formData.get('output_format');
    if (rawValue === null) return DEFAULT_OUTPUT_FORMAT;
    if (typeof rawValue !== 'string') {
        throw new RequestValidationError('output_format 必须是字符串。');
    }
    const normalized = rawValue.toLowerCase();
    const mapped = normalized === 'jpg' ? 'jpeg' : normalized;
    if (!isOneOf(mapped, VALID_OUTPUT_FORMAT_VALUES)) {
        throw new RequestValidationError('output_format 无效，必须是 png、jpeg 或 webp。');
    }
    return mapped;
}

export function readGenerateQuality(formData: FormData): GenerateQuality {
    const value = formData.get('quality');
    if (value === null) return 'high';
    if (typeof value !== 'string' || !isOneOf(value, VALID_GENERATE_QUALITY_VALUES)) {
        throw new RequestValidationError('quality 无效。');
    }
    return value;
}

export function readEditQuality(formData: FormData): EditQuality {
    const value = formData.get('quality');
    if (value === null) return 'auto';
    if (typeof value !== 'string' || !isOneOf(value, VALID_EDIT_QUALITY_VALUES)) {
        throw new RequestValidationError('quality 无效。');
    }
    return value;
}

export function readBackground(
    formData: FormData,
    model: GptImageModel,
    profile: ImageUpstreamProfile = DEFAULT_IMAGE_PROFILE,
    options: ImageRequestValidationOptions = {}
): Background {
    const value = formData.get('background');
    if (value === null) return 'auto';
    if (typeof value !== 'string' || !isOneOf(value, VALID_BACKGROUND_VALUES)) {
        throw new RequestValidationError('background 无效。');
    }
    if (
        !options.forceRequest &&
        isGptImage2Model(model) &&
        value === 'transparent' &&
        !profile.gptImage2.allowTransparentBackground
    ) {
        throw new RequestValidationError('gpt-image-2 不支持 transparent 背景。');
    }
    return value;
}

export function readModeration(formData: FormData): Moderation {
    const value = formData.get('moderation');
    if (value === null) return 'auto';
    if (typeof value !== 'string' || !isOneOf(value, VALID_MODERATION_VALUES)) {
        throw new RequestValidationError('moderation 无效。');
    }
    return value;
}

export function readSize(
    formData: FormData,
    field: string,
    fallback: string,
    model: GptImageModel,
    profile: ImageUpstreamProfile = DEFAULT_IMAGE_PROFILE,
    options: ImageRequestValidationOptions = {}
): string {
    const value = formData.get(field);
    if (value === null) return fallback;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new RequestValidationError(`${field} 必须是字符串。`);
    }
    const isGptImage2 = isGptImage2Model(model);
    const isKnownLegacyModel = !isGptImage2 && (GPT_IMAGE_MODELS as readonly string[]).includes(model);
    const isProviderDefinedModel = !isGptImage2 && !isKnownLegacyModel;
    if (isKnownLegacyModel && !isOneOf(value, VALID_LEGACY_SIZE_VALUES)) {
        throw new RequestValidationError(`${field} 对 ${model} 无效：必须是兼容的预设尺寸。`);
    }
    if ((isGptImage2 || isProviderDefinedModel) && value !== 'auto' && !/^\d+x\d+$/.test(value)) {
        throw new RequestValidationError(`${field} 必须是 auto 或 WxH 格式的尺寸值。`);
    }
    if ((isGptImage2 || isProviderDefinedModel) && value !== 'auto' && options.forceRequest) {
        const { width, height } = parseFixedSizeValue(value);
        const validation = validatePositiveIntegerImageSize(width, height);
        if (!validation.valid) {
            throw new RequestValidationError(
                `${field} 对 ${model} 无效：${isPositiveIntegerDimensionValidation(validation) ? '宽度和高度必须是正整数。' : validation.reason}`
            );
        }
    }
    if (
        (isGptImage2 || isProviderDefinedModel) &&
        value !== 'auto' &&
        !options.forceRequest &&
        (isProviderDefinedModel || profile.gptImage2.sizePolicy === 'positive-integer')
    ) {
        const { width, height } = parseFixedSizeValue(value);
        const validation = validatePositiveIntegerImageSize(width, height);
        if (!validation.valid) {
            throw new RequestValidationError(
                `${field} 对 ${model} 无效：${isPositiveIntegerDimensionValidation(validation) ? '宽度和高度必须是正整数。' : validation.reason}`
            );
        }
    }
    if (
        isGptImage2 &&
        value !== 'auto' &&
        !options.forceRequest &&
        profile.gptImage2.sizePolicy === 'openai-compatible'
    ) {
        const { width, height } = parseFixedSizeValue(value);
        const validation = validateGptImage2Size(width, height);
        if (!validation.valid) {
            throw new RequestValidationError(`${field} 对 ${model} 无效：${validation.reason}`);
        }
    }
    return value;
}

function parseFixedSizeValue(value: string): { width: number; height: number } {
    const match = /^(\d+)x(\d+)$/.exec(value);
    return { width: Number(match?.[1]), height: Number(match?.[2]) };
}

function isPositiveIntegerDimensionValidation(
    validation: ReturnType<typeof validatePositiveIntegerImageSize>
): boolean {
    return !validation.valid && ['positive', 'whole', 'safeInteger'].some((key) => validation.reasonKey.endsWith(key));
}

export function readOutputCompression(formData: FormData, outputFormat: ValidOutputFormat): number | undefined {
    const value = formData.get('output_compression');
    if (value === null) return outputFormat === 'png' ? undefined : DEFAULT_LOSSY_OUTPUT_COMPRESSION;
    if (outputFormat === 'png') {
        throw new RequestValidationError('output_compression 仅适用于 jpeg 或 webp 输出。');
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new RequestValidationError('output_compression 必须是整数。');
    }
    const compression = Number(value);
    if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
        throw new RequestValidationError('output_compression 必须在 0 到 100 之间。');
    }
    return compression;
}

export function readStorageMode(env: NodeJS.ProcessEnv): StorageMode {
    const explicitMode = env.NEXT_PUBLIC_IMAGE_STORAGE_MODE;
    if (explicitMode === 'fs' || explicitMode === 'indexeddb') return explicitMode;
    if (explicitMode) {
        throw new RequestValidationError('NEXT_PUBLIC_IMAGE_STORAGE_MODE 必须是 fs 或 indexeddb。', 500);
    }
    return env.VERCEL === '1' ? 'indexeddb' : 'fs';
}

export function assertSafeApiOverride(
    requestApiKey: string,
    requestApiBaseUrl: string,
    options: { upstreamProxyConfigured?: boolean } = {}
): void {
    if (requestApiBaseUrl && !requestApiKey) {
        throw new RequestValidationError('填写自定义 API URL 时必须同时填写 API Key，避免服务器密钥被发送到未知地址。');
    }
    if (requestApiBaseUrl && options.upstreamProxyConfigured) {
        throw new RequestValidationError(
            '请求级自定义 API URL 不能与服务端上游代理同时使用。请把该地址配置为服务端渠道，或移除 OPENAI_UPSTREAM_PROXY_URL。'
        );
    }
}

export function validateApiBaseUrl(baseUrl: string, options: { allowedPlainHttpBaseUrls?: string[] } = {}): void {
    if (!baseUrl) return;
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new RequestValidationError('API URL 格式无效。');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new RequestValidationError('API URL 必须使用 http 或 https。');
    }
    if (parsed.protocol === 'http:' && !isAllowedPlainHttpApiBaseUrl(parsed, options.allowedPlainHttpBaseUrls)) {
        throw new RequestValidationError(
            '远程 HTTP API URL 默认不安全，请改用 HTTPS，或将完整 base URL 加入 OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS。'
        );
    }
    if (parsed.username || parsed.password) {
        throw new RequestValidationError('API URL 不能包含用户名或密码。');
    }
    if (parsed.search || parsed.hash) {
        throw new RequestValidationError('API URL 不能包含查询参数或片段。');
    }
}

function isAllowedPlainHttpApiBaseUrl(parsed: URL, allowedBaseUrls: string[] | undefined): boolean {
    if (isLoopbackHost(parsed.hostname)) return true;
    const normalized = normalizeApiBaseUrl(parsed);
    const configuredAllowlist = allowedBaseUrls ?? [];
    return configuredAllowlist.some((value) => normalizeApiBaseUrlSafely(value) === normalized);
}

function isLoopbackHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost' || normalized.endsWith('.localhost') || isLoopbackIpAddress(normalized);
}

export function readPlainHttpApiBaseUrlAllowlist(rawValue: string | undefined): string[] {
    if (!rawValue) return [];
    return rawValue
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value, index) => {
            let parsed: URL;
            try {
                parsed = new URL(value);
            } catch {
                throw new RequestValidationError(
                    `OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS 第 ${index + 1} 项必须是有效的 http URL。`,
                    500
                );
            }
            if (
                parsed.protocol !== 'http:' ||
                !parsed.hostname ||
                parsed.username ||
                parsed.password ||
                parsed.search ||
                parsed.hash
            ) {
                throw new RequestValidationError(
                    `OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS 第 ${index + 1} 项必须是无凭据、无查询参数和无片段的 http URL。`,
                    500
                );
            }
            return value;
        });
}

function normalizeApiBaseUrlSafely(value: string): string | undefined {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' ? normalizeApiBaseUrl(parsed) : undefined;
    } catch {
        return undefined;
    }
}

function normalizeApiBaseUrl(parsed: URL): string {
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function isValidImageFilename(filename: string): boolean {
    return VALID_IMAGE_FILENAME_PATTERN.test(filename);
}

export function safeImagePath(baseDir: string, filename: string): string {
    if (!isValidImageFilename(filename)) {
        throw new RequestValidationError('文件名无效');
    }
    return `${baseDir}/${filename}`;
}

export function readImageFiles(formData: FormData, profile: ImageUpstreamProfile = DEFAULT_IMAGE_PROFILE): File[] {
    const imageFilesByIndex = new Map<number, File>();
    for (const [key, value] of formData.entries()) {
        if (!key.startsWith('image_')) continue;
        if (IMAGE_UPLOAD_CONTROL_FIELDS.has(key)) continue;
        const imageIndex = readImageFileIndex(key, profile);
        if (imageIndex === undefined) {
            throw new RequestValidationError(
                `图片字段 ${key} 无效，必须使用 image_0 到 image_${profile.upload.maxImages - 1}。`
            );
        }
        if (imageFilesByIndex.has(imageIndex)) {
            throw new RequestValidationError(`图片字段 ${key} 重复。`);
        }
        if (!(value instanceof File)) {
            throw new RequestValidationError(`${key} 必须是图片文件。`);
        }
        imageFilesByIndex.set(imageIndex, value);
    }
    const imageFiles = Array.from(imageFilesByIndex.entries())
        .sort(([left], [right]) => left - right)
        .map(([, file]) => file);
    if (imageFiles.length === 0) {
        throw new RequestValidationError('编辑时必须提供图片文件。');
    }
    if (imageFiles.length > profile.upload.maxImages) {
        throw new RequestValidationError(`一次最多只能编辑 ${profile.upload.maxImages} 张图片。`);
    }
    const totalBytes = imageFiles.reduce((sum, file) => sum + file.size, 0);
    if (profile.upload.maxTotalBytes !== undefined && totalBytes > profile.upload.maxTotalBytes) {
        throw new RequestValidationError(`图片总大小超过 ${profile.upload.maxTotalBytes / 1024 / 1024} MB 限制。`);
    }
    imageFiles.forEach((file) => validateUploadFile(file, { maxBytes: profile.upload.maxSingleBytes }));
    return imageFiles;
}

export function assertImageFilesPresent(formData: FormData): void {
    let hasImageFile = false;
    for (const [key, value] of formData.entries()) {
        if (!key.startsWith('image_')) continue;
        if (IMAGE_UPLOAD_CONTROL_FIELDS.has(key)) continue;
        if (!(value instanceof File)) {
            throw new RequestValidationError(`${key} 必须是图片文件。`);
        }
        hasImageFile = true;
    }
    if (!hasImageFile) {
        throw new RequestValidationError('编辑时必须提供图片文件。');
    }
}

function readImageFileIndex(key: string, profile: ImageUpstreamProfile): number | undefined {
    if (!key.startsWith('image_')) return undefined;
    const suffix = key.slice('image_'.length);
    if (!/^(?:0|[1-9]\d*)$/.test(suffix)) return undefined;
    const index = Number(suffix);
    return Number.isInteger(index) && index >= 0 && index < profile.upload.maxImages ? index : undefined;
}

export function readMaskFile(
    formData: FormData,
    profile: ImageUpstreamProfile = DEFAULT_IMAGE_PROFILE
): File | undefined {
    const value = formData.get('mask');
    if (value === null) return undefined;
    if (!(value instanceof File)) {
        throw new RequestValidationError('mask 必须是 PNG 文件。');
    }
    validateUploadFile(value, { requirePng: true, fieldName: 'mask', maxBytes: profile.upload.maxSingleBytes });
    return value;
}

export async function assertMaskCompatibility(maskFile: File | undefined, imageFiles: File[]): Promise<void> {
    if (!maskFile) return;
    const maskBytes = new Uint8Array(await maskFile.arrayBuffer());
    const maskInfo = readPngInfo(maskBytes, 'mask');
    await assertPngMaskHasTransparentPixel(maskInfo);
    const sourceDimensions = await readUploadedImageDimensions(imageFiles[0], '源图片');
    if (sourceDimensions.width !== maskInfo.width || sourceDimensions.height !== maskInfo.height) {
        throw new RequestValidationError(
            `mask 尺寸（${maskInfo.width}x${maskInfo.height}）必须与源图片尺寸（${sourceDimensions.width}x${sourceDimensions.height}）一致。`
        );
    }
}

function validateUploadFile(
    file: File,
    options: { requirePng?: boolean; fieldName?: string; maxBytes?: number } = {}
): void {
    const fieldName = options.fieldName || file.name || 'image';
    const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    if (file.size <= 0) {
        throw new RequestValidationError(`${fieldName} 为空。`);
    }
    if (file.size > maxBytes) {
        throw new RequestValidationError(`${fieldName} 超过 ${maxBytes / 1024 / 1024} MB 限制。`);
    }
    if (options.requirePng && file.type !== 'image/png') {
        throw new RequestValidationError(`${fieldName} 必须是 PNG 文件。`);
    }
    if (!VALID_UPLOAD_IMAGE_TYPES.includes(file.type as (typeof VALID_UPLOAD_IMAGE_TYPES)[number])) {
        throw new RequestValidationError(`${fieldName} 必须是 PNG、JPEG 或 WebP 图片。`);
    }
}

async function readUploadedImageDimensions(file: File, fieldName: string): Promise<ImageDimensions> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dimensions = readPngDimensions(bytes) || readJpegDimensions(bytes) || readWebpDimensions(bytes);
    if (!dimensions) {
        throw new RequestValidationError(`${fieldName}尺寸无法校验。请使用 PNG、JPEG 或 WebP 图片。`);
    }
    return dimensions;
}

async function assertPngMaskHasTransparentPixel(info: PngInfo): Promise<void> {
    if (!pngCanRepresentTransparency(info)) {
        throw new RequestValidationError('mask 必须包含透明区域。');
    }
    const pixels = await decodePngPixels(info);
    if (!hasTransparentPixel(info, pixels)) {
        throw new RequestValidationError('mask 必须包含透明区域。');
    }
}

function pngCanRepresentTransparency(info: PngInfo): boolean {
    return (
        info.colorType === 4 ||
        info.colorType === 6 ||
        info.paletteAlpha !== undefined ||
        info.transparentGray !== undefined ||
        info.transparentRgb !== undefined
    );
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (!hasPngSignature(bytes)) return undefined;
    return readPngInfo(bytes, '图片');
}

function readPngInfo(bytes: Uint8Array, fieldName: string): PngInfo {
    if (!hasPngSignature(bytes)) {
        throw new RequestValidationError(`${fieldName} 必须是 PNG 文件。`);
    }
    let info: PngInfo | undefined;
    let offset: number = PNG_SIGNATURE.length;
    while (offset < bytes.length) {
        const chunkLength = readUint32(bytes, offset);
        const chunkType = readAscii(bytes, offset + 4, 4);
        const dataOffset = offset + PNG_CHUNK_HEADER_BYTES;
        const nextOffset = dataOffset + chunkLength + PNG_CHUNK_CRC_BYTES;
        if (nextOffset > bytes.length) throw new RequestValidationError(`${fieldName} PNG 数据不完整。`);
        const chunkData = bytes.subarray(dataOffset, dataOffset + chunkLength);
        if (chunkType === 'IHDR') info = readPngHeader(chunkData, fieldName);
        if (chunkType === 'IDAT') info?.idatChunks.push(chunkData);
        if (chunkType === 'tRNS' && info) applyPngTransparencyChunk(info, chunkData);
        if (chunkType === 'IEND') break;
        offset = nextOffset;
    }
    if (!info) throw new RequestValidationError(`${fieldName} PNG 缺少 IHDR。`);
    if (info.width <= 0 || info.height <= 0) throw new RequestValidationError(`${fieldName} PNG 尺寸无效。`);
    return info;
}

function readPngHeader(data: Uint8Array, fieldName: string): PngInfo {
    if (data.length !== PNG_IHDR_LENGTH) throw new RequestValidationError(`${fieldName} PNG IHDR 无效。`);
    return {
        width: readUint32(data, 0),
        height: readUint32(data, 4),
        bitDepth: data[8] ?? 0,
        colorType: data[9] ?? -1,
        interlace: data[12] ?? 0,
        idatChunks: []
    };
}

function applyPngTransparencyChunk(info: PngInfo, data: Uint8Array): void {
    if (info.colorType === 3) {
        info.paletteAlpha = data;
    } else if (info.colorType === 0 && data.length >= 2) {
        info.transparentGray = readUint16(data, 0);
    } else if (info.colorType === 2 && data.length >= 6) {
        info.transparentRgb = [readUint16(data, 0), readUint16(data, 2), readUint16(data, 4)];
    }
}

async function decodePngPixels(info: PngInfo): Promise<Uint8Array> {
    const channels = getPngChannelCount(info.colorType);
    if (info.bitDepth !== 8 || info.interlace !== 0) {
        throw new RequestValidationError('mask PNG 必须使用 8-bit 非交错格式以便校验透明区域。');
    }
    const rowBytes = info.width * channels;
    const expectedBytes = (rowBytes + PNG_SCANLINE_FILTER_BYTES) * info.height;
    if (expectedBytes > MAX_PNG_MASK_DECODE_BYTES) {
        throw new RequestValidationError('mask PNG 像素数据过大，无法安全校验透明区域。');
    }
    const raw = await inflatePngIdat(info.idatChunks, expectedBytes);
    if (raw.length < expectedBytes) throw new RequestValidationError('mask PNG 像素数据不完整。');
    return unfilterPngScanlines(raw, rowBytes, info.height, channels);
}

async function inflatePngIdat(chunks: Uint8Array[], maxOutputBytes: number): Promise<Uint8Array> {
    if (chunks.length === 0) throw new RequestValidationError('mask PNG 缺少 IDAT。');
    const compressed = chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks);
    try {
        return await inflateAsync(compressed, {
            maxOutputLength: maxOutputBytes
        });
    } catch {
        throw new RequestValidationError('mask PNG 像素数据无法解压。');
    }
}

function unfilterPngScanlines(raw: Uint8Array, rowBytes: number, height: number, bytesPerPixel: number): Uint8Array {
    const output = new Uint8Array(rowBytes * height);
    let rawOffset = 0;
    let outputOffset = 0;
    let previousRow = new Uint8Array(rowBytes);
    for (let row = 0; row < height; row += 1) {
        const filter = raw[rawOffset++];
        const currentRow = new Uint8Array(rowBytes);
        for (let column = 0; column < rowBytes; column += 1) {
            currentRow[column] = unfilterPngByte(
                filter,
                raw[rawOffset++],
                column,
                bytesPerPixel,
                currentRow,
                previousRow
            );
        }
        output.set(currentRow, outputOffset);
        outputOffset += rowBytes;
        previousRow = currentRow;
    }
    return output;
}

function unfilterPngByte(
    filter: number | undefined,
    value: number | undefined,
    column: number,
    bytesPerPixel: number,
    currentRow: Uint8Array,
    previousRow: Uint8Array
): number {
    const rawValue = value ?? 0;
    const left = column >= bytesPerPixel ? (currentRow[column - bytesPerPixel] ?? 0) : 0;
    const up = previousRow[column] ?? 0;
    const upLeft = column >= bytesPerPixel ? (previousRow[column - bytesPerPixel] ?? 0) : 0;
    if (filter === 0) return rawValue;
    if (filter === 1) return (rawValue + left) & 255;
    if (filter === 2) return (rawValue + up) & 255;
    if (filter === 3) return (rawValue + Math.floor((left + up) / 2)) & 255;
    if (filter === 4) return (rawValue + paethPredictor(left, up, upLeft)) & 255;
    throw new RequestValidationError('mask PNG 使用了无效的扫描线过滤器。');
}

function hasTransparentPixel(info: PngInfo, pixels: Uint8Array): boolean {
    if (info.colorType === 6) return hasTransparentAlphaChannel(pixels, 4, 3);
    if (info.colorType === 4) return hasTransparentAlphaChannel(pixels, 2, 1);
    if (info.colorType === 3) return hasTransparentPalettePixel(pixels, info.paletteAlpha);
    if (info.colorType === 0 && info.transparentGray !== undefined) return pixels.includes(info.transparentGray);
    if (info.colorType === 2 && info.transparentRgb) return hasTransparentRgbPixel(pixels, info.transparentRgb);
    return false;
}

function hasTransparentAlphaChannel(pixels: Uint8Array, stride: number, alphaOffset: number): boolean {
    for (let offset = alphaOffset; offset < pixels.length; offset += stride) {
        if ((pixels[offset] ?? 255) < 255) return true;
    }
    return false;
}

function hasTransparentPalettePixel(pixels: Uint8Array, paletteAlpha: Uint8Array | undefined): boolean {
    if (!paletteAlpha) return false;
    return pixels.some((paletteIndex) => (paletteAlpha[paletteIndex] ?? 255) < 255);
}

function hasTransparentRgbPixel(pixels: Uint8Array, transparentRgb: [number, number, number]): boolean {
    for (let offset = 0; offset + 2 < pixels.length; offset += 3) {
        if (
            pixels[offset] === transparentRgb[0] &&
            pixels[offset + 1] === transparentRgb[1] &&
            pixels[offset + 2] === transparentRgb[2]
        ) {
            return true;
        }
    }
    return false;
}

function getPngChannelCount(colorType: number): number {
    if (colorType === 0 || colorType === 3) return 1;
    if (colorType === 2) return 3;
    if (colorType === 4) return 2;
    if (colorType === 6) return 4;
    throw new RequestValidationError('mask PNG 颜色类型不受支持。');
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    let offset = 2;
    while (offset + 4 < bytes.length) {
        if (bytes[offset] !== 0xff) return undefined;
        const marker = bytes[offset + 1];
        offset += 2;
        if (marker === 0xd9 || marker === 0xda) return undefined;
        if (isJpegStandaloneMarker(marker)) continue;
        const segmentLength = readUint16(bytes, offset);
        if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
        if (marker !== undefined && isJpegStartOfFrame(marker)) {
            return { height: readUint16(bytes, offset + 3), width: readUint16(bytes, offset + 5) };
        }
        offset += segmentLength;
    }
    return undefined;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') return undefined;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const type = readAscii(bytes, offset, 4);
        const length = readUint32Le(bytes, offset + 4);
        const dataOffset = offset + 8;
        if (dataOffset + length > bytes.length) return undefined;
        const dimensions = readWebpChunkDimensions(type, bytes.subarray(dataOffset, dataOffset + length));
        if (dimensions) return dimensions;
        offset = dataOffset + length + (length % 2);
    }
    return undefined;
}

function readWebpChunkDimensions(type: string, data: Uint8Array): ImageDimensions | undefined {
    if (type === 'VP8X' && data.length >= 10) {
        return { width: 1 + readUint24Le(data, 4), height: 1 + readUint24Le(data, 7) };
    }
    if (type === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
        return {
            width: 1 + ((data[1] ?? 0) | (((data[2] ?? 0) & 0x3f) << 8)),
            height: 1 + ((((data[2] ?? 0) >> 6) & 0x03) | ((data[3] ?? 0) << 2) | (((data[4] ?? 0) & 0x0f) << 10))
        };
    }
    if (type === 'VP8 ' && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        return { width: readUint16Le(data, 6) & 0x3fff, height: readUint16Le(data, 8) & 0x3fff };
    }
    return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
    return (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
    );
}

function isJpegStandaloneMarker(marker: number | undefined): boolean {
    return marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7);
}

function hasPngSignature(bytes: Uint8Array): boolean {
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
    if (offset + length > bytes.length) return '';
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16(bytes: Uint8Array, offset: number): number {
    if (offset + 2 > bytes.length) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
    if (offset + 2 > bytes.length) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readUint32(bytes: Uint8Array, offset: number): number {
    if (offset + 4 > bytes.length) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
    if (offset + 4 > bytes.length) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
    return upDistance <= upLeftDistance ? up : upLeft;
}

export function createImageResult(
    filename: string,
    b64Json: string,
    outputFormat: ValidOutputFormat,
    storageMode: StorageMode
): { filename: string; b64_json: string; path?: string; output_format: string } {
    return {
        filename,
        b64_json: b64Json,
        output_format: outputFormat,
        ...(storageMode === 'fs' ? { path: `/api/image/${filename}` } : {})
    };
}

export type GenerateParams = Omit<OpenAI.Images.ImageGenerateParams, 'output_compression'> & {
    output_compression?: number;
    force_web?: boolean;
};
