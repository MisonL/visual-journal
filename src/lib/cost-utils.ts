type ApiUsage = {
    input_tokens_details?: {
        text_tokens?: number;
        image_tokens?: number;
    };
    output_tokens?: number;
};

export type CostDetails = {
    estimated_cost_usd: number;
    text_input_tokens: number;
    image_input_tokens: number;
    image_output_tokens: number;
};

export const GPT_IMAGE_MODELS = [
    'gpt-image-2',
    'gpt-image-2-1k',
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini'
] as const;
export const GPT_IMAGE_2_MODELS = ['gpt-image-2', 'gpt-image-2-1k'] as const;

// gpt-image-2.5 系列是 OpenAI 官方发布的图像模型（Flare 为小模型、Sunburst 为高质量模型）。
// 按官方文档，两者尺寸约束与 gpt-image-2 相同（16 倍数、1:3~3:1、单边 <=3840、总像素
// 655,360~8,294,400），并额外支持 xhigh 与 max 质量档；因此并入 openai-compatible 语义，
// 而不进入 legacy 尺寸白名单。
export const GPT_IMAGE_2_5_MODELS = ['gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;

// gpt-image-2.6 是 2.5 的继任者：官方模型页与 sub2api/new-api 的定价实现都表明
// 它沿用与 2.5 相同的 token 三档（文本输入 $5、图像输入 $8、图像输出 $30 / 1M），
// 因此复用同一组费率常量。注意官方 snapshots 只列自身，没有日期化快照。
export const GPT_IMAGE_2_6_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;

export function isGptImage25Model(model: GptImageModel): boolean {
    return (GPT_IMAGE_2_5_MODELS as readonly string[]).includes(model);
}

export function isGptImage26Model(model: GptImageModel): boolean {
    return (GPT_IMAGE_2_6_MODELS as readonly string[]).includes(model);
}

// 配置了费率的模型清单，供界面成本面板展示。
export const RATED_IMAGE_MODELS = [...GPT_IMAGE_2_6_MODELS, ...GPT_IMAGE_2_5_MODELS, ...GPT_IMAGE_MODELS] as const;

export type GptImageModel = string;

export function isGptImage2Model(model: GptImageModel): boolean {
    return (GPT_IMAGE_2_MODELS as readonly string[]).includes(model);
}

// gpt-image-1 价格。
const GPT_IMAGE_1_TEXT_INPUT_COST_PER_TOKEN = 0.000005; // $5.00/1M
const GPT_IMAGE_1_IMAGE_INPUT_COST_PER_TOKEN = 0.00001; // $10.00/1M
const GPT_IMAGE_1_IMAGE_OUTPUT_COST_PER_TOKEN = 0.00004; // $40.00/1M

// gpt-image-1-mini 价格。
const GPT_IMAGE_1_MINI_TEXT_INPUT_COST_PER_TOKEN = 0.000002; // $2.00/1M
const GPT_IMAGE_1_MINI_IMAGE_INPUT_COST_PER_TOKEN = 0.0000025; // $2.50/1M
const GPT_IMAGE_1_MINI_IMAGE_OUTPUT_COST_PER_TOKEN = 0.000008; // $8.00/1M

// gpt-image-1.5 价格。
const GPT_IMAGE_1_5_TEXT_INPUT_COST_PER_TOKEN = 0.000005; // $5.00/1M
const GPT_IMAGE_1_5_IMAGE_INPUT_COST_PER_TOKEN = 0.000008; // $8.00/1M
const GPT_IMAGE_1_5_IMAGE_OUTPUT_COST_PER_TOKEN = 0.000032; // $32.00/1M

// gpt-image-2 价格。
const GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN = 0.000005; // $5.00/1M
const GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN = 0.000008; // $8.00/1M
const GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN = 0.00003; // $30.00/1M

export type ModelRates = {
    textInputPerToken: number;
    imageInputPerToken: number;
    imageOutputPerToken: number;
    textInputPerMillion: number;
    imageInputPerMillion: number;
    imageOutputPerMillion: number;
};

const MODEL_RATES: Record<GptImageModel, ModelRates> = {
    // gpt-image-2.5 系列：官方定价与 gpt-image-2 的 token 三档一致（文本输入 $5、图像输入 $8、
    // 图像输出 $30 / 1M tokens），因此直接复用同一组常量。
    'gpt-image-2.6-flare': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2.6-sunburst': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2.5': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2.5-flare': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2.5-sunburst': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2-1k': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-2': {
        textInputPerToken: GPT_IMAGE_2_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_2_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_2_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 30
    },
    'gpt-image-1.5': {
        textInputPerToken: GPT_IMAGE_1_5_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_1_5_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_1_5_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 8,
        imageOutputPerMillion: 32
    },
    'gpt-image-1': {
        textInputPerToken: GPT_IMAGE_1_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_1_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_1_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 5,
        imageInputPerMillion: 10,
        imageOutputPerMillion: 40
    },
    'gpt-image-1-mini': {
        textInputPerToken: GPT_IMAGE_1_MINI_TEXT_INPUT_COST_PER_TOKEN,
        imageInputPerToken: GPT_IMAGE_1_MINI_IMAGE_INPUT_COST_PER_TOKEN,
        imageOutputPerToken: GPT_IMAGE_1_MINI_IMAGE_OUTPUT_COST_PER_TOKEN,
        textInputPerMillion: 2,
        imageInputPerMillion: 2.5,
        imageOutputPerMillion: 8
    }
};

export function isGptImageModel(value: unknown): value is GptImageModel {
    return typeof value === 'string' && value.trim().length > 0;
}

export function getModelRates(model: GptImageModel): ModelRates | null {
    return MODEL_RATES[model] ?? null;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidCostDetails(value: unknown): value is CostDetails {
    if (!value || typeof value !== 'object') return false;
    const details = value as Partial<CostDetails>;
    return (
        isNonNegativeFiniteNumber(details.estimated_cost_usd) &&
        isNonNegativeSafeInteger(details.text_input_tokens) &&
        isNonNegativeSafeInteger(details.image_input_tokens) &&
        isNonNegativeSafeInteger(details.image_output_tokens)
    );
}

/**
 * 根据 token 用量估算 GPT 图片模型 API 调用成本。
 * @param usage OpenAI API 响应中的 usage 对象。
 * @param model 使用的模型。
 * @returns CostDetails 对象；usage 数据无效时返回 null。
 */
export function calculateApiCost(
    usage: ApiUsage | undefined | null,
    model: GptImageModel = 'gpt-image-2'
): CostDetails | null {
    if (!usage || !usage.input_tokens_details || usage.output_tokens === undefined || usage.output_tokens === null) {
        console.warn('费用计算缺少有效 usage 数据：', usage);
        return null;
    }

    const textInT = usage.input_tokens_details.text_tokens ?? 0;
    const imgInT = usage.input_tokens_details.image_tokens ?? 0;
    const imgOutT = usage.output_tokens ?? 0;

    // Token 必须是可精确表达的非负整数，避免伪造或溢出用量污染本地估算。
    if (!isNonNegativeSafeInteger(textInT) || !isNonNegativeSafeInteger(imgInT) || !isNonNegativeSafeInteger(imgOutT)) {
        console.error('usage 数据中的 token 值无效：', usage);
        return null;
    }

    const rates = getModelRates(model);
    if (!rates) {
        console.warn(`费用计算没有配置模型 ${model} 的费率，无法生成估算。`);
        return null;
    }

    const costUSD =
        textInT * rates.textInputPerToken + imgInT * rates.imageInputPerToken + imgOutT * rates.imageOutputPerToken;

    if (!isNonNegativeFiniteNumber(costUSD)) {
        console.error('usage 数据计算出的费用无效：', usage);
        return null;
    }

    // 保留 4 位小数。
    const costRounded = Math.round(costUSD * 10000) / 10000;

    if (!isNonNegativeFiniteNumber(costRounded)) {
        console.error('usage 数据四舍五入后的费用无效：', usage);
        return null;
    }

    return {
        estimated_cost_usd: costRounded,
        text_input_tokens: textInT,
        image_input_tokens: imgInT,
        image_output_tokens: imgOutT
    };
}
