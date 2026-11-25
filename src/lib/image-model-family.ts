/**
 * 图像模型族登记表。
 *
 * 这里只登记“可以公开声明的事实”：模型族归属、尺寸语义、推荐预设和是否支持编辑。
 * 上游是否真的接受某个尺寸、是否真的返回透明背景，仍由渠道 provider manifest、
 * 上游运行时能力和真实响应决定；未登记的模型一律落到 provider_defined，
 * 也就是“本地只做资源上限保护，语义交给上游”。
 *
 * 新增模型族时只需要在 IMAGE_MODEL_FAMILIES 里加一条，不需要再改
 * size-utils / cost-utils / agent-model-directory 的判定分支。
 */

export type ImageModelSizePolicy =
    // 旧版 OpenAI 尺寸白名单：只接受 auto 和族内 legacySizes。
    | 'legacy_allowlist'
    // 走 OpenAI 兼容约束：最小/最大像素、16 倍数、3:1 长宽比，由渠道 profile 决定是否放宽。
    | 'openai_compatible'
    // 只做本地资源上限保护，尺寸语义完全交给上游。
    | 'provider_defined';

export type ImageModelFamilyId =
    | 'openai-gpt-image-1'
    | 'openai-gpt-image-2'
    | 'openai-gpt-image-2.5'
    | 'openai-gpt-image-2.6'
    | 'openai-dall-e'
    | 'xai-grok-imagine'
    | 'z-image'
    | 'google-gemini-image'
    | 'google-imagen'
    | 'bfl-flux'
    | 'bytedance-seedream'
    | 'alibaba-qwen-image'
    | 'stability-diffusion'
    | 'recraft'
    | 'ideogram'
    | 'midjourney'
    | 'novelai'
    | 'custom';

/**
 * 上游支持、但本服务尚未代理的输出格式。
 *
 * 这是一条能力声明，不是兑现承诺：本服务的输出格式白名单仍然只有
 * png/jpeg/webp，本地既不做 SVG 渲染也不做 GIF 合成。把它暴露给调用方，
 * 是为了让调用方能区分"上游不支持"和"本服务还没代理"，而不是让本服务
 * 假装支持后在上游返回二进制时处理不了。
 */
export type ImageExtraOutputFormat = 'svg' | 'gif';

/** 官方公布的模型生命周期，用于在能力声明里提示迁移而不是静默失败。 */
export type ImageModelLifecycle = {
    status: 'deprecated' | 'shutdown';
    /** 官方关停日期（YYYY-MM-DD）；未公布时缺省。 */
    shutdownDate?: string;
    note: string;
};

export type ImageModelFamily = {
    id: ImageModelFamilyId;
    /** 面向人的族名，用于能力声明和文档。 */
    label: string;
    sizePolicy: ImageModelSizePolicy;
    /** legacy_allowlist 族允许的尺寸；缺省表示不支持自定义尺寸。 */
    legacySizes?: readonly string[];
    /**
     * 是否允许 transparent 背景。null 表示本地不做判断，交给上游裁决；
     * 只有官方文档明确不支持的族才写 false。
     */
    allowTransparentBackground: boolean | null;
    /** 是否支持以图生图的编辑入口。 */
    supportsEdit: boolean;
    /** 完全匹配的模型 id。 */
    exactIds: readonly string[];
    /** 归一化后的 id 前缀匹配，用于覆盖上游随时新增的版本号。 */
    prefixes?: readonly string[];
    /** 面向 Agent 的推荐尺寸，仅作为建议，不作为本地硬校验。 */
    recommendedPresets?: readonly { name: string; size: string; purpose: string }[];
    /** 基础 low/medium/high/auto 之外，官方额外提供的质量档。 */
    extendedQualityTiers?: readonly string[];
    /** 是否支持 complexity（渲染前的规划算力控制），与 quality 正交。 */
    supportsComplexity?: boolean;
    /** 是否支持 markup 引导编辑；调用方需保证它与 mask 互斥。 */
    supportsMarkupEdits?: boolean;
    /** 上游支持、但本服务尚未代理的输出格式；不代表本服务接受这些取值。 */
    extraOutputFormats?: readonly ImageExtraOutputFormat[];
};

export const IMAGE_MODEL_FAMILIES: readonly ImageModelFamily[] = [
    {
        id: 'openai-gpt-image-2',
        label: 'OpenAI GPT Image 2',
        sizePolicy: 'openai_compatible',
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: ['gpt-image-2', 'gpt-image-2-1k'],
        recommendedPresets: [
            { name: 'square', size: '2048x2048', purpose: '通用正方形构图' },
            { name: 'landscape', size: '3072x2048', purpose: '横向宽幅构图' },
            { name: 'portrait', size: '2048x3072', purpose: '纵向主体构图' }
        ]
    },
    {
        // gpt-image-2.6 是没有日期化快照的型号（官方 snapshots 只列自身），
        // 因此前缀匹配不能再要求 -YYYY-MM-DD 结尾。
        id: 'openai-gpt-image-2.6',
        label: 'OpenAI GPT Image 2.6',
        sizePolicy: 'openai_compatible',
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['gpt-image-2.6'],
        extendedQualityTiers: ['xhigh', 'max'],
        supportsComplexity: true,
        supportsMarkupEdits: true,
        extraOutputFormats: ['svg', 'gif'],
        recommendedPresets: [
            { name: 'square', size: '1024x1024', purpose: '官方推荐正方形尺寸' },
            { name: 'landscape', size: '1536x1024', purpose: '官方推荐横向尺寸' },
            { name: 'portrait', size: '1024x1536', purpose: '官方推荐纵向尺寸' }
        ]
    },
    {
        id: 'openai-gpt-image-2.5',
        label: 'OpenAI GPT Image 2.5',
        sizePolicy: 'openai_compatible',
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['gpt-image-2.5'],
        extendedQualityTiers: ['xhigh', 'max'],
        supportsMarkupEdits: true,
        recommendedPresets: [
            { name: 'square', size: '1024x1024', purpose: '官方推荐正方形尺寸' },
            { name: 'landscape', size: '1536x1024', purpose: '官方推荐横向尺寸' },
            { name: 'portrait', size: '1024x1536', purpose: '官方推荐纵向尺寸' }
        ]
    },
    {
        id: 'openai-gpt-image-1',
        label: 'OpenAI GPT Image 1',
        sizePolicy: 'legacy_allowlist',
        legacySizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'],
        recommendedPresets: [
            { name: 'square', size: '1024x1024', purpose: '通用正方形构图' },
            { name: 'landscape', size: '1536x1024', purpose: '横向构图' },
            { name: 'portrait', size: '1024x1536', purpose: '纵向构图' }
        ]
    },
    {
        id: 'openai-dall-e',
        label: 'OpenAI DALL·E',
        sizePolicy: 'legacy_allowlist',
        legacySizes: ['auto', '1024x1024', '1792x1024', '1024x1792'],
        allowTransparentBackground: false,
        supportsEdit: false,
        exactIds: [],
        prefixes: ['dall-e']
    },
    {
        id: 'google-gemini-image',
        label: 'Google Gemini 图像',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['gemini-', 'nano-banana'],
        recommendedPresets: [
            { name: 'square', size: '1024x1024', purpose: '通用正方形构图' },
            { name: 'landscape', size: '1344x768', purpose: '16:9 横向构图' },
            { name: 'portrait', size: '768x1344', purpose: '9:16 纵向构图' }
        ]
    },
    {
        id: 'google-imagen',
        label: 'Google Imagen',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['imagen-']
    },
    {
        id: 'bfl-flux',
        label: 'Black Forest Labs FLUX',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['flux-', 'flux.'],
        recommendedPresets: [
            { name: 'square', size: '1024x1024', purpose: '通用正方形构图' },
            { name: 'landscape', size: '1344x768', purpose: '横向构图' },
            { name: 'portrait', size: '768x1344', purpose: '纵向构图' }
        ]
    },
    {
        id: 'bytedance-seedream',
        label: '字节 Seedream / Seededit',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['seedream', 'seededit', 'doubao-seedream', 'doubao-seededit']
    },
    {
        id: 'alibaba-qwen-image',
        label: '阿里 Qwen Image / Wanx',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['qwen-image', 'wanx', 'wan2', 'wan-']
    },
    {
        id: 'stability-diffusion',
        label: 'Stability SD / SDXL',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['sd-', 'sdxl', 'stable-diffusion', 'sd3']
    },
    {
        id: 'recraft',
        label: 'Recraft',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['recraft']
    },
    {
        id: 'ideogram',
        label: 'Ideogram',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['ideogram']
    },
    {
        // xAI 的图像能力通过 grok-imagine 族暴露；sub2api 与 new-api 都以该前缀识别。
        // 官方未公开可移植的尺寸矩阵，因此尺寸语义交给上游。
        id: 'xai-grok-imagine',
        label: 'xAI Grok Imagine',
        sizePolicy: 'provider_defined',
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: ['grok-imagine', 'grok-imagine-edit'],
        prefixes: ['grok-imagine-image']
    },
    {
        // z-image 出现在 new-api 的图生图识别清单和 Ideogram 的代理模型列表里，
        // 但官方尺寸与背景约束未在本地核实，因此只登记前缀，语义交给上游。
        id: 'z-image',
        label: 'Z-Image',
        sizePolicy: 'provider_defined',
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: ['z-image'],
        prefixes: ['z-image']
    },
    {
        id: 'midjourney',
        label: 'Midjourney 系列',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: true,
        exactIds: [],
        prefixes: ['mj-', 'midjourney', 'niji']
    },
    {
        id: 'novelai',
        label: 'NovelAI Diffusion',
        sizePolicy: 'provider_defined',
        // 官方未明确声明透明背景支持，交由上游裁决。
        allowTransparentBackground: null,
        supportsEdit: false,
        exactIds: [],
        prefixes: ['nai-diffusion', 'novelai-']
    }
];

/**
 * 官方已公布生命周期事件的模型。按模型 id 精确匹配，因为同一族内
 * 各型号的关停时间并不一致（例如 gpt-image-1 已关停，而 1.5 尚未到期）。
 */
export const IMAGE_MODEL_LIFECYCLES: Readonly<Record<string, ImageModelLifecycle>> = {
    'gpt-image-1': {
        status: 'shutdown',
        shutdownDate: '2026-10-23',
        note: 'gpt-image-1 已于 2026-10-23 关停，官方建议迁移到 gpt-image-2.5-sunburst。'
    },
    'gpt-image-1.5': {
        status: 'deprecated',
        shutdownDate: '2026-12-01',
        note: 'gpt-image-1.5 已弃用，将于 2026-12-01 关停，建议迁移到 2.5/2.6 系列。'
    },
    'gpt-image-1-mini': {
        status: 'deprecated',
        shutdownDate: '2026-12-01',
        note: 'gpt-image-1-mini 已弃用，将于 2026-12-01 关停，建议迁移到 2.5/2.6 系列。'
    },
    'gpt-image-2': {
        status: 'deprecated',
        shutdownDate: '2027-02-10',
        note: 'gpt-image-2 已弃用，将于 2027-02-10 关停，建议迁移到 2.5/2.6 系列。'
    },
    'dall-e-2': {
        status: 'shutdown',
        shutdownDate: '2026-05-12',
        note: 'dall-e-2 已于 2026-05-12 关停。'
    },
    'dall-e-3': {
        status: 'shutdown',
        shutdownDate: '2026-05-12',
        note: 'dall-e-3 已于 2026-05-12 关停。'
    }
};

/** 读取模型的生命周期事件；未登记表示官方未公布关停计划。 */
export function readImageModelLifecycle(model: string | undefined | null): ImageModelLifecycle | undefined {
    return IMAGE_MODEL_LIFECYCLES[normalizeImageModelId(model)];
}

const CUSTOM_ROOT_FAMILY: ImageModelFamily = {
    id: 'custom',
    label: '未登记的自定义模型',
    sizePolicy: 'provider_defined',
    allowTransparentBackground: null,
    supportsEdit: true,
    exactIds: []
};

/** 族内匹配：先精确命中，再按前缀命中，最后落到 custom。 */
export function resolveImageModelFamily(model: string | undefined | null): ImageModelFamily {
    const normalized = normalizeImageModelId(model);
    if (!normalized) return CUSTOM_ROOT_FAMILY;
    for (const family of IMAGE_MODEL_FAMILIES) {
        if (family.exactIds.includes(normalized)) return family;
    }
    for (const family of IMAGE_MODEL_FAMILIES) {
        if (family.prefixes?.some((prefix) => normalized.startsWith(prefix))) return family;
    }
    return CUSTOM_ROOT_FAMILY;
}

/** 归一化模型 id：去空白、转小写，避免渠道大小写差异导致匹配失败。 */
export function normalizeImageModelId(model: string | undefined | null): string {
    return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

/** 目录接口只需要两态：能否走自定义尺寸。openai_compatible 与 provider_defined 都算可以。 */
export function toDirectorySizePolicy(policy: ImageModelSizePolicy): 'provider_defined' | 'legacy_allowlist' {
    return policy === 'legacy_allowlist' ? 'legacy_allowlist' : 'provider_defined';
}

/** 族内推荐预设，供能力声明和文档使用。 */
export function readFamilyRecommendedPresets(model: string) {
    return resolveImageModelFamily(model).recommendedPresets ?? [];
}

/** 族内质量档：基础四档 + 官方为该族额外公布的档位。 */
export function readFamilyQualityTiers<T extends string>(
    model: string | undefined | null,
    baseTiers: readonly T[],
    allTiers: readonly T[]
): readonly T[] {
    const extended = resolveImageModelFamily(model).extendedQualityTiers;
    if (!extended || extended.length === 0) return baseTiers;
    // 扩展档只能来自契约常量已声明的全集；登记表若写了未知档位，
    // 宁可忽略也不能放宽出新的未声明取值。
    const universe = new Set<string>(allTiers);
    const extra = extended.filter((tier) => universe.has(tier)) as T[];
    if (extra.length === 0) return baseTiers;
    // 保持基础档顺序，把扩展档插在 auto 之前，auto 始终最后。
    const withoutAuto = baseTiers.filter((tier) => (tier as string) !== 'auto');
    const isAuto = (baseTiers as readonly string[]).includes('auto');
    const merged = [...withoutAuto, ...extra.filter((tier) => !(withoutAuto as readonly string[]).includes(tier))];
    return isAuto ? [...merged, 'auto' as T] : merged;
}

/** 族内额外支持的输出格式；空数组表示只支持 png/jpeg/webp。 */
export function readFamilyExtraOutputFormats(model: string | undefined | null): readonly ImageExtraOutputFormat[] {
    return resolveImageModelFamily(model).extraOutputFormats ?? [];
}

/** 该族是否支持 complexity 参数。 */
export function familySupportsComplexity(model: string | undefined | null): boolean {
    return resolveImageModelFamily(model).supportsComplexity === true;
}

/** 该族是否支持 markup 引导编辑。 */
export function familySupportsMarkupEdits(model: string | undefined | null): boolean {
    return resolveImageModelFamily(model).supportsMarkupEdits === true;
}
