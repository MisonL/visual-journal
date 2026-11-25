import { MAX_OPENAI_UPLOAD_BYTES } from './image-request-limits';
import type { ImageProviderManifestSummary } from './image-upstream-provider-manifest';
import type { ImageGenerationBackend } from './image-upstream-strategy';

export {
    buildMatscaAppHeaders,
    mergeUpstreamHeaders,
    mergeUpstreamHeadersWithFixed,
    normalizeConfiguredUpstreamHeaders,
    readDefaultUpstreamUserAgent,
    summarizeUpstreamRequestHeaders
} from './upstream-request-headers';
export type { UpstreamRequestHeaders, UpstreamRequestHeaderSummary } from './upstream-request-headers';

export type ImageUpstreamProfileId = 'openai-compatible' | 'matsca';

export type PartialImagesCount = 0 | 1 | 2 | 3 | 4;

export type NumericRange = { min: number; max: number; allowedValues?: readonly number[] };

export type ImageRequestOperation = 'generate' | 'edit';

export type ImageBackendRangeCompatibility =
    { compatible: true; range: NumericRange } | { compatible: false; error: ImageUpstreamRangeError };

export type ImageBackendCompatibility = {
    compatible: boolean;
    imageCountRange?: NumericRange;
    partialImagesRange?: NumericRange;
    errors: ImageUpstreamRangeError[];
};

export type ImageBackendCompatibilityOptions = {
    validatePartialImages?: boolean;
};

type ImageBackendSelection = ImageGenerationBackend | 'server-default';

export const RESPONSES_IMAGE_COUNT_RANGE = { min: 1, max: 1 } as const;
export const RESPONSES_PARTIAL_IMAGES_RANGE = { min: 1, max: 3 } as const;

export class ImageUpstreamRangeError extends RangeError {
    readonly rangeLabel: string;
    readonly min: number;
    readonly max: number;

    constructor(rangeLabel: string, min: number, max: number) {
        super(`${rangeLabel}范围没有可用交集（min=${min}, max=${max}）。`);
        this.name = 'ImageUpstreamRangeError';
        this.rangeLabel = rangeLabel;
        this.min = min;
        this.max = max;
    }
}

export type ImageUpstreamProfile = {
    id: ImageUpstreamProfileId;
    providerManifest?: ImageProviderManifestSummary;
    generateCount: NumericRange;
    editCount: NumericRange;
    partialImages: NumericRange;
    upload: {
        maxImages: number;
        maxSingleBytes: number;
        maxTotalBytes?: number;
    };
    gptImage2: {
        allowTransparentBackground: boolean;
        sizePolicy: 'openai-compatible' | 'positive-integer';
    };
    /**
     * 上游是否按请求尺寸出图。
     *
     * `requested`（默认）：服务端把上游返回的图片归一到请求尺寸，宽高比偏差过大时报错。
     * `upstream_controlled`：渠道明确声明不保证遵循 `size`（部分中转渠道固定返回某个尺寸）。
     * 此时服务端不尝试缩放，直接接受上游真实尺寸并如实上报，避免把渠道行为误判为故障。
     */
    outputDimensions: ImageOutputDimensionPolicy;
};

export type ImageOutputDimensionPolicy = 'requested' | 'upstream_controlled';

export type ImageUpstreamProfileSummary = {
    activeProfile: ImageUpstreamProfileId;
    serverProfile: ImageUpstreamProfileId;
    serverProfileMixed: boolean;
    serverConstraintsMixed: boolean;
    serverConstraintsByProfile: ImageUpstreamProfile[];
    requestProfile: ImageUpstreamProfileId;
    activeConstraints: ImageUpstreamProfile;
    serverConstraints: ImageUpstreamProfile;
    requestConstraints: ImageUpstreamProfile;
};

export const DEFAULT_IMAGE_UPSTREAM_PROFILE_ID: ImageUpstreamProfileId = 'openai-compatible';

export const IMAGE_UPSTREAM_PROFILES: Record<ImageUpstreamProfileId, ImageUpstreamProfile> = {
    'openai-compatible': {
        id: 'openai-compatible',
        generateCount: { min: 1, max: 10 },
        editCount: { min: 1, max: 10 },
        partialImages: { min: 1, max: 3 },
        upload: {
            maxImages: 10,
            maxSingleBytes: MAX_OPENAI_UPLOAD_BYTES
        },
        gptImage2: {
            allowTransparentBackground: false,
            sizePolicy: 'openai-compatible'
        },
        outputDimensions: 'requested'
    },
    matsca: {
        id: 'matsca',
        generateCount: { min: 1, max: 4 },
        editCount: { min: 1, max: 4 },
        partialImages: { min: 0, max: 4 },
        upload: {
            maxImages: 8,
            maxSingleBytes: 10 * 1024 * 1024,
            maxTotalBytes: 80 * 1024 * 1024
        },
        gptImage2: {
            allowTransparentBackground: true,
            sizePolicy: 'positive-integer'
        },
        outputDimensions: 'requested'
    }
};

export function buildIntegerRangeOptions(range: NumericRange): number[] {
    if (range.allowedValues) return [...range.allowedValues];
    const values: number[] = [];
    for (let value = range.min; value <= range.max; value += 1) {
        values.push(value);
    }
    return values;
}

export function clampIntegerToRange(value: number, range: NumericRange): number {
    if (!range.allowedValues?.length) return Math.min(range.max, Math.max(range.min, value));
    return range.allowedValues.reduce((closest, candidate) => {
        const candidateDistance = Math.abs(candidate - value);
        const closestDistance = Math.abs(closest - value);
        return candidateDistance < closestDistance || (candidateDistance === closestDistance && candidate < closest)
            ? candidate
            : closest;
    });
}

export function isIntegerWithinRange(value: number, range: NumericRange): boolean {
    return (
        Number.isInteger(value) &&
        value >= range.min &&
        value <= range.max &&
        (!range.allowedValues || range.allowedValues.includes(value))
    );
}

export function resolveImageBackendSelection(
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null
): ImageGenerationBackend | undefined {
    return imageBackend === 'server-default' ? (defaultBackend ?? undefined) : imageBackend;
}

export function getImageCountRangeForBackend(
    profile: Pick<ImageUpstreamProfile, 'generateCount' | 'editCount'>,
    operation: ImageRequestOperation,
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null
): NumericRange {
    const profileRange = normalizePositiveImageCountRange(
        operation === 'generate' ? profile.generateCount : profile.editCount
    );
    const effectiveBackend = resolveImageBackendSelection(imageBackend, defaultBackend);
    if (effectiveBackend !== 'responses-image-generation') return profileRange;
    return intersectRanges([profileRange, RESPONSES_IMAGE_COUNT_RANGE], '图片数量');
}

export function getImageCountRangeCompatibilityForBackend(
    profile: Pick<ImageUpstreamProfile, 'generateCount' | 'editCount'>,
    operation: ImageRequestOperation,
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null
): ImageBackendRangeCompatibility {
    try {
        return {
            compatible: true,
            range: getImageCountRangeForBackend(profile, operation, imageBackend, defaultBackend)
        };
    } catch (error) {
        if (error instanceof ImageUpstreamRangeError) return { compatible: false, error };
        throw error;
    }
}

export function getPartialImagesRangeForBackend(
    profile: Pick<ImageUpstreamProfile, 'partialImages'>,
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null
): NumericRange {
    const effectiveBackend = resolveImageBackendSelection(imageBackend, defaultBackend);
    if (effectiveBackend !== 'responses-image-generation') return profile.partialImages;
    return intersectRanges([profile.partialImages, RESPONSES_PARTIAL_IMAGES_RANGE], 'partial_images');
}

export function getPartialImagesRangeCompatibilityForBackend(
    profile: Pick<ImageUpstreamProfile, 'partialImages'>,
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null
): ImageBackendRangeCompatibility {
    try {
        return {
            compatible: true,
            range: getPartialImagesRangeForBackend(profile, imageBackend, defaultBackend)
        };
    } catch (error) {
        if (error instanceof ImageUpstreamRangeError) return { compatible: false, error };
        throw error;
    }
}

export function getImageBackendCompatibility(
    profile: Pick<ImageUpstreamProfile, 'generateCount' | 'editCount' | 'partialImages'>,
    operation: ImageRequestOperation,
    imageBackend: ImageBackendSelection,
    defaultBackend?: ImageGenerationBackend | null,
    options: ImageBackendCompatibilityOptions = {}
): ImageBackendCompatibility {
    const imageCount = getImageCountRangeCompatibilityForBackend(profile, operation, imageBackend, defaultBackend);
    const partialImages =
        options.validatePartialImages === false
            ? { compatible: true as const, range: profile.partialImages }
            : getPartialImagesRangeCompatibilityForBackend(profile, imageBackend, defaultBackend);
    const errors = [
        ...(imageCount.compatible ? [] : [imageCount.error]),
        ...(partialImages.compatible ? [] : [partialImages.error])
    ];
    return {
        compatible: errors.length === 0,
        ...(imageCount.compatible ? { imageCountRange: imageCount.range } : {}),
        ...(partialImages.compatible ? { partialImagesRange: partialImages.range } : {}),
        errors
    };
}

export function normalizeImageUpstreamProfileId(value: string | undefined): ImageUpstreamProfileId | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'openai' || normalized === 'openai-compatible' || normalized === 'default') {
        return 'openai-compatible';
    }
    if (normalized === 'matsca') return 'matsca';
    return undefined;
}

export function readImageUpstreamProfile(
    input: {
        explicitProfile?: string;
        channelId?: string;
        baseUrl?: string;
    } = {}
): ImageUpstreamProfile {
    const explicit = normalizeImageUpstreamProfileId(input.explicitProfile);
    if (input.explicitProfile?.trim() && !explicit) {
        throw new Error(
            `不支持的图片上游 profile：${input.explicitProfile}。有效值：${Object.keys(IMAGE_UPSTREAM_PROFILES).join(', ')}`
        );
    }
    if (explicit) return IMAGE_UPSTREAM_PROFILES[explicit];
    if (isMatscaSource(input)) return IMAGE_UPSTREAM_PROFILES.matsca;
    return IMAGE_UPSTREAM_PROFILES[DEFAULT_IMAGE_UPSTREAM_PROFILE_ID];
}

export function summarizeImageUpstreamProfile(input: {
    requestApiBaseUrl?: string;
    serverProfileIds?: ImageUpstreamProfileId[];
    serverProfiles?: ImageUpstreamProfile[];
}): ImageUpstreamProfileSummary {
    const requestConstraints = readImageUpstreamProfile({ baseUrl: input.requestApiBaseUrl });
    const requestProfile = requestConstraints.id;
    const serverProfileIds = input.serverProfileIds ?? input.serverProfiles?.map((profile) => profile.id) ?? [];
    const serverProfiles = input.serverProfiles ?? serverProfileIds.map((id) => IMAGE_UPSTREAM_PROFILES[id]);
    const serverProfileMixed = hasMixedServerProfiles(serverProfiles);
    const serverConstraintsMixed = hasDisjointServerConstraints(serverProfiles);
    const uniqueServerProfiles = Array.from(new Set(serverProfiles.map((profile) => profile.id)));
    const serverProfile =
        uniqueServerProfiles.length === 1 ? uniqueServerProfiles[0] : DEFAULT_IMAGE_UPSTREAM_PROFILE_ID;
    const serverConstraints = combineImageUpstreamProfiles(serverProfiles);
    const activeConstraints = input.requestApiBaseUrl?.trim() ? requestConstraints : serverConstraints;
    return {
        activeProfile: input.requestApiBaseUrl?.trim() ? requestProfile : serverProfile,
        serverProfile,
        serverProfileMixed,
        serverConstraintsMixed,
        serverConstraintsByProfile: serverProfiles,
        requestProfile,
        activeConstraints,
        serverConstraints,
        requestConstraints
    };
}

export function resolveImageUpstreamProfileConstraints(input: {
    requestApiBaseUrl?: string;
    serverProfileIds?: ImageUpstreamProfileId[];
    serverProfiles?: ImageUpstreamProfile[];
}): ImageUpstreamProfile {
    return summarizeImageUpstreamProfile(input).activeConstraints;
}

export function combineImageUpstreamProfiles(profiles: ImageUpstreamProfile[]): ImageUpstreamProfile {
    if (profiles.length === 0) return IMAGE_UPSTREAM_PROFILES[DEFAULT_IMAGE_UPSTREAM_PROFILE_ID];
    if (profiles.length === 1) return profiles[0];
    const uniqueProfileIds = Array.from(new Set(profiles.map((profile) => profile.id)));
    const id = uniqueProfileIds.length === 1 ? uniqueProfileIds[0] : DEFAULT_IMAGE_UPSTREAM_PROFILE_ID;
    const maxTotalBytes = minDefined(profiles.map((profile) => profile.upload.maxTotalBytes));
    return {
        id,
        generateCount: intersectRangesOrUnion(profiles.map((profile) => profile.generateCount)),
        editCount: intersectRangesOrUnion(profiles.map((profile) => profile.editCount)),
        partialImages: intersectRangesOrUnion(profiles.map((profile) => profile.partialImages)),
        upload: {
            maxImages: Math.min(...profiles.map((profile) => profile.upload.maxImages)),
            maxSingleBytes: Math.min(...profiles.map((profile) => profile.upload.maxSingleBytes)),
            ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {})
        },
        gptImage2: {
            allowTransparentBackground: profiles.every((profile) => profile.gptImage2.allowTransparentBackground),
            sizePolicy: profiles.every((profile) => profile.gptImage2.sizePolicy === 'positive-integer')
                ? 'positive-integer'
                : 'openai-compatible'
        },
        // 混合渠道时，只要有一个渠道保证按请求尺寸出图，就不能整体放宽。
        outputDimensions: profiles.every((profile) => profile.outputDimensions === 'upstream_controlled')
            ? 'upstream_controlled'
            : 'requested'
    };
}

function intersectRanges(ranges: NumericRange[], rangeLabel: string): NumericRange {
    const min = Math.max(...ranges.map((range) => range.min));
    const max = Math.min(...ranges.map((range) => range.max));
    if (min > max) throw new ImageUpstreamRangeError(rangeLabel, min, max);
    const values = ranges.reduce<number[] | undefined>((intersection, range) => {
        const rangeValues = buildIntegerRangeOptions(range).filter((value) => value >= min && value <= max);
        if (intersection === undefined) return rangeValues;
        return intersection.filter((value) => rangeValues.includes(value));
    }, undefined);
    if (!values?.length) throw new ImageUpstreamRangeError(rangeLabel, min, max);
    return numericRangeFromValues(values);
}

function intersectRangesOrUnion(ranges: NumericRange[]): NumericRange {
    const min = Math.max(...ranges.map((range) => range.min));
    const max = Math.min(...ranges.map((range) => range.max));
    if (min <= max) {
        const intersection = ranges.reduce<number[] | undefined>((values, range) => {
            const rangeValues = buildIntegerRangeOptions(range).filter((value) => value >= min && value <= max);
            return values === undefined ? rangeValues : values.filter((value) => rangeValues.includes(value));
        }, undefined);
        if (intersection?.length) return numericRangeFromValues(intersection);
    }
    return numericRangeFromValues(ranges.flatMap((range) => buildIntegerRangeOptions(range)));
}

function normalizePositiveImageCountRange(range: NumericRange): NumericRange {
    const values = buildIntegerRangeOptions(range).filter((value) => value >= 1);
    if (!values.length) {
        const min = Math.max(1, range.min);
        throw new ImageUpstreamRangeError('图片数量', min, range.max);
    }
    return numericRangeFromValues(values);
}

function numericRangeFromValues(values: number[]): NumericRange {
    const normalized = Array.from(new Set(values.filter(Number.isInteger))).sort((left, right) => left - right);
    if (!normalized.length) throw new ImageUpstreamRangeError('数值', 1, 0);
    const min = normalized[0];
    const max = normalized[normalized.length - 1];
    if (normalized.length === max - min + 1) return { min, max };
    return { min, max, allowedValues: normalized };
}

function minDefined(values: Array<number | undefined>): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.min(...defined) : undefined;
}

function hasMixedServerProfiles(profiles: ImageUpstreamProfile[]): boolean {
    if (profiles.length <= 1) return false;
    const [firstProfile, ...remainingProfiles] = profiles;
    if (!firstProfile) return false;
    const firstSignature = imageUpstreamProfileSignature(firstProfile);
    return remainingProfiles.some((profile) => imageUpstreamProfileSignature(profile) !== firstSignature);
}

function hasDisjointServerConstraints(profiles: ImageUpstreamProfile[]): boolean {
    if (profiles.length <= 1) return false;
    return (
        hasDisjointRanges(profiles.map((profile) => profile.generateCount)) ||
        hasDisjointRanges(profiles.map((profile) => profile.editCount)) ||
        hasDisjointRanges(profiles.map((profile) => profile.partialImages))
    );
}

function hasDisjointRanges(ranges: Array<{ min: number; max: number }>): boolean {
    const intersection = ranges.reduce<number[] | undefined>((values, range) => {
        const rangeValues = buildIntegerRangeOptions(range);
        return values === undefined ? rangeValues : values.filter((value) => rangeValues.includes(value));
    }, undefined);
    return !intersection?.length;
}

function imageUpstreamProfileSignature(profile: ImageUpstreamProfile): string {
    return JSON.stringify({
        id: profile.id,
        generateCount: profile.generateCount,
        editCount: profile.editCount,
        partialImages: profile.partialImages,
        upload: {
            maxImages: profile.upload.maxImages,
            maxSingleBytes: profile.upload.maxSingleBytes,
            maxTotalBytes: profile.upload.maxTotalBytes ?? null
        },
        gptImage2: profile.gptImage2
    });
}

export function isValidImageUpstreamProfileId(value: string | undefined): boolean {
    return normalizeImageUpstreamProfileId(value) !== undefined;
}

export function isMatscaSource(input: { channelId?: string; baseUrl?: string }): boolean {
    const channelId = input.channelId?.trim().toLowerCase();
    if (channelId === 'matsca') return true;
    if (!input.baseUrl) return false;
    try {
        return new URL(input.baseUrl).hostname.toLowerCase() === 'img.matsca.com';
    } catch {
        return false;
    }
}
