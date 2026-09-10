import { GPT_IMAGE_MODELS, isGptImage2Model, type GptImageModel } from '@/lib/cost-utils';
import type { ImageUpstreamProfile } from '@/lib/image-upstream-profile';

type SizeValidationValues = Record<string, string | number>;

export type SizeValidation =
    { valid: true } | { valid: false; reason: string; reasonKey: string; values?: SizeValidationValues };

export const GPT_IMAGE_2_MIN_PIXELS = 655_360;
export const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
export const GPT_IMAGE_2_MAX_EDGE = 3840;
export const GPT_IMAGE_2_EDGE_MULTIPLE = 16;
export const GPT_IMAGE_2_MAX_ASPECT = 3;

export function isProviderDefinedCustomModel(model: GptImageModel): boolean {
    return !(GPT_IMAGE_MODELS as readonly string[]).includes(model);
}

export function supportsCustomImageSize(model: GptImageModel): boolean {
    return isGptImage2Model(model) || isProviderDefinedCustomModel(model);
}

export function shouldUsePositiveIntegerImageSize(
    model: GptImageModel,
    upstreamProfile: Pick<ImageUpstreamProfile, 'gptImage2'>
): boolean {
    return (
        isProviderDefinedCustomModel(model) ||
        (isGptImage2Model(model) && upstreamProfile.gptImage2.sizePolicy === 'positive-integer')
    );
}

export function validateGptImage2Size(width: number, height: number): SizeValidation {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return {
            valid: false,
            reason: '宽度和高度必须是正数。',
            reasonKey: 'sizeError.positive'
        };
    }
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        return {
            valid: false,
            reason: '宽度和高度必须是整数。',
            reasonKey: 'sizeError.whole'
        };
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        return {
            valid: false,
            reason: '宽度和高度超出可精确处理的整数范围。',
            reasonKey: 'sizeError.safeInteger'
        };
    }
    if (width % GPT_IMAGE_2_EDGE_MULTIPLE !== 0 || height % GPT_IMAGE_2_EDGE_MULTIPLE !== 0) {
        return {
            valid: false,
            reason: `宽边和高边都必须是 ${GPT_IMAGE_2_EDGE_MULTIPLE} 的倍数。`,
            reasonKey: 'sizeError.multiple',
            values: { multiple: GPT_IMAGE_2_EDGE_MULTIPLE }
        };
    }
    if (width > GPT_IMAGE_2_MAX_EDGE || height > GPT_IMAGE_2_MAX_EDGE) {
        return {
            valid: false,
            reason: `Maximum edge is ${GPT_IMAGE_2_MAX_EDGE}px.`,
            reasonKey: 'sizeError.maxEdge',
            values: { max: GPT_IMAGE_2_MAX_EDGE }
        };
    }
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (long / short > GPT_IMAGE_2_MAX_ASPECT) {
        return {
            valid: false,
            reason: `宽高比（长边:短边）必须小于等于 ${GPT_IMAGE_2_MAX_ASPECT}:1。`,
            reasonKey: 'sizeError.aspect',
            values: { max: GPT_IMAGE_2_MAX_ASPECT }
        };
    }
    const pixels = width * height;
    if (pixels < GPT_IMAGE_2_MIN_PIXELS) {
        return {
            valid: false,
            reason: `总像素必须至少为 ${GPT_IMAGE_2_MIN_PIXELS.toLocaleString()}。`,
            reasonKey: 'sizeError.minPixels',
            values: { min: GPT_IMAGE_2_MIN_PIXELS.toLocaleString() }
        };
    }
    if (pixels > GPT_IMAGE_2_MAX_PIXELS) {
        return {
            valid: false,
            reason: `总像素不能超过 ${GPT_IMAGE_2_MAX_PIXELS.toLocaleString()}。`,
            reasonKey: 'sizeError.maxPixels',
            values: { max: GPT_IMAGE_2_MAX_PIXELS.toLocaleString() }
        };
    }
    return { valid: true };
}

export function validatePositiveIntegerImageSize(width: number, height: number): SizeValidation {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return {
            valid: false,
            reason: '宽度和高度必须是正数。',
            reasonKey: 'sizeError.positive'
        };
    }
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        return {
            valid: false,
            reason: '宽度和高度必须是整数。',
            reasonKey: 'sizeError.whole'
        };
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        return {
            valid: false,
            reason: '宽度和高度超出可精确处理的整数范围。',
            reasonKey: 'sizeError.safeInteger'
        };
    }
    return { valid: true };
}

export function formatExactImagePixelCount(width: number, height: number, locale: string): string | null {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        return null;
    }
    return (BigInt(width) * BigInt(height)).toLocaleString(locale);
}

export function readImageSizeNumberInput(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

export type SizePreset =
    | 'auto'
    | 'custom'
    | 'square'
    | 'landscape'
    | 'portrait'
    | 'square-1k'
    | 'square-2k'
    | 'square-4k'
    | 'wide-4k'
    | 'tall-4k';

export type SizePresetOption = {
    value: SizePreset;
    group: 'automatic' | 'ratio' | 'resolution';
    dimensions: string | null;
};

const GPT_IMAGE_2_RESOLUTION_PRESETS: Array<Omit<SizePresetOption, 'dimensions'> & { dimensions: string }> = [
    { value: 'square-1k', group: 'resolution', dimensions: '1024x1024' },
    { value: 'square-2k', group: 'resolution', dimensions: '2048x2048' },
    { value: 'square-4k', group: 'resolution', dimensions: '3840x3840' },
    { value: 'wide-4k', group: 'resolution', dimensions: '3840x2160' },
    { value: 'tall-4k', group: 'resolution', dimensions: '2160x3840' }
];

/**
 * Returns the concrete WxH string for a preset, tailored to the model.
 * Returns null for 'auto' (let the API pick) and 'custom' (caller provides WxH).
 * gpt-image-2 uses higher-resolution variants of the same ratios.
 */
export function getPresetDimensions(preset: SizePreset, model: GptImageModel): string | null {
    if (preset === 'auto' || preset === 'custom') return null;
    const isGptImage2 = isGptImage2Model(model);
    switch (preset) {
        case 'square':
            return isGptImage2 ? '2048x2048' : '1024x1024';
        case 'landscape':
            return isGptImage2 ? '3072x2048' : '1536x1024';
        case 'portrait':
            return isGptImage2 ? '2048x3072' : '1024x1536';
        case 'square-1k':
            return '1024x1024';
        case 'square-2k':
            return '2048x2048';
        case 'square-4k':
            return '3840x3840';
        case 'wide-4k':
            return '3840x2160';
        case 'tall-4k':
            return '2160x3840';
    }
}

/**
 * Human-readable dimension info for tooltips.
 */
export function getPresetTooltip(preset: SizePreset, model: GptImageModel): string | null {
    const dims = getPresetDimensions(preset, model);
    if (!dims) return null;
    const [w, h] = dims.split('x').map(Number);
    const mp = ((w * h) / 1_000_000).toFixed(1);
    const ratio =
        preset === 'square' || preset.startsWith('square')
            ? '1:1'
            : preset === 'landscape'
              ? '3:2'
              : preset === 'portrait'
                ? '2:3'
                : preset === 'wide-4k'
                  ? '16:9'
                  : '9:16';
    return `${w} x ${h} - ${ratio} - ${mp} MP`;
}

export function getSizePresetOptions(input: {
    model: GptImageModel;
    upstreamProfile: Pick<ImageUpstreamProfile, 'gptImage2'>;
}): SizePresetOption[] {
    const options: SizePresetOption[] = [
        { value: 'auto', group: 'automatic', dimensions: null },
        ...(['square', 'landscape', 'portrait'] as SizePreset[]).map((value) => ({
            value,
            group: 'ratio' as const,
            dimensions: getPresetDimensions(value, input.model)
        }))
    ];
    if (!isGptImage2Model(input.model) && GPT_IMAGE_MODELS.includes(input.model as (typeof GPT_IMAGE_MODELS)[number])) {
        return options;
    }
    options.splice(1, 0, { value: 'custom', group: 'automatic', dimensions: null });
    const resolutionPresets = GPT_IMAGE_2_RESOLUTION_PRESETS.filter((preset) =>
        supportsPresetDimensions({
            dimensions: preset.dimensions,
            upstreamProfile: input.upstreamProfile
        })
    );
    return [...options, ...resolutionPresets];
}

function supportsPresetDimensions(input: {
    dimensions: string;
    upstreamProfile: Pick<ImageUpstreamProfile, 'gptImage2'>;
}): boolean {
    if (input.upstreamProfile.gptImage2.sizePolicy === 'positive-integer') return true;
    const [width, height] = input.dimensions.split('x').map(Number);
    return validateGptImage2Size(width, height).valid;
}
