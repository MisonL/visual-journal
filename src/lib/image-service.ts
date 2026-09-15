import { readAcceptedImageTaskDetails } from './accepted-image-task';
import { detectImageFormat, readImageDimensions, writeFileAtomic } from './agent-file-utils';
import {
    createImageResult,
    RequestValidationError,
    type StorageMode,
    type ValidOutputFormat
} from './image-request-utils';
import type { UpstreamRequestHeaders } from './image-upstream-profile';
import { downloadSameOriginImageAsBase64 } from './image-url-result';
import { createBatchId, createImageFilename, resolveImageOutputDir } from './server-runtime';
import { validatePositiveIntegerImageSize } from './size-utils';
import fs from 'fs/promises';
import type OpenAI from 'openai';
import path from 'path';

export { readAcceptedImageTaskDetails } from './accepted-image-task';
export type { AcceptedImageTaskDetails } from './accepted-image-task';

const DEFAULT_ACCEPTED_IMAGE_TASK_MAX_ATTEMPTS = 3;
const DEFAULT_ACCEPTED_IMAGE_TASK_RETRY_DELAY_MS = 5_000;
const MAX_ACCEPTED_IMAGE_TASK_RETRY_DELAY_MS = 15_000;
const MAX_ACCEPTED_IMAGE_TASK_RETRY_AFTER_SECONDS = 300;
// Some upstreams round each output edge independently. Allow only the small
// pixel drift that can be corrected with transparent/opaque padding; larger
// aspect-ratio changes must still fail instead of distorting the subject.
const MIN_NORMALIZABLE_ASPECT_DRIFT_PX = 8;
const MAX_NORMALIZABLE_ASPECT_DRIFT_RATIO = 0.01;

export type PersistedOpenAiImage = {
    filename: string;
    b64Json: string;
    responseJson?: string;
    path?: string;
    outputFormat: ValidOutputFormat;
    filepath: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
};

type ValidImagesResponse = OpenAI.Images.ImagesResponse & {
    data: NonNullable<OpenAI.Images.ImagesResponse['data']>;
};

export class InvalidOpenAiImagesResponseError extends Error {
    readonly result: unknown;

    constructor(result: unknown) {
        super('Images 响应无效或为空。');
        this.name = 'InvalidOpenAiImagesResponseError';
        this.result = result;
    }
}

export class MissingOpenAiImageDataError extends Error {
    readonly index: number;
    readonly result: unknown;
    readonly status = 502;

    constructor(index: number, result?: unknown) {
        super(`索引 ${index} 的图片数据缺少 base64 数据。`);
        this.name = 'MissingOpenAiImageDataError';
        this.index = index;
        this.result = result;
    }
}

export class AcceptedImageTaskResponseError extends Error {
    readonly taskId?: string;
    readonly pollUrl?: string;
    readonly retryAfterSeconds?: number;
    readonly status = 502;

    constructor(input: { taskId?: string; pollUrl?: string; retryAfterSeconds?: number }) {
        super('上游返回了异步图片任务，但没有拿到可直接消费的最终图片结果。');
        this.name = 'AcceptedImageTaskResponseError';
        this.taskId = input.taskId;
        this.pollUrl = input.pollUrl;
        this.retryAfterSeconds = input.retryAfterSeconds;
    }
}

export type RequestedImageDimensions = {
    width: number;
    height: number;
};

export class ImageDimensionMismatchError extends Error {
    readonly code = 'image_dimension_mismatch';
    readonly status = 502;
    readonly expected: RequestedImageDimensions;
    readonly actual: { width: number | null; height: number | null };

    constructor(expected: RequestedImageDimensions, actual: { width: number | null; height: number | null }) {
        super(
            actual.width === null || actual.height === null
                ? `上游图片尺寸无法识别，无法满足请求尺寸 ${expected.width}x${expected.height}。`
                : `上游图片尺寸 ${actual.width}x${actual.height} 与请求尺寸 ${expected.width}x${expected.height} 的宽高比不一致，无法安全归一化。`
        );
        this.name = 'ImageDimensionMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

export function readRequestedImageDimensions(size: string | null | undefined): RequestedImageDimensions | undefined {
    if (!size || size === 'auto') return undefined;
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const validation = validatePositiveIntegerImageSize(width, height);
    if (!validation.valid) {
        throw new RequestValidationError(`请求尺寸无效：${validation.reason}`, 422);
    }
    return { width, height };
}

export function assertOpenAiImagesResponse(result: unknown): asserts result is ValidImagesResponse {
    const candidate = result as Partial<OpenAI.Images.ImagesResponse> | null | undefined;
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.data) || candidate.data.length === 0) {
        throw new InvalidOpenAiImagesResponseError(result);
    }
}

export function readRetryAfterSecondsHeader(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!/^[1-9]\d*$/.test(normalized)) return undefined;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    return parsed;
}

export async function resolveAcceptedImageTaskResponse<T extends OpenAI.Images.ImagesResponse>(
    operation: () => Promise<{ data: T; response?: Response }>,
    options: {
        abortSignal?: AbortSignal;
        maxAttempts?: number;
        retryDelayMs?: number;
        sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
        onAcceptedTask?: (details: AcceptedImageTaskResponseError, attempt: number, delayMs: number) => void;
    } = {}
): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_ACCEPTED_IMAGE_TASK_MAX_ATTEMPTS);
    const sleep = options.sleep ?? delayAcceptedImageTaskResponse;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAcceptedImageTaskRetryAborted(options.abortSignal);
        const { data, response } = await operation();
        const acceptedTask = readAcceptedImageTaskDetails(data);
        if (!acceptedTask) return data;

        const retryDelayMs = readAcceptedImageTaskRetryDelayMs(
            response?.headers.get('retry-after'),
            options.retryDelayMs ?? DEFAULT_ACCEPTED_IMAGE_TASK_RETRY_DELAY_MS
        );
        const error = new AcceptedImageTaskResponseError({
            ...acceptedTask,
            retryAfterSeconds: Math.ceil(retryDelayMs / 1000)
        });
        if (attempt >= maxAttempts) throw error;
        options.onAcceptedTask?.(error, attempt, retryDelayMs);
        await sleep(retryDelayMs, options.abortSignal);
    }

    throw new Error('UNREACHABLE: resolveAcceptedImageTaskResponse exhausted without return or throw.');
}

function delayAcceptedImageTaskResponse(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            abortSignal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timeout);
            reject(readAbortReason(abortSignal));
        };

        if (abortSignal?.aborted) {
            onAbort();
            return;
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
}

function throwIfAcceptedImageTaskRetryAborted(abortSignal?: AbortSignal): void {
    if (!abortSignal?.aborted) return;
    throw readAbortReason(abortSignal);
}

function readAbortReason(abortSignal?: AbortSignal): Error {
    if (abortSignal?.reason instanceof Error) return abortSignal.reason;
    if (abortSignal?.reason !== undefined) {
        return new DOMException(`The operation was aborted: ${String(abortSignal.reason)}`, 'AbortError');
    }
    return new DOMException('The operation was aborted.', 'AbortError');
}

function readAcceptedImageTaskRetryDelayMs(value: unknown, fallbackMs: number): number {
    const retryAfterSeconds = readRetryAfterSecondsHeader(value);
    if (retryAfterSeconds === undefined) return Math.min(fallbackMs, MAX_ACCEPTED_IMAGE_TASK_RETRY_DELAY_MS);
    return Math.min(retryAfterSeconds, MAX_ACCEPTED_IMAGE_TASK_RETRY_AFTER_SECONDS) * 1000;
}

export async function persistOpenAiImages(options: {
    result: OpenAI.Images.ImagesResponse;
    outputFormat: ValidOutputFormat;
    storageMode: StorageMode;
    includeBase64: boolean;
    normalizeOutputFormat?: boolean;
    targetDimensions?: RequestedImageDimensions;
    batchId?: string;
    apiBaseUrl?: string;
    apiKey?: string;
    upstreamProxyUrl?: string;
    upstreamHeaders?: UpstreamRequestHeaders;
    abortSignal?: AbortSignal;
}): Promise<PersistedOpenAiImage[]> {
    const result = options.result;
    assertOpenAiImagesResponse(result);
    const outputDir = resolveImageOutputDir();
    if (options.storageMode === 'fs') {
        await fs.mkdir(outputDir, { recursive: true });
    }
    const batchId = options.batchId || createBatchId();
    const persisted: PersistedOpenAiImage[] = [];
    const imageItems = result.data;
    const prepared: Array<{
        buffer: Buffer;
        detectedFormat: ReturnType<typeof detectImageFormat>;
        filename: string;
        filepath: string;
    }> = [];

    for (const [index, imageData] of imageItems.entries()) {
        const b64Json =
            imageData.b64_json ||
            (imageData.url
                ? await downloadSameOriginImageAsBase64({
                      imageUrl: imageData.url,
                      apiBaseUrl: options.apiBaseUrl,
                      apiKey: options.apiKey,
                      upstreamProxyUrl: options.upstreamProxyUrl,
                      upstreamHeaders: options.upstreamHeaders,
                      abortSignal: options.abortSignal
                  })
                : undefined);
        if (!b64Json) {
            throw new MissingOpenAiImageDataError(index, result);
        }
        const sourceBuffer = Buffer.from(b64Json, 'base64');
        const buffer =
            options.normalizeOutputFormat || options.targetDimensions
                ? await normalizeImageBuffer(sourceBuffer, options.outputFormat, options.targetDimensions)
                : sourceBuffer;
        const detectedFormat = detectImageFormat(buffer, options.outputFormat);
        const filename = createImageFilename(batchId, index, detectedFormat.outputFormat);
        const filepath = path.join(outputDir, filename);
        prepared.push({ buffer, detectedFormat, filename, filepath });
    }

    for (const item of prepared) {
        if (options.storageMode === 'fs') {
            await writeFileAtomic(item.filepath, item.buffer);
        }
        const dimensions = readImageDimensions(item.buffer);
        const persistedB64Json = item.buffer.toString('base64');
        const legacyResult = createImageResult(
            item.filename,
            persistedB64Json,
            item.detectedFormat.outputFormat,
            options.storageMode
        );
        persisted.push({
            filename: item.filename,
            b64Json: persistedB64Json,
            ...(options.includeBase64 ? { responseJson: persistedB64Json } : {}),
            ...(legacyResult.path ? { path: legacyResult.path } : {}),
            outputFormat: item.detectedFormat.outputFormat,
            filepath: item.filepath,
            mimeType: item.detectedFormat.mimeType,
            sizeBytes: item.buffer.byteLength,
            width: dimensions.width,
            height: dimensions.height
        });
    }

    return persisted;
}

export async function normalizeImageBuffer(
    buffer: Buffer,
    outputFormat: ValidOutputFormat,
    targetDimensions?: RequestedImageDimensions
): Promise<Buffer> {
    const detectedFormat = detectImageFormat(buffer, outputFormat);
    const sourceDimensions = readImageDimensions(buffer);
    if (targetDimensions) {
        const targetValidation = validatePositiveIntegerImageSize(targetDimensions.width, targetDimensions.height);
        if (!targetValidation.valid) {
            throw new RequestValidationError(`请求尺寸无效：${targetValidation.reason}`, 422);
        }
    }
    const aspectRatioDrift = targetDimensions
        ? readAspectRatioDriftPixels(sourceDimensions, targetDimensions)
        : undefined;
    if (targetDimensions && aspectRatioDrift === undefined) {
        throw new ImageDimensionMismatchError(targetDimensions, sourceDimensions);
    }
    if (detectedFormat.outputFormat === outputFormat && dimensionsMatch(sourceDimensions, targetDimensions)) {
        return buffer;
    }
    const { default: sharp } = await import('sharp');
    let image = sharp(buffer);
    if (targetDimensions) {
        image = image.resize(targetDimensions.width, targetDimensions.height, {
            fit: aspectRatioDrift === 0 ? 'fill' : 'contain',
            ...(aspectRatioDrift === 0
                ? {}
                : { background: outputFormat === 'jpeg' ? '#ffffff' : { r: 0, g: 0, b: 0, alpha: 0 } })
        });
    }
    if (outputFormat === 'webp') return image.webp({ quality: 100 }).toBuffer();
    if (outputFormat === 'jpeg') return image.jpeg({ quality: 100 }).toBuffer();
    return image.png().toBuffer();
}

function dimensionsMatch(
    actual: { width: number | null; height: number | null },
    expected: RequestedImageDimensions | undefined
): boolean {
    return (
        expected === undefined ||
        (actual.width !== null &&
            actual.height !== null &&
            actual.width === expected.width &&
            actual.height === expected.height)
    );
}

function readAspectRatioDriftPixels(
    actual: { width: number | null; height: number | null },
    expected: RequestedImageDimensions
): number | undefined {
    if (actual.width === null || actual.height === null) return undefined;
    if (actual.width <= 0 || actual.height <= 0) return undefined;
    if (BigInt(actual.width) * BigInt(expected.height) === BigInt(actual.height) * BigInt(expected.width)) {
        return 0;
    }

    const heightDrift = Math.abs((actual.height * expected.width) / actual.width - expected.height);
    const widthDrift = Math.abs((actual.width * expected.height) / actual.height - expected.width);
    const drift = Math.min(heightDrift, widthDrift);
    const relativeDrift = drift / Math.min(expected.width, expected.height);
    const maxDriftPixels = Math.max(
        MIN_NORMALIZABLE_ASPECT_DRIFT_PX,
        Math.ceil(Math.min(expected.width, expected.height) * MAX_NORMALIZABLE_ASPECT_DRIFT_RATIO)
    );
    return drift <= maxDriftPixels && relativeDrift <= MAX_NORMALIZABLE_ASPECT_DRIFT_RATIO ? drift : undefined;
}

export function persistedImageToLegacyResponse(image: PersistedOpenAiImage): {
    filename: string;
    b64_json: string;
    path?: string;
    output_format: string;
} {
    return {
        filename: image.filename,
        b64_json: image.responseJson || image.b64Json,
        output_format: image.outputFormat,
        ...(image.path ? { path: image.path } : {})
    };
}
