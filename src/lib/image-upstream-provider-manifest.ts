import { RequestValidationError } from './image-request-utils';
import {
    DEFAULT_IMAGE_UPSTREAM_PROFILE_ID,
    IMAGE_UPSTREAM_PROFILES,
    normalizeImageUpstreamProfileId,
    type ImageUpstreamProfile,
    type ImageUpstreamProfileId
} from './image-upstream-profile';

export type ProviderSubmitContentType = 'application/json' | 'multipart/form-data';
export type ProviderSubmitMethod = 'POST';
export type ProviderPollMethod = 'GET' | 'POST';
export type ProviderResponseFormat = 'openai-images' | 'custom-json';
export type ProviderExecutionMode = 'sync-json' | 'multipart' | 'async-poll';

export type ImageProviderModeManifest = {
    submit: {
        path: string;
        method?: ProviderSubmitMethod;
        content_type?: ProviderSubmitContentType;
        response_format?: ProviderResponseFormat;
    };
    poll?: {
        path: string;
        method?: ProviderPollMethod;
        interval_ms?: number;
        timeout_ms?: number;
        status_path?: string;
        success_values?: string[];
        failure_values?: string[];
        result_path?: string;
    };
};

export type ImageProviderManifest = {
    schema_version?: 1;
    id: string;
    name?: string;
    base_profile?: ImageUpstreamProfileId;
    base_url?: string;
    modes: {
        generate?: ImageProviderModeManifest;
        edit?: ImageProviderModeManifest;
    };
    constraints?: {
        generate_count?: PartialRange;
        edit_count?: PartialRange;
        partial_images?: PartialRange;
        upload?: {
            max_images?: number;
            max_single_bytes?: number;
            max_total_bytes?: number;
        };
        gpt_image_2?: {
            allow_transparent_background?: boolean;
            size_policy?: ImageUpstreamProfile['gptImage2']['sizePolicy'];
        };
        /**
         * 声明上游是否遵循请求的 `size`。部分中转渠道会忽略 `size` 固定返回某个尺寸，
         * 这类渠道应显式声明 `upstream_controlled`，服务端才会接受上游真实尺寸而不报错。
         */
        output_dimensions?: ImageUpstreamProfile['outputDimensions'];
    };
};

export type ImageProviderManifestSummary = {
    id: string;
    name?: string;
    baseProfile: ImageUpstreamProfileId;
    modes: {
        generate?: ProviderExecutionMode;
        edit?: ProviderExecutionMode;
    };
    requestTypes: {
        generate?: ProviderSubmitContentType;
        edit?: ProviderSubmitContentType;
    };
    responseFormats: {
        generate?: ProviderResponseFormat;
        edit?: ProviderResponseFormat;
    };
    asyncPolling: {
        generate: boolean;
        edit: boolean;
    };
    executionSupport: {
        generate?: 'implemented' | 'declared_only';
        edit?: 'implemented' | 'declared_only';
    };
};

type PartialRange = {
    min?: number;
    max?: number;
};

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const JSON_CONTENT_TYPE: ProviderSubmitContentType = 'application/json';
const OPENAI_IMAGES_RESPONSE_FORMAT: ProviderResponseFormat = 'openai-images';
const MAX_PROVIDER_IMAGE_COUNT = 10;
const MAX_PROVIDER_PARTIAL_IMAGES = 4;
const MAX_PROVIDER_UPLOAD_IMAGES = 10;
const MAX_PROVIDER_UPLOAD_SINGLE_BYTES = 25 * 1024 * 1024;
const MAX_PROVIDER_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

export function parseImageProviderManifest(rawValue: string): ImageProviderManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawValue);
    } catch {
        throw new RequestValidationError('图片 provider manifest 不是有效 JSON。', 500);
    }
    return validateImageProviderManifest(parsed);
}

export function validateImageProviderManifest(value: unknown): ImageProviderManifest {
    const manifest = readObject(value, '图片 provider manifest');
    const schemaVersion = readOptionalNumber(manifest, 'schema_version');
    if (schemaVersion !== undefined && schemaVersion !== 1) {
        throw new RequestValidationError('图片 provider manifest schema_version 只支持 1。', 500);
    }

    const id = readRequiredString(manifest, 'id');
    if (!PROVIDER_ID_PATTERN.test(id)) {
        throw new RequestValidationError(
            '图片 provider manifest id 必须是 2 到 64 位小写字母、数字、下划线或连字符。',
            500
        );
    }

    const baseProfile = readBaseProfile(manifest.base_profile);
    const modes = readModes(manifest.modes);
    const baseUrl = readOptionalString(manifest, 'base_url');
    if (baseUrl) validateManifestBaseUrl(baseUrl);
    const constraints = readConstraintsField(manifest.constraints).constraints;
    if (constraints?.generate_count)
        validateRangeConstraint(constraints.generate_count, 'constraints.generate_count', { allowZero: false });
    if (constraints?.edit_count)
        validateRangeConstraint(constraints.edit_count, 'constraints.edit_count', { allowZero: false });
    if (constraints?.partial_images)
        validateRangeConstraint(constraints.partial_images, 'constraints.partial_images', { allowZero: true });
    if (constraints?.generate_count)
        validateRangeUpperBound(constraints.generate_count, 'constraints.generate_count', MAX_PROVIDER_IMAGE_COUNT);
    if (constraints?.edit_count)
        validateRangeUpperBound(constraints.edit_count, 'constraints.edit_count', MAX_PROVIDER_IMAGE_COUNT);
    if (constraints?.partial_images)
        validateRangeUpperBound(constraints.partial_images, 'constraints.partial_images', MAX_PROVIDER_PARTIAL_IMAGES);
    if (constraints?.upload) validateUploadUpperBounds(constraints.upload);

    return {
        schema_version: 1,
        id,
        ...readOptionalStringField(manifest, 'name'),
        base_profile: baseProfile,
        ...readOptionalStringField(manifest, 'base_url'),
        modes,
        ...(constraints ? { constraints } : {})
    };
}

export function createProviderManifestSummary(manifest: ImageProviderManifest): ImageProviderManifestSummary {
    return {
        id: manifest.id,
        ...(manifest.name ? { name: manifest.name } : {}),
        baseProfile: manifest.base_profile || DEFAULT_IMAGE_UPSTREAM_PROFILE_ID,
        modes: {
            ...(manifest.modes.generate ? { generate: readExecutionMode(manifest.modes.generate) } : {}),
            ...(manifest.modes.edit ? { edit: readExecutionMode(manifest.modes.edit) } : {})
        },
        requestTypes: {
            ...(manifest.modes.generate ? { generate: readSubmitContentType(manifest.modes.generate) } : {}),
            ...(manifest.modes.edit ? { edit: readSubmitContentType(manifest.modes.edit) } : {})
        },
        responseFormats: {
            ...(manifest.modes.generate ? { generate: readResponseFormat(manifest.modes.generate) } : {}),
            ...(manifest.modes.edit ? { edit: readResponseFormat(manifest.modes.edit) } : {})
        },
        asyncPolling: {
            generate: Boolean(manifest.modes.generate?.poll),
            edit: Boolean(manifest.modes.edit?.poll)
        },
        executionSupport: {
            ...(manifest.modes.generate ? { generate: readExecutionSupport(manifest.modes.generate) } : {}),
            ...(manifest.modes.edit ? { edit: readExecutionSupport(manifest.modes.edit) } : {})
        }
    };
}

export function createProviderManifestProfile(manifest: ImageProviderManifest): ImageUpstreamProfile {
    const baseProfile = IMAGE_UPSTREAM_PROFILES[manifest.base_profile || DEFAULT_IMAGE_UPSTREAM_PROFILE_ID];
    const constraints = manifest.constraints || {};
    return {
        ...baseProfile,
        id: baseProfile.id,
        providerManifest: createProviderManifestSummary(manifest),
        generateCount: readRangeConstraint(
            constraints.generate_count,
            baseProfile.generateCount,
            'constraints.generate_count',
            { allowZero: false }
        ),
        editCount: readRangeConstraint(constraints.edit_count, baseProfile.editCount, 'constraints.edit_count', {
            allowZero: false
        }),
        partialImages: readRangeConstraint(
            constraints.partial_images,
            baseProfile.partialImages,
            'constraints.partial_images',
            { allowZero: true }
        ),
        upload: {
            maxImages: readPositiveIntegerConstraint(
                constraints.upload?.max_images,
                baseProfile.upload.maxImages,
                'constraints.upload.max_images'
            ),
            maxSingleBytes: readPositiveIntegerConstraint(
                constraints.upload?.max_single_bytes,
                baseProfile.upload.maxSingleBytes,
                'constraints.upload.max_single_bytes'
            ),
            ...readOptionalMappedPositiveIntegerField(
                constraints.upload?.max_total_bytes,
                baseProfile.upload.maxTotalBytes,
                'constraints.upload.max_total_bytes',
                'maxTotalBytes'
            )
        },
        gptImage2: {
            allowTransparentBackground:
                constraints.gpt_image_2?.allow_transparent_background ??
                baseProfile.gptImage2.allowTransparentBackground,
            sizePolicy: constraints.gpt_image_2?.size_policy || baseProfile.gptImage2.sizePolicy
        },
        outputDimensions: constraints.output_dimensions || baseProfile.outputDimensions
    };
}

function readModes(value: unknown): ImageProviderManifest['modes'] {
    const modes = readObject(value, 'modes');
    const generate = modes.generate === undefined ? undefined : readMode(modes.generate, 'modes.generate');
    const edit = modes.edit === undefined ? undefined : readMode(modes.edit, 'modes.edit');
    if (!generate && !edit) {
        throw new RequestValidationError('图片 provider manifest 至少要声明 generate 或 edit 模式。', 500);
    }
    return {
        ...(generate ? { generate } : {}),
        ...(edit ? { edit } : {})
    };
}

function readMode(value: unknown, fieldName: string): ImageProviderModeManifest {
    const mode = readObject(value, fieldName);
    const submit = readSubmit(mode.submit, `${fieldName}.submit`);
    const poll = mode.poll === undefined ? undefined : readPoll(mode.poll, `${fieldName}.poll`);
    return {
        submit,
        ...(poll ? { poll } : {})
    };
}

function readSubmit(value: unknown, fieldName: string): ImageProviderModeManifest['submit'] {
    const submit = readObject(value, fieldName);
    const method = readOptionalString(submit, 'method') || 'POST';
    if (method !== 'POST') {
        throw new RequestValidationError(`${fieldName}.method 只支持 POST。`, 500);
    }
    const contentType = readOptionalString(submit, 'content_type') || JSON_CONTENT_TYPE;
    if (contentType !== 'application/json' && contentType !== 'multipart/form-data') {
        throw new RequestValidationError(
            `${fieldName}.content_type 只支持 application/json 或 multipart/form-data。`,
            500
        );
    }
    const responseFormat = readOptionalString(submit, 'response_format') || OPENAI_IMAGES_RESPONSE_FORMAT;
    if (responseFormat !== 'openai-images' && responseFormat !== 'custom-json') {
        throw new RequestValidationError(`${fieldName}.response_format 只支持 openai-images 或 custom-json。`, 500);
    }
    return {
        path: readPath(submit.path, `${fieldName}.path`),
        method,
        content_type: contentType,
        response_format: responseFormat
    };
}

function readPoll(value: unknown, fieldName: string): NonNullable<ImageProviderModeManifest['poll']> {
    const poll = readObject(value, fieldName);
    const method = readOptionalString(poll, 'method') || 'GET';
    if (method !== 'GET' && method !== 'POST') {
        throw new RequestValidationError(`${fieldName}.method 只支持 GET 或 POST。`, 500);
    }
    const intervalMs = readOptionalIntegerValue(poll.interval_ms, `${fieldName}.interval_ms`);
    const timeoutMs = readOptionalIntegerValue(poll.timeout_ms, `${fieldName}.timeout_ms`);
    return {
        path: readPath(poll.path, `${fieldName}.path`),
        method,
        ...readOptionalPositiveIntegerField(intervalMs, 1000, `${fieldName}.interval_ms`, 'interval_ms'),
        ...readOptionalPositiveIntegerField(timeoutMs, 120000, `${fieldName}.timeout_ms`, 'timeout_ms'),
        ...readOptionalStringField(poll, 'status_path'),
        ...readOptionalStringArrayField(poll, 'success_values'),
        ...readOptionalStringArrayField(poll, 'failure_values'),
        ...readOptionalStringField(poll, 'result_path')
    };
}

function readBaseProfile(value: unknown): ImageUpstreamProfileId {
    if (value === undefined) return DEFAULT_IMAGE_UPSTREAM_PROFILE_ID;
    if (typeof value !== 'string') {
        throw new RequestValidationError('base_profile 必须是字符串。', 500);
    }
    const normalized = normalizeImageUpstreamProfileId(value);
    if (!normalized) {
        throw new RequestValidationError('base_profile 必须是 openai-compatible 或 matsca。', 500);
    }
    return normalized;
}

function readExecutionMode(mode: ImageProviderModeManifest): ProviderExecutionMode {
    if (mode.poll) return 'async-poll';
    return readSubmitContentType(mode) === 'multipart/form-data' ? 'multipart' : 'sync-json';
}

function readExecutionSupport(mode: ImageProviderModeManifest): 'implemented' | 'declared_only' {
    return mode.poll ? 'declared_only' : 'implemented';
}

function readSubmitContentType(mode: ImageProviderModeManifest): ProviderSubmitContentType {
    return mode.submit.content_type || JSON_CONTENT_TYPE;
}

function readResponseFormat(mode: ImageProviderModeManifest): ProviderResponseFormat {
    return mode.submit.response_format || OPENAI_IMAGES_RESPONSE_FORMAT;
}

function readRangeConstraint(
    value: PartialRange | undefined,
    fallback: { min: number; max: number },
    fieldName: string,
    options: { allowZero: boolean }
): { min: number; max: number } {
    if (!value) return fallback;
    const min = readPositiveIntegerConstraint(value.min, fallback.min, `${fieldName}.min`, options);
    const max = readPositiveIntegerConstraint(value.max, fallback.max, `${fieldName}.max`, options);
    if (min > max) {
        throw new RequestValidationError(`${fieldName}.min 不能大于 max。`, 500);
    }
    return { min, max };
}

function validateRangeConstraint(value: PartialRange, fieldName: string, options: { allowZero: boolean }): void {
    if (!options.allowZero && value.min !== undefined && value.min < 1) {
        throw new RequestValidationError(`${fieldName}.min 必须是正整数。`, 500);
    }
    if (!options.allowZero && value.max !== undefined && value.max < 1) {
        throw new RequestValidationError(`${fieldName}.max 必须是正整数。`, 500);
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
        throw new RequestValidationError(`${fieldName}.min 不能大于 max。`, 500);
    }
}

function validateRangeUpperBound(value: PartialRange, fieldName: string, maxValue: number): void {
    if (value.min !== undefined && value.min > maxValue) {
        throw new RequestValidationError(`${fieldName}.min 不能大于 ${maxValue}。`, 500);
    }
    if (value.max !== undefined && value.max > maxValue) {
        throw new RequestValidationError(`${fieldName}.max 不能大于 ${maxValue}。`, 500);
    }
}

function validateUploadUpperBounds(
    upload: NonNullable<NonNullable<ImageProviderManifest['constraints']>['upload']>
): void {
    validateOptionalUpperBound(upload.max_images, 'constraints.upload.max_images', MAX_PROVIDER_UPLOAD_IMAGES);
    validateOptionalUpperBound(
        upload.max_single_bytes,
        'constraints.upload.max_single_bytes',
        MAX_PROVIDER_UPLOAD_SINGLE_BYTES
    );
    validateOptionalUpperBound(
        upload.max_total_bytes,
        'constraints.upload.max_total_bytes',
        MAX_PROVIDER_UPLOAD_TOTAL_BYTES
    );
}

function validateOptionalUpperBound(value: number | undefined, fieldName: string, maxValue: number): void {
    if (value !== undefined && value > maxValue) {
        throw new RequestValidationError(`${fieldName} 不能大于 ${maxValue}。`, 500);
    }
}

function readConstraintsField(value: unknown): Pick<ImageProviderManifest, 'constraints'> {
    if (value === undefined) return {};
    const constraints = readObject(value, 'constraints');
    const gptImage2 =
        constraints.gpt_image_2 === undefined ? undefined : readGptImage2Constraints(constraints.gpt_image_2);
    return {
        constraints: {
            ...readOptionalRangeField(constraints, 'generate_count'),
            ...readOptionalRangeField(constraints, 'edit_count'),
            ...readOptionalRangeField(constraints, 'partial_images'),
            ...readUploadConstraintsField(constraints.upload),
            ...(gptImage2 ? { gpt_image_2: gptImage2 } : {}),
            ...readOutputDimensionsField(constraints.output_dimensions)
        }
    };
}

function readOutputDimensionsField(
    value: unknown
): Pick<NonNullable<ImageProviderManifest['constraints']>, 'output_dimensions'> {
    if (value === undefined) return {};
    const outputDimensions = readOptionalString({ output_dimensions: value }, 'output_dimensions');
    if (outputDimensions !== 'requested' && outputDimensions !== 'upstream_controlled') {
        throw new RequestValidationError(
            'constraints.output_dimensions 只支持 requested 或 upstream_controlled。',
            500
        );
    }
    return { output_dimensions: outputDimensions };
}

function readGptImage2Constraints(value: unknown): NonNullable<ImageProviderManifest['constraints']>['gpt_image_2'] {
    const input = readObject(value, 'constraints.gpt_image_2');
    const sizePolicy = readOptionalString(input, 'size_policy');
    if (sizePolicy !== undefined && sizePolicy !== 'openai-compatible' && sizePolicy !== 'positive-integer') {
        throw new RequestValidationError('constraints.gpt_image_2.size_policy 无效。', 500);
    }
    const allowTransparentBackground = input.allow_transparent_background;
    if (allowTransparentBackground !== undefined && typeof allowTransparentBackground !== 'boolean') {
        throw new RequestValidationError('constraints.gpt_image_2.allow_transparent_background 必须是布尔值。', 500);
    }
    return {
        ...(allowTransparentBackground !== undefined
            ? { allow_transparent_background: allowTransparentBackground }
            : {}),
        ...(sizePolicy ? { size_policy: sizePolicy } : {})
    };
}

function readUploadConstraintsField(value: unknown): Pick<NonNullable<ImageProviderManifest['constraints']>, 'upload'> {
    if (value === undefined) return {};
    const upload = readObject(value, 'constraints.upload');
    return {
        upload: {
            ...readOptionalIntegerProperty(upload, 'max_images'),
            ...readOptionalIntegerProperty(upload, 'max_single_bytes'),
            ...readOptionalIntegerProperty(upload, 'max_total_bytes')
        }
    };
}

function readOptionalRangeField(object: Record<string, unknown>, fieldName: string): Record<string, PartialRange> {
    if (object[fieldName] === undefined) return {};
    const range = readObject(object[fieldName], `constraints.${fieldName}`);
    return {
        [fieldName]: {
            ...readOptionalIntegerProperty(range, 'min'),
            ...readOptionalIntegerProperty(range, 'max')
        }
    };
}

function readObject(value: unknown, fieldName: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RequestValidationError(`${fieldName} 必须是对象。`, 500);
    }
    return value as Record<string, unknown>;
}

function readRequiredString(object: Record<string, unknown>, fieldName: string): string {
    const value = readOptionalString(object, fieldName);
    if (!value) throw new RequestValidationError(`${fieldName} 必填。`, 500);
    return value;
}

function readOptionalString(object: Record<string, unknown>, fieldName: string): string | undefined {
    const value = object[fieldName];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
        throw new RequestValidationError(`${fieldName} 必须是字符串。`, 500);
    }
    const normalized = value.trim();
    return normalized || undefined;
}

function readOptionalNumber(object: Record<string, unknown>, fieldName: string): number | undefined {
    const value = object[fieldName];
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
        throw new RequestValidationError(`${fieldName} 必须是数字。`, 500);
    }
    return value;
}

function readOptionalStringField(object: Record<string, unknown>, fieldName: string): Record<string, string> {
    const value = readOptionalString(object, fieldName);
    return value ? { [fieldName]: value } : {};
}

function readOptionalStringArrayField(object: Record<string, unknown>, fieldName: string): Record<string, string[]> {
    const value = object[fieldName];
    if (value === undefined) return {};
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
        throw new RequestValidationError(`${fieldName} 必须是非空字符串数组。`, 500);
    }
    return { [fieldName]: value.map((item) => item.trim()) };
}

function readOptionalIntegerProperty(object: Record<string, unknown>, fieldName: string): Record<string, number> {
    const value = readOptionalIntegerValue(object[fieldName], fieldName);
    if (value === undefined) return {};
    if (value < 0) {
        throw new RequestValidationError(`${fieldName} 必须是非负整数。`, 500);
    }
    return { [fieldName]: value };
}

function readOptionalIntegerValue(value: unknown, fieldName: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new RequestValidationError(`${fieldName} 必须是整数。`, 500);
    }
    return value;
}

function readPositiveIntegerConstraint(
    value: number | undefined,
    fallback: number,
    fieldName: string,
    options: { allowZero?: boolean } = {}
): number {
    if (value === undefined) return fallback;
    const min = options.allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min) {
        throw new RequestValidationError(`${fieldName} 必须是${options.allowZero ? '非负' : '正'}整数。`, 500);
    }
    return value;
}

function readOptionalPositiveIntegerField(
    value: number | undefined,
    fallback: number | undefined,
    fieldName: string,
    outputFieldName?: string
): Record<string, number> {
    const resolved = value ?? fallback;
    if (resolved === undefined) return {};
    return {
        [outputFieldName || fieldName.split('.').at(-1) || fieldName]: readPositiveIntegerConstraint(
            resolved,
            resolved,
            fieldName
        )
    };
}

function readOptionalMappedPositiveIntegerField(
    value: number | undefined,
    fallback: number | undefined,
    fieldName: string,
    outputFieldName: string
): Record<string, number> {
    const resolved = value ?? fallback;
    if (resolved === undefined) return {};
    return {
        [outputFieldName]: readPositiveIntegerConstraint(resolved, resolved, fieldName)
    };
}

function readPath(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('://')) {
        throw new RequestValidationError(`${fieldName} 必须是以 / 开头的相对 API 路径。`, 500);
    }
    if (value.includes('..')) {
        throw new RequestValidationError(`${fieldName} 不能包含 ..。`, 500);
    }
    return value;
}

function validateManifestBaseUrl(value: string): void {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new RequestValidationError('base_url 必须是有效 URL。', 500);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RequestValidationError('base_url 必须使用 http 或 https。', 500);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new RequestValidationError('base_url 不能包含凭据、查询参数或片段。', 500);
    }
}
