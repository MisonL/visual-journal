import { appLogger } from './app-logger';
import type { ChannelRequestMode } from './channel-request-mode';
import type { ChannelCredential } from './channel-router';
import {
    RequestValidationError,
    assertMaskCompatibility,
    readBackground,
    readCount,
    readEditQuality,
    readGenerateQuality,
    readImageFiles,
    readMaskFile,
    readModeration,
    readOutputCompression,
    readOutputFormat,
    readSize,
    MAX_MODEL_NAME_LENGTH,
    type Background,
    type EditQuality,
    type GenerateParams,
    type GenerateQuality,
    type GptImageModel,
    type Moderation,
    type StorageMode,
    type ValidOutputFormat
} from './image-request-utils';
import {
    appendAccessCookie,
    reportServerCredentialFailure,
    resolveRequestActualCostSafely,
    type AccessCookie,
    type ImageBackend,
    type RequestLogContext
} from './image-route-support';
import {
    readRequestedImageDimensions,
    resolveAcceptedImageTaskResponse,
    type AcceptedImageTaskResponseError
} from './image-service';
import type { RequestedImageDimensions } from './image-service';
import { createImageStreamResponse } from './image-stream-service';
import {
    getImageCountRangeCompatibilityForBackend,
    mergeUpstreamHeadersWithFixed,
    type ImageUpstreamProfile,
    type PartialImagesCount,
    type UpstreamRequestHeaders
} from './image-upstream-profile';
import { createImagesApiGenerateStream } from './images-api-stream';
import { buildOpenAIImageRequestOptions } from './openai-image-transport';
import {
    createResponsesImageEditStream,
    createResponsesImageStream,
    editImageWithResponsesBackend,
    generateImageWithResponsesBackend,
    type ResponsesImageGenerateInput
} from './responses-image-backend';
import type OpenAI from 'openai';

type CommonModeInput = {
    formData: FormData;
    openai: OpenAI;
    model: GptImageModel;
    prompt: string;
    streamEnabled: boolean;
    imageBackend: ImageBackend;
    partialImagesCount: PartialImagesCount;
    upstreamProfile: ImageUpstreamProfile;
    upstreamHeaders?: UpstreamRequestHeaders;
    storageMode: StorageMode;
    apiBaseUrl?: string;
    apiKey: string;
    upstreamProxyUrl?: string;
    startedAtMs: number;
    upstreamIdempotencyKey?: string;
    clientRequestId?: string;
    requestLogContext?: RequestLogContext;
    selectedCredential?: ChannelCredential;
    channelRequestMode?: ChannelRequestMode;
    accessCookie?: AccessCookie;
    forceRequest?: boolean;
    abortSignal?: AbortSignal;
    streamFallbackEnabled?: boolean;
    onStreamUnavailable?: (error: unknown, reason: string) => void;
    onStreamingDegraded?: (reason: string) => void;
};

export type ImageModeResult =
    | Response
    | {
          result: OpenAI.Images.ImagesResponse;
          outputFormat: ValidOutputFormat;
          targetDimensions?: RequestedImageDimensions;
      };

type GenerateOptions = {
    n: number;
    size: string;
    quality: GenerateQuality;
    outputFormat: ValidOutputFormat;
    outputCompression?: number;
    background: Background;
    moderation: Moderation;
    forceWeb?: boolean;
    baseParams: GenerateParams;
};

type EditOptions = {
    imageFiles: File[];
    maskFile?: File;
    n: number;
    size: string;
    quality: EditQuality;
    outputFormat: ValidOutputFormat;
    outputCompression?: number;
    moderation: Moderation;
    forceWeb?: boolean;
    baseEditParams: {
        model: GptImageModel;
        prompt: string;
        image: File[];
        n: number;
        size?: OpenAI.Images.ImageEditParams['size'];
        quality?: OpenAI.Images.ImageEditParams['quality'];
        output_format?: OpenAI.Images.ImageEditParams['output_format'];
        output_compression?: number;
        moderation?: Moderation;
        force_web?: boolean;
    };
};

function toResponsesPartialImagesCount(value: PartialImagesCount): 1 | 2 | 3 {
    if (value === 1 || value === 2 || value === 3) return value;
    throw new RequestValidationError('Responses API 图片后端的 partial_images 必须在 1 到 3 之间。', 400);
}

function readImageCountForBackend(input: CommonModeInput, operation: 'generate' | 'edit'): number {
    const compatibility = getImageCountRangeCompatibilityForBackend(
        input.upstreamProfile,
        operation,
        input.imageBackend
    );
    if (!compatibility.compatible) {
        throw new RequestValidationError(compatibility.error.message, 422);
    }
    return readCount(
        input.formData,
        'n',
        compatibility.range.min,
        compatibility.range.min,
        compatibility.range.max,
        compatibility.range
    );
}

function readGenerateOptions(input: CommonModeInput): GenerateOptions {
    const n = readImageCountForBackend(input, 'generate');
    const size = readSize(input.formData, 'size', '1024x1024', input.model, input.upstreamProfile, {
        forceRequest: input.forceRequest === true
    });
    const quality = readGenerateQuality(input.formData);
    const outputFormat = readOutputFormat(input.formData);
    const outputCompression = readOutputCompression(input.formData, outputFormat);
    const background = readBackground(input.formData, input.model, input.upstreamProfile, {
        forceRequest: input.forceRequest === true
    });
    const moderation = readModeration(input.formData);
    const forceWeb = readBooleanAlias(input.formData, 'force_web', 'forceWeb');
    const baseParams: GenerateParams = {
        model: input.model,
        prompt: input.prompt,
        n,
        size: size as OpenAI.Images.ImageGenerateParams['size'],
        quality,
        output_format: outputFormat,
        background,
        moderation
    };

    if (outputCompression !== undefined) {
        baseParams.output_compression = outputCompression;
    }
    if (forceWeb !== undefined) {
        baseParams.force_web = forceWeb;
    }
    return { n, size, quality, outputFormat, outputCompression, background, moderation, forceWeb, baseParams };
}

function readResponsesImageSize(size: string): string {
    return size;
}

function readStringField(formData: FormData, ...fields: string[]): string | undefined {
    for (const field of fields) {
        const value = formData.get(field);
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function readBooleanAlias(formData: FormData, ...fields: string[]): boolean | undefined {
    const value = readStringField(formData, ...fields);
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new RequestValidationError(`${fields[0]} 必须是 true 或 false。`, 400);
}

function assertBackendSpecificFields(formData: FormData, imageBackend: ImageBackend): void {
    const hasThinking = formData.has('thinking');
    const hasPromptOptimization = formData.has('promptOptimization') || formData.has('prompt_optimization');
    const hasForceWeb = formData.has('force_web') || formData.has('forceWeb');
    const fields: Record<string, string> = {};
    if (imageBackend !== 'responses-image-generation') {
        if (hasThinking) fields.thinking = '仅适用于 image_backend=responses-image-generation';
        if (hasPromptOptimization) fields.promptOptimization = '仅适用于 image_backend=responses-image-generation';
    }
    if (imageBackend === 'responses-image-generation' && hasForceWeb) {
        fields.force_web = '仅适用于 image_backend=images-api';
    }
    if (Object.keys(fields).length > 0) {
        throw new RequestValidationError('请求包含与图片后端不兼容的字段。', 422, { fields });
    }
}

function readThinking(formData: FormData): string | undefined {
    const value = readStringField(formData, 'thinking');
    if (!value) return undefined;
    if (!['minimal', 'none', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
        throw new RequestValidationError('thinking 必须是 minimal、none、low、medium、high 或 xhigh。', 400);
    }
    return value;
}

function readResponsesApiModel(formData: FormData): string {
    const requestValue = readStringField(formData, 'responsesModel', 'responses_model', 'gptModel', 'gpt_model');
    const rawValue =
        typeof requestValue === 'string' && requestValue.trim() ? requestValue : process.env.OPENAI_RESPONSES_API_MODEL;
    const model = rawValue?.trim();
    if (!model) {
        throw new RequestValidationError(
            'Responses API 图片后端必须配置 OPENAI_RESPONSES_API_MODEL 或请求字段 responsesModel，作为 /responses 顶层模型。',
            400
        );
    }
    if (model.length > MAX_MODEL_NAME_LENGTH) {
        throw new RequestValidationError(
            'Responses API 顶层模型名称不能超过 ' + MAX_MODEL_NAME_LENGTH + ' 个字符。',
            400
        );
    }
    return model;
}

function readResponsesImageExtensions(
    formData: FormData
): Pick<ResponsesImageGenerateInput, 'promptOptimization' | 'thinking'> {
    const promptOptimization = readBooleanAlias(formData, 'promptOptimization', 'prompt_optimization');
    const thinking = readThinking(formData);
    return {
        ...(promptOptimization !== undefined ? { promptOptimization } : {}),
        ...(thinking ? { thinking } : {})
    };
}

function openAiRequestOptions(input: CommonModeInput): OpenAI.RequestOptions {
    return buildOpenAIImageRequestOptions({
        abortSignal: input.abortSignal,
        idempotencyKey: input.upstreamIdempotencyKey,
        headers: mergeUpstreamHeadersWithFixed(input.upstreamHeaders, {})
    });
}

function onAcceptedImageTask(input: CommonModeInput, modeLabel: string) {
    return (details: AcceptedImageTaskResponseError, attempt: number, delayMs: number) => {
        appLogger.warn(`上游 ${modeLabel} 返回异步图片任务，等待后重试同步结果。`, {
            ...input.requestLogContext,
            idempotencyKey: input.upstreamIdempotencyKey,
            channelId: input.selectedCredential?.channelId,
            requestMode: input.channelRequestMode,
            attempt,
            delayMs,
            taskId: details.taskId,
            hasPollUrl: Boolean(details.pollUrl)
        });
    };
}

async function createResponsesImageResult(input: CommonModeInput, options: GenerateOptions): Promise<ImageModeResult> {
    if (options.n !== 1) {
        throw new RequestValidationError('Responses API 图片后端当前只支持单张生成。', 400);
    }
    appLogger.info('调用 Responses API image_generation 实验后端。', input.requestLogContext);
    return {
        outputFormat: options.outputFormat,
        targetDimensions: readRequestedImageDimensions(options.size),
        result: await generateImageWithResponsesBackend({
            responses: input.openai.responses,
            prompt: input.prompt,
            responsesModel: readResponsesApiModel(input.formData),
            imageModel: input.model,
            size: readResponsesImageSize(options.size),
            quality: options.quality,
            outputFormat: options.outputFormat,
            background: options.background,
            moderation: options.moderation,
            idempotencyKey: input.upstreamIdempotencyKey,
            abortSignal: input.abortSignal,
            ...(options.outputCompression !== undefined ? { outputCompression: options.outputCompression } : {}),
            ...readResponsesImageExtensions(input.formData)
        })
    };
}

async function createResponsesImageResultOnly(
    input: CommonModeInput,
    options: GenerateOptions
): Promise<OpenAI.Images.ImagesResponse> {
    if (options.n !== 1) {
        throw new RequestValidationError('Responses API 图片后端当前只支持单张生成。', 400);
    }
    return generateImageWithResponsesBackend({
        responses: input.openai.responses,
        prompt: input.prompt,
        responsesModel: readResponsesApiModel(input.formData),
        imageModel: input.model,
        size: readResponsesImageSize(options.size),
        quality: options.quality,
        outputFormat: options.outputFormat,
        background: options.background,
        moderation: options.moderation,
        idempotencyKey: input.upstreamIdempotencyKey,
        abortSignal: input.abortSignal,
        ...(options.outputCompression !== undefined ? { outputCompression: options.outputCompression } : {}),
        ...readResponsesImageExtensions(input.formData)
    });
}

async function createResponsesImageStreamResponse(
    input: CommonModeInput,
    options: GenerateOptions
): Promise<ImageModeResult> {
    if (options.n !== 1) {
        throw new RequestValidationError('Responses API 图片后端当前只支持单张生成。', 400);
    }
    const streamInput = {
        responses: input.openai.responses,
        prompt: input.prompt,
        responsesModel: readResponsesApiModel(input.formData),
        imageModel: input.model,
        size: readResponsesImageSize(options.size),
        quality: options.quality,
        outputFormat: options.outputFormat,
        background: options.background,
        moderation: options.moderation,
        idempotencyKey: input.upstreamIdempotencyKey,
        partialImagesCount: toResponsesPartialImagesCount(input.partialImagesCount),
        abortSignal: input.abortSignal,
        ...(options.outputCompression !== undefined ? { outputCompression: options.outputCompression } : {}),
        ...readResponsesImageExtensions(input.formData)
    };
    let stream;
    try {
        stream = await createResponsesImageStream(streamInput);
    } catch (error) {
        if (!input.streamFallbackEnabled) throw error;
        input.onStreamUnavailable?.(error, 'stream_request_failed');
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await createResponsesImageResultOnly(input, options)
        };
    }
    const response = createImageStreamResponse({
        stream,
        modeLabel: '生成',
        outputFormat: options.outputFormat,
        targetDimensions: readRequestedImageDimensions(options.size),
        storageMode: input.storageMode,
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
        upstreamProxyUrl: input.upstreamProxyUrl,
        upstreamHeaders: input.upstreamHeaders,
        model: input.model,
        startedAtMs: input.startedAtMs,
        abortSignal: input.abortSignal,
        clientRequestId: input.clientRequestId,
        requestLogContext: input.requestLogContext,
        resolveActualCost: resolveRequestActualCostSafely,
        onError: (error) => reportServerCredentialFailure(input.selectedCredential, error),
        onStreamUnavailable: input.onStreamUnavailable,
        onStreamingDegraded: input.onStreamingDegraded,
        fallbackOnError: input.streamFallbackEnabled ? () => createResponsesImageResultOnly(input, options) : undefined
    });
    return appendAccessCookie(response, input.accessCookie);
}

async function createImagesGenerateResultOnly(
    input: CommonModeInput,
    options: GenerateOptions
): Promise<OpenAI.Images.ImagesResponse> {
    const params: OpenAI.Images.ImageGenerateParamsNonStreaming = { ...options.baseParams, stream: false };
    appLogger.info('调用 OpenAI generate。', input.requestLogContext);
    appLogger.debug('调用 OpenAI generate，参数：', { ...params, ...input.requestLogContext });
    return resolveAcceptedImageTaskResponse(
        () => input.openai.images.generate(params, openAiRequestOptions(input)).withResponse(),
        { abortSignal: input.abortSignal, onAcceptedTask: onAcceptedImageTask(input, 'generate') }
    );
}

async function createGenerateStreamResponse(
    input: CommonModeInput,
    options: GenerateOptions
): Promise<ImageModeResult> {
    const streamParams = {
        ...options.baseParams,
        stream: true as const,
        partial_images: input.partialImagesCount
    } satisfies OpenAI.Images.ImageGenerateParamsStreaming;
    let stream;
    try {
        stream = await createImagesApiGenerateStream({
            apiBaseUrl: input.apiBaseUrl,
            apiKey: input.apiKey,
            upstreamProxyUrl: input.upstreamProxyUrl,
            upstreamHeaders: input.upstreamHeaders,
            idempotencyKey: input.upstreamIdempotencyKey,
            abortSignal: input.abortSignal,
            params: streamParams
        });
    } catch (error) {
        if (!input.streamFallbackEnabled) throw error;
        input.onStreamUnavailable?.(error, 'stream_request_failed');
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await createImagesGenerateResultOnly(input, options)
        };
    }
    const response = createImageStreamResponse({
        stream,
        modeLabel: '生成',
        outputFormat: options.outputFormat,
        targetDimensions: readRequestedImageDimensions(options.size),
        storageMode: input.storageMode,
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
        upstreamProxyUrl: input.upstreamProxyUrl,
        upstreamHeaders: input.upstreamHeaders,
        model: input.model,
        startedAtMs: input.startedAtMs,
        abortSignal: input.abortSignal,
        clientRequestId: input.clientRequestId,
        requestLogContext: input.requestLogContext,
        resolveActualCost: resolveRequestActualCostSafely,
        onError: (error) => reportServerCredentialFailure(input.selectedCredential, error),
        onStreamUnavailable: input.onStreamUnavailable,
        onStreamingDegraded: input.onStreamingDegraded,
        fallbackOnError: input.streamFallbackEnabled ? () => createImagesGenerateResultOnly(input, options) : undefined
    });
    return appendAccessCookie(response, input.accessCookie);
}

export async function handleGenerateImageMode(input: CommonModeInput): Promise<ImageModeResult> {
    assertBackendSpecificFields(input.formData, input.imageBackend);
    const options = readGenerateOptions(input);
    if (input.imageBackend === 'responses-image-generation') {
        if (input.streamEnabled) {
            return createResponsesImageStreamResponse(input, options);
        }
        return createResponsesImageResult(input, options);
    }
    if (!input.streamEnabled) {
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await createImagesGenerateResultOnly(input, options)
        };
    }
    return createGenerateStreamResponse(input, options);
}

function readEditOptions(input: CommonModeInput): EditOptions {
    const n = readImageCountForBackend(input, 'edit');
    const size = readSize(input.formData, 'size', 'auto', input.model, input.upstreamProfile, {
        forceRequest: input.forceRequest === true
    });
    const quality = readEditQuality(input.formData);
    const outputFormat = readOutputFormat(input.formData);
    const outputCompression = readOutputCompression(input.formData, outputFormat);
    const moderation = readModeration(input.formData);
    const forceWeb = readBooleanAlias(input.formData, 'force_web', 'forceWeb');
    const imageFiles = readImageFiles(input.formData, input.upstreamProfile);
    const maskFile = readMaskFile(input.formData, input.upstreamProfile);
    const baseEditParams: EditOptions['baseEditParams'] = {
        model: input.model,
        prompt: input.prompt,
        image: imageFiles,
        n,
        size: size === 'auto' ? undefined : (size as OpenAI.Images.ImageEditParams['size']),
        quality,
        output_format: outputFormat,
        moderation
    };
    if (outputCompression !== undefined) {
        baseEditParams.output_compression = outputCompression;
    }
    if (forceWeb !== undefined) {
        baseEditParams.force_web = forceWeb;
    }
    return {
        imageFiles,
        ...(maskFile ? { maskFile } : {}),
        n,
        size,
        quality,
        outputFormat,
        moderation,
        ...(outputCompression !== undefined ? { outputCompression } : {}),
        ...(forceWeb !== undefined ? { forceWeb } : {}),
        baseEditParams
    };
}

function logEditParams(input: CommonModeInput, options: EditOptions, params: object) {
    appLogger.debug('调用 OpenAI edit，参数：', {
        ...params,
        image: `[${options.imageFiles.map((file) => file.name).join(', ')}]`,
        mask: options.maskFile ? options.maskFile.name : 'N/A',
        ...input.requestLogContext
    });
}

async function createEditResultOnly(
    input: CommonModeInput,
    options: EditOptions
): Promise<OpenAI.Images.ImagesResponse> {
    const params: OpenAI.Images.ImageEditParamsNonStreaming & {
        output_compression?: number;
        moderation?: Moderation;
        force_web?: boolean;
    } = {
        ...options.baseEditParams,
        stream: false,
        ...(options.maskFile ? { mask: options.maskFile } : {})
    };
    appLogger.info('调用 OpenAI edit。', input.requestLogContext);
    logEditParams(input, options, params);
    return resolveAcceptedImageTaskResponse(
        () => input.openai.images.edit(params, openAiRequestOptions(input)).withResponse(),
        { abortSignal: input.abortSignal, onAcceptedTask: onAcceptedImageTask(input, 'edit') }
    );
}

async function createEditStreamResponse(input: CommonModeInput, options: EditOptions): Promise<ImageModeResult> {
    appLogger.info('调用 OpenAI edit 流式接口。', input.requestLogContext);
    appLogger.debug('调用 OpenAI edit 流式接口，参数：', {
        ...options.baseEditParams,
        stream: true,
        partial_images: input.partialImagesCount,
        image: `[${options.imageFiles.map((file) => file.name).join(', ')}]`,
        mask: options.maskFile ? options.maskFile.name : 'N/A',
        ...input.requestLogContext
    });
    const streamEditParams = {
        ...options.baseEditParams,
        stream: true as const,
        partial_images: input.partialImagesCount,
        ...(options.maskFile ? { mask: options.maskFile } : {})
    };
    let stream;
    try {
        stream = await input.openai.images.edit(streamEditParams, openAiRequestOptions(input));
    } catch (error) {
        if (!input.streamFallbackEnabled) throw error;
        input.onStreamUnavailable?.(error, 'stream_request_failed');
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await createEditResultOnly(input, options)
        };
    }
    const response = createImageStreamResponse({
        stream,
        modeLabel: '编辑',
        outputFormat: options.outputFormat,
        targetDimensions: readRequestedImageDimensions(options.size),
        storageMode: input.storageMode,
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
        upstreamProxyUrl: input.upstreamProxyUrl,
        upstreamHeaders: input.upstreamHeaders,
        model: input.model,
        startedAtMs: input.startedAtMs,
        abortSignal: input.abortSignal,
        clientRequestId: input.clientRequestId,
        requestLogContext: input.requestLogContext,
        resolveActualCost: resolveRequestActualCostSafely,
        onError: (error) => reportServerCredentialFailure(input.selectedCredential, error),
        onStreamUnavailable: input.onStreamUnavailable,
        onStreamingDegraded: input.onStreamingDegraded,
        fallbackOnError: input.streamFallbackEnabled ? () => createEditResultOnly(input, options) : undefined
    });
    return appendAccessCookie(response, input.accessCookie);
}

export async function handleEditImageMode(input: CommonModeInput): Promise<ImageModeResult> {
    assertBackendSpecificFields(input.formData, input.imageBackend);
    const options = readEditOptions(input);
    await assertMaskCompatibility(options.maskFile, options.imageFiles);
    if (input.imageBackend === 'responses-image-generation') {
        if (options.n !== 1) {
            throw new RequestValidationError('Responses API 图片后端当前只支持单张编辑。', 400);
        }
        const responseInput = {
            responses: input.openai.responses,
            prompt: input.prompt,
            responsesModel: readResponsesApiModel(input.formData),
            imageModel: input.model,
            imageFiles: options.imageFiles,
            ...(options.maskFile ? { maskFile: options.maskFile } : {}),
            size: readResponsesImageSize(options.size),
            quality: options.quality || 'auto',
            outputFormat: options.outputFormat,
            background: 'auto' as const,
            moderation: options.moderation,
            idempotencyKey: input.upstreamIdempotencyKey,
            abortSignal: input.abortSignal,
            ...(options.outputCompression !== undefined ? { outputCompression: options.outputCompression } : {}),
            ...readResponsesImageExtensions(input.formData)
        };
        if (input.streamEnabled) {
            let stream;
            try {
                stream = await createResponsesImageEditStream({
                    ...responseInput,
                    partialImagesCount: toResponsesPartialImagesCount(input.partialImagesCount)
                });
            } catch (error) {
                if (!input.streamFallbackEnabled) throw error;
                reportServerCredentialFailure(input.selectedCredential, error);
                input.onStreamUnavailable?.(error, 'stream_request_failed');
                return {
                    outputFormat: options.outputFormat,
                    targetDimensions: readRequestedImageDimensions(options.size),
                    result: await editImageWithResponsesBackend(responseInput)
                };
            }
            const response = createImageStreamResponse({
                stream,
                modeLabel: '编辑',
                outputFormat: options.outputFormat,
                targetDimensions: readRequestedImageDimensions(options.size),
                storageMode: input.storageMode,
                apiBaseUrl: input.apiBaseUrl,
                apiKey: input.apiKey,
                upstreamProxyUrl: input.upstreamProxyUrl,
                upstreamHeaders: input.upstreamHeaders,
                model: input.model,
                startedAtMs: input.startedAtMs,
                abortSignal: input.abortSignal,
                clientRequestId: input.clientRequestId,
                requestLogContext: input.requestLogContext,
                resolveActualCost: resolveRequestActualCostSafely,
                onError: (error) => reportServerCredentialFailure(input.selectedCredential, error),
                onStreamUnavailable: input.onStreamUnavailable,
                onStreamingDegraded: input.onStreamingDegraded,
                fallbackOnError: input.streamFallbackEnabled
                    ? () => editImageWithResponsesBackend(responseInput)
                    : undefined
            });
            return appendAccessCookie(response, input.accessCookie);
        }
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await editImageWithResponsesBackend(responseInput)
        };
    }
    if (!input.streamEnabled) {
        return {
            outputFormat: options.outputFormat,
            targetDimensions: readRequestedImageDimensions(options.size),
            result: await createEditResultOnly(input, options)
        };
    }
    return createEditStreamResponse(input, options);
}
