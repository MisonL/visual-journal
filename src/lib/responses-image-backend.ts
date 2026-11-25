import { extractImageBase64FromDataUrl, isRemoteHttpUrl, readResponsesImageResultBase64 } from './image-payload';
import { MAX_RESPONSES_EDIT_INPUT_BYTES } from './image-request-limits';
import { RequestValidationError } from './image-request-utils';
import { asRecord } from './json-record';
import { buildOpenAIImageRequestOptions } from './openai-image-transport';
import type OpenAI from 'openai';

type ImageUsage = OpenAI.Images.ImagesResponse['usage'];
type OpenAiImageData = NonNullable<OpenAI.Images.ImagesResponse['data']>[number];
type ResponsesCreateClient = {
    create(
        params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
        options?: OpenAI.RequestOptions
    ): Promise<{
        output?: unknown[];
        usage?: unknown;
    }>;
    create(
        params: OpenAI.Responses.ResponseCreateParamsStreaming,
        options?: OpenAI.RequestOptions
    ): Promise<AsyncIterable<unknown>>;
};

export type ResponsesImageGenerateInput = {
    responses: ResponsesCreateClient;
    prompt: string;
    responsesModel: string;
    imageModel: string;
    size: string;
    quality: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
    outputFormat: 'png' | 'webp' | 'jpeg';
    background: 'transparent' | 'opaque' | 'auto';
    moderation: 'auto' | 'low';
    outputCompression?: number;
    promptOptimization?: boolean;
    thinking?: string;
    idempotencyKey?: string;
    abortSignal?: AbortSignal;
};

export type ResponsesImageEditInput = ResponsesImageGenerateInput & {
    imageFiles: File[];
    maskFile?: File;
};

export type ResponsesImageStreamInput = ResponsesImageGenerateInput & {
    partialImagesCount: 1 | 2 | 3;
};

export type ResponsesImageEditStreamInput = ResponsesImageEditInput & {
    partialImagesCount: 1 | 2 | 3;
};

class ResponsesImageGenerationError extends Error {
    readonly status = 502;

    constructor(message: string) {
        super(message);
        this.name = 'ResponsesImageGenerationError';
    }
}

function isImageUrlResult(value: string): boolean {
    return isRemoteHttpUrl(value) || value.startsWith('/');
}

function readCompletedImageRecordResult(record: Record<string, unknown>): OpenAiImageData | undefined {
    if (typeof record.result === 'string') {
        const resultBase64 = readResponsesImageResultBase64(record.result);
        if (resultBase64) return { b64_json: resultBase64 };
        const result = record.result.trim();
        if (isImageUrlResult(result)) return { url: result };
    }
    if (typeof record.url === 'string') {
        const url = record.url.trim();
        const urlBase64 = extractImageBase64FromDataUrl(url);
        if (urlBase64) return { b64_json: urlBase64 };
        if (isImageUrlResult(url)) return { url };
    }
    return undefined;
}

function extractCompletedImageResults(output: unknown[] | undefined): OpenAiImageData[] {
    if (!Array.isArray(output)) {
        return [];
    }

    return output.flatMap((item) => {
        const record = asRecord(item);
        if (!record || record.type !== 'image_generation_call') {
            return [];
        }
        if (record.status === 'failed') {
            return [];
        }
        const imageResult = readCompletedImageRecordResult(record);
        return imageResult ? [imageResult] : [];
    });
}

function readResponseImageError(record: Record<string, unknown>): string | undefined {
    const error = asRecord(record.error);
    if (error) {
        if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
        if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
    }
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
    return undefined;
}

function readFailedImageGenerationCallMessage(output: unknown[] | undefined): string | undefined {
    if (!Array.isArray(output)) return undefined;
    for (const item of output) {
        const record = asRecord(item);
        if (!record || record.type !== 'image_generation_call' || record.status !== 'failed') continue;
        return readResponseImageError(record) || '上游未提供错误信息。';
    }
    return undefined;
}

function buildResponsesImageTool(
    input: ResponsesImageGenerateInput,
    partialImagesCount?: 1 | 2 | 3,
    action: 'generate' | 'edit' = 'generate'
): OpenAI.Responses.Tool {
    return {
        type: 'image_generation',
        action,
        model: input.imageModel,
        size: input.size,
        quality: input.quality,
        output_format: input.outputFormat,
        background: input.background,
        moderation: input.moderation,
        ...(input.outputCompression !== undefined ? { output_compression: input.outputCompression } : {}),
        ...(input.promptOptimization !== undefined ? { prompt_optimization: input.promptOptimization } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(partialImagesCount !== undefined ? { partial_images: partialImagesCount } : {})
    } as unknown as OpenAI.Responses.Tool;
}

async function fileToDataUrl(file: File): Promise<string> {
    const buffer = Buffer.from(await file.arrayBuffer());
    return `data:${file.type};base64,${buffer.toString('base64')}`;
}

function assertResponsesEditInputSize(input: ResponsesImageEditInput): void {
    const totalBytes =
        input.imageFiles.reduce((sum, file) => sum + file.size, 0) + (input.maskFile ? input.maskFile.size : 0);
    if (totalBytes > MAX_RESPONSES_EDIT_INPUT_BYTES) {
        throw new RequestValidationError(
            `Responses API 图生图参考图和 mask 总大小不能超过 ${MAX_RESPONSES_EDIT_INPUT_BYTES / 1024 / 1024} MB。`,
            400
        );
    }
}

async function buildResponsesImageEditInput(input: ResponsesImageEditInput): Promise<OpenAI.Responses.ResponseInput> {
    assertResponsesEditInputSize(input);
    const content: OpenAI.Responses.ResponseInputContent[] = [
        {
            type: 'input_text',
            text: input.prompt
        }
    ];
    for (const file of input.imageFiles) {
        content.push({
            type: 'input_image',
            detail: 'auto',
            image_url: await fileToDataUrl(file)
        });
    }
    return [{ role: 'user', content }];
}

async function buildResponsesImageEditTool(
    input: ResponsesImageEditInput,
    partialImagesCount?: 1 | 2 | 3
): Promise<OpenAI.Responses.Tool> {
    const tool = buildResponsesImageTool(input, partialImagesCount, 'edit') as unknown as Record<string, unknown>;
    if (input.maskFile) {
        tool.input_image_mask = { image_url: await fileToDataUrl(input.maskFile) };
    }
    return tool as unknown as OpenAI.Responses.Tool;
}

export async function generateImageWithResponsesBackend(
    input: ResponsesImageGenerateInput
): Promise<OpenAI.Images.ImagesResponse> {
    const response = await input.responses.create(
        {
            model: input.responsesModel,
            input: input.prompt,
            stream: false,
            tool_choice: { type: 'image_generation' },
            tools: [buildResponsesImageTool(input)]
        },
        buildOpenAIImageRequestOptions({ abortSignal: input.abortSignal, idempotencyKey: input.idempotencyKey })
    );
    const imageResults = extractCompletedImageResults(response.output);

    if (imageResults.length === 0) {
        const failedMessage = readFailedImageGenerationCallMessage(response.output);
        if (failedMessage) {
            throw new ResponsesImageGenerationError(`Responses API image_generation_call 失败：${failedMessage}`);
        }
        throw new ResponsesImageGenerationError('Responses API 未返回已完成的 image_generation_call.result 或 url。');
    }

    return {
        created: Math.floor(Date.now() / 1000),
        data: imageResults,
        ...(response.usage ? { usage: response.usage as ImageUsage } : {})
    };
}

export async function editImageWithResponsesBackend(
    input: ResponsesImageEditInput
): Promise<OpenAI.Images.ImagesResponse> {
    const response = await input.responses.create(
        {
            model: input.responsesModel,
            input: await buildResponsesImageEditInput(input),
            stream: false,
            tool_choice: { type: 'image_generation' },
            tools: [await buildResponsesImageEditTool(input)]
        },
        buildOpenAIImageRequestOptions({ abortSignal: input.abortSignal, idempotencyKey: input.idempotencyKey })
    );
    const imageResults = extractCompletedImageResults(response.output);

    if (imageResults.length === 0) {
        const failedMessage = readFailedImageGenerationCallMessage(response.output);
        if (failedMessage) {
            throw new ResponsesImageGenerationError(`Responses API image_generation_call 失败：${failedMessage}`);
        }
        throw new ResponsesImageGenerationError('Responses API 未返回已完成的 image_generation_call.result 或 url。');
    }

    return {
        created: Math.floor(Date.now() / 1000),
        data: imageResults,
        ...(response.usage ? { usage: response.usage as ImageUsage } : {})
    };
}

export async function createResponsesImageStream(input: ResponsesImageStreamInput): Promise<AsyncIterable<unknown>> {
    return input.responses.create(
        {
            model: input.responsesModel,
            input: input.prompt,
            stream: true,
            tool_choice: { type: 'image_generation' },
            tools: [buildResponsesImageTool(input, input.partialImagesCount)]
        },
        buildOpenAIImageRequestOptions({ abortSignal: input.abortSignal, idempotencyKey: input.idempotencyKey })
    );
}

export async function createResponsesImageEditStream(
    input: ResponsesImageEditStreamInput
): Promise<AsyncIterable<unknown>> {
    return input.responses.create(
        {
            model: input.responsesModel,
            input: await buildResponsesImageEditInput(input),
            stream: true,
            tool_choice: { type: 'image_generation' },
            tools: [await buildResponsesImageEditTool(input, input.partialImagesCount)]
        },
        buildOpenAIImageRequestOptions({ abortSignal: input.abortSignal, idempotencyKey: input.idempotencyKey })
    );
}
