import {
    type AgentGenerateRequest,
    type AgentImageResponse,
    type AgentImageResponseExecution,
    type AgentImageResponseItem,
    type AgentResponseMode,
    validateAgentGenerateRequest
} from './agent-api-contracts';
import { AGENT_ENDPOINTS } from './agent-api-paths.mjs';
import {
    buildAgentChannelRequestModeDecision,
    createAgentChannelRequestModePlan,
    selectAgentChannelCredential,
    type AgentChannelRequestModePlan
} from './agent-channel-request-mode';
import { assertArtifactFilepathAllowed, deleteArtifactFileIfAllowed } from './agent-file-utils';
import {
    artifactRecordToResponseItem,
    computeRetryAfterSeconds,
    createArtifactId,
    hashAgentPayload,
    hashText,
    isoDate,
    type AgentArtifactRecord,
    type AgentRequestRecord,
    type BeginAgentRequestResult,
    type AgentStateStore
} from './agent-state-store';
import {
    AgentApiError,
    normalizeAgentError,
    storedAgentErrorResponse,
    type AgentErrorBody
} from './api-error-response';
import type { AgentErrorDiagnostics } from './api-error-response';
import { appLogger } from './app-logger';
import type { ChannelCapacityLease } from './channel-capacity-queue';
import {
    getEffectiveChannelRequestModes,
    isStreamingChannelRequestMode,
    type ChannelRequestMode,
    type ChannelRequestModeDecision
} from './channel-request-mode';
import {
    type ChannelCredential,
    type ChannelFailureReport,
    isChannelCredentialRequestModeHealthy,
    isModelUnavailableForAllCredentials,
    resolveEffectiveCredential
} from './channel-router';
import { isGptImage2Model } from './cost-utils';
import {
    RequestValidationError,
    assertMaskCompatibility,
    assertImageFilesPresent,
    readCount,
    readEditQuality,
    readImageFiles,
    readMaskFile,
    readModel,
    MAX_MODEL_NAME_LENGTH,
    readPlainHttpApiBaseUrlAllowlist,
    readRequiredText,
    readSize,
    validateApiBaseUrl,
    type GptImageModel,
    type ValidOutputFormat
} from './image-request-utils';
import { reportServerCredentialFailure } from './image-route-support';
import {
    ImageDimensionMismatchError,
    InvalidOpenAiImagesResponseError,
    MissingOpenAiImageDataError,
    readAcceptedImageTaskDetails,
    readRequestedImageDimensions,
    resolveAcceptedImageTaskResponse,
    type AcceptedImageTaskResponseError,
    persistOpenAiImages as persistSharedOpenAiImages
} from './image-service';
import { collectOpenAiImagesFromStream } from './image-stream-collector';
import {
    clampIntegerToRange,
    getImageBackendCompatibility,
    getImageCountRangeCompatibilityForBackend,
    isIntegerWithinRange,
    readImageUpstreamProfile,
    mergeUpstreamHeadersWithFixed,
    summarizeUpstreamRequestHeaders,
    type ImageUpstreamProfile,
    type PartialImagesCount,
    type UpstreamRequestHeaders
} from './image-upstream-profile';
import {
    parseImageStreamModeValue,
    parseImageStreamingStrategyValue,
    resolveImageStreamEnabled,
    type ImageStreamMode,
    type ImageStreamingStrategy
} from './image-upstream-strategy';
import { createImagesApiGenerateStream } from './images-api-stream';
import { buildOpenAIImageRequestOptions, createOpenAIImageClientOptions } from './openai-image-transport';
import {
    createResponsesImageStream,
    generateImageWithResponsesBackend,
    type ResponsesImageGenerateInput
} from './responses-image-backend';
import { getServerChannelState } from './server-channel-router';
import { readBooleanEnv } from './server-runtime';
import type { StreamingAvailabilityKey } from './streaming-availability';
import crypto from 'crypto';
import fs from 'fs/promises';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export type AgentRequestExecutionResult = {
    response: AgentImageResponse;
    stateResponse: AgentImageResponse;
    artifacts: AgentArtifactRecord[];
};

type CredentialContext = {
    openai: OpenAI;
    selectedCredential?: ChannelCredential;
    channelRequestMode?: ChannelRequestMode;
    channelRequestModeFallbackApplied: boolean;
    channelRequestModeDecision: ChannelRequestModeDecision;
    baseUrl?: string;
    apiKey: string;
    upstreamProxyUrl?: string;
    upstreamProfile: ImageUpstreamProfile;
    upstreamHeaders?: UpstreamRequestHeaders;
};

export type AgentGeneratePreparation = {
    credentialContext: CredentialContext;
};

export type AgentEditPreparation = {
    credentialContext: CredentialContext;
    prompt: string;
    model: GptImageModel;
    n: number;
    size: OpenAI.Images.ImageEditParams['size'];
    quality: OpenAI.Images.ImageEditParams['quality'];
    responseMode: AgentResponseMode;
    streamRequest: AgentEditStreamRequest;
    imageFiles: File[];
    maskFile?: File;
};

type AgentStreamOptions = {
    mode: 'generate' | 'edit';
    imageBackend: AgentGenerateRequest['image_backend'];
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    partialImages: PartialImagesCount;
    selectedCredential?: ChannelCredential;
    channelRequestMode?: ChannelRequestMode;
};

type AgentEditStreamRequest = {
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    partialImages: PartialImagesCount;
};

type AgentExecutionTransportContext = Pick<AgentImageResponseExecution, 'transport' | 'endpoint' | 'route_mode'>;

type AgentExecutionMetadata = {
    startedAtMs: number;
    startedAt: string;
    transport: AgentExecutionTransportContext;
    operation: AgentImageResponseExecution['operation'];
    imageBackend: AgentImageResponseExecution['image_backend'];
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
    channelRequestMode?: ChannelRequestMode;
    channelRequestModeFallbackApplied: boolean;
    channelRequestModeDecision: ChannelRequestModeDecision;
    selectedCredential?: ChannelCredential;
};

const AGENT_EDIT_UNSUPPORTED_FIELDS = [
    'image_backend',
    'imageBackend',
    'output_format',
    'outputFormat',
    'format',
    'output_compression',
    'outputCompression',
    'responses_model',
    'responsesModel',
    'image_streaming_strategy',
    'imageStreamingStrategy',
    'background',
    'moderation',
    'thinking',
    'promptOptimization',
    'prompt_optimization',
    'force_web',
    'forceWeb'
] as const;
const AGENT_EDIT_OUTPUT_FORMAT = 'webp' satisfies ValidOutputFormat;

const HTTP_HEADER_VALUE_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

type ExistingAgentRequestResult = Exclude<BeginAgentRequestResult, { type: 'acquired' }>;

export function readIdempotencyKey(headers: Headers): string {
    const value = headers.get('idempotency-key')?.trim();
    if (!value) {
        throw new AgentApiError({
            code: 'idempotency_key_required',
            message: 'Agent 图片请求必须提供 Idempotency-Key header。',
            status: 400,
            retryable: false
        });
    }
    if (value.length > 200) {
        throw new AgentApiError({
            code: 'validation_error',
            message: 'Idempotency-Key is too long.',
            status: 422,
            retryable: false,
            details: { fields: { 'Idempotency-Key': '长度不能超过 200 个字符' } }
        });
    }
    if (HTTP_HEADER_VALUE_CONTROL_CHAR_PATTERN.test(value)) {
        throw new AgentApiError({
            code: 'validation_error',
            message: 'Idempotency-Key 不能包含控制字符。',
            status: 422,
            retryable: false,
            details: { fields: { 'Idempotency-Key': '不能包含控制字符' } }
        });
    }
    return value;
}

export function buildGenerateRequestHash(request: AgentGenerateRequest): string {
    return hashAgentPayload({ mode: 'generate', request });
}

export function resolveExistingAgentRequest(
    record: AgentRequestRecord | undefined,
    requestHash: string,
    now = new Date()
): ExistingAgentRequestResult | undefined {
    if (!record) return undefined;
    if (record.requestHash !== requestHash) return { type: 'conflict', record };
    if (record.status === 'succeeded' && record.responseJson) {
        return { type: 'replay', record, response: record.responseJson };
    }
    if (record.status === 'failed' && record.errorJson) {
        return { type: 'failed', record, error: record.errorJson };
    }
    const isActive = record.status === 'running' || record.status === 'pending';
    if (isActive && record.lockedUntil && record.lockedUntil > isoDate(now)) {
        return { type: 'in_progress', record, retryAfterSeconds: computeRetryAfterSeconds(record.lockedUntil, now) };
    }
    return undefined;
}

export function agentBeginResultResponse(
    beginResult: ExistingAgentRequestResult,
    store: AgentStateStore
): Promise<NextResponse>;
export function agentBeginResultResponse(
    beginResult: BeginAgentRequestResult | undefined,
    store: AgentStateStore
): Promise<NextResponse | undefined>;
export async function agentBeginResultResponse(
    beginResult: BeginAgentRequestResult | undefined,
    store: AgentStateStore
): Promise<NextResponse | undefined> {
    if (!beginResult) return undefined;
    if (beginResult.type === 'acquired') return undefined;
    if (beginResult.type === 'replay') {
        const response = await hydrateAgentReplayResponse(store, beginResult.record, beginResult.response);
        return NextResponse.json(response, {
            headers: { 'X-Idempotent-Replay': 'true', 'X-Request-Id': beginResult.record.requestId }
        });
    }
    if (beginResult.type === 'failed') {
        return storedAgentErrorResponse(beginResult.error, {
            'X-Idempotent-Replay': 'true',
            'X-Request-Id': beginResult.record.requestId
        });
    }
    if (beginResult.type === 'conflict') {
        throw new AgentApiError({
            code: 'idempotency_conflict',
            message: 'Idempotency-Key 已被不同请求正文使用。',
            status: 409,
            retryable: false
        });
    }
    throw new AgentApiError({
        code: 'request_in_progress',
        message: '使用该 Idempotency-Key 的请求仍在运行。',
        status: 409,
        retryable: true,
        retryAfterSeconds: beginResult.retryAfterSeconds
    });
}

export function prepareAgentGenerate(request: AgentGenerateRequest, headers: Headers): AgentGeneratePreparation {
    const preValidationError = validateAgentGenerateAgainstAvailableCredentials(request);
    if (preValidationError) throw preValidationError;
    const credentialContext = createOpenAiClient(
        headers,
        resolveAgentGenerateChannelRequestModePlan(request),
        request.model,
        (credential, requestMode) => isAgentGenerateCredentialEligible(request, credential, requestMode)
    );
    validateAgentGenerateAgainstUpstreamProfile(request, credentialContext.upstreamProfile, {
        forceRequest: request.force_request === true,
        requestMode: credentialContext.channelRequestMode
    });
    return { credentialContext };
}

function validateAgentGenerateAgainstAvailableCredentials(
    request: AgentGenerateRequest
): RequestValidationError | undefined {
    const state = getServerChannelState();
    let hasModelAndModeCandidate = false;
    let firstValidationError: RequestValidationError | undefined;
    const requestModes = createAgentChannelRequestModePlan({
        imageBackend: request.image_backend,
        streamMode: request.stream_mode,
        streamingStrategy: request.streaming_strategy
    }).candidates;
    for (const credential of state.config.credentials) {
        if (credential.models?.length && !credential.models.includes(request.model)) continue;
        for (const requestMode of requestModes) {
            if (!getEffectiveChannelRequestModes(credential).includes(requestMode)) continue;
            if (!isChannelCredentialRequestModeHealthy(state.router, credential, requestMode)) continue;
            hasModelAndModeCandidate = true;
            const profile =
                credential.providerProfile ||
                readImageUpstreamProfile({
                    explicitProfile: credential.upstreamProfile,
                    channelId: credential.channelId,
                    baseUrl: credential.baseUrl
                });
            try {
                validateAgentGenerateAgainstUpstreamProfile(request, profile, {
                    forceRequest: request.force_request === true,
                    requestMode
                });
                return undefined;
            } catch (error) {
                if (error instanceof RequestValidationError) firstValidationError ??= error;
                else throw error;
            }
        }
    }
    return hasModelAndModeCandidate ? firstValidationError : undefined;
}

function resolveAgentGenerateChannelRequestModePlan(request: AgentGenerateRequest): AgentChannelRequestModePlan {
    return createAgentChannelRequestModePlan({
        imageBackend: request.image_backend,
        streamMode: request.stream_mode,
        streamingStrategy: request.streaming_strategy
    });
}

function resolveAgentEditChannelRequestModePlan(formData: FormData): AgentChannelRequestModePlan {
    return createAgentChannelRequestModePlan({
        imageBackend: 'images-api',
        streamMode: readAgentEditStreamMode(formData),
        streamingStrategy: readAgentEditStreamingStrategy(formData)
    });
}

export async function prepareAgentEdit(formData: FormData, headers: Headers): Promise<AgentEditPreparation> {
    const prompt = readRequiredText(formData, 'prompt');
    const model = readModel(formData);
    const forceRequest = readAgentEditForceRequest(formData);
    const requestedImageCount = readOptionalPositiveCount(formData, 'n');
    const requestedPartialImages = readAgentEditPartialImages(formData);
    const streamMode = readAgentEditStreamMode(formData);
    const streamingStrategy = readAgentEditStreamingStrategy(formData);
    const requestModePlan = resolveAgentEditChannelRequestModePlan(formData);
    assertImageFilesPresent(formData);
    validateAgentEditInputAgainstConfiguredProfiles({
        formData,
        model,
        forceRequest,
        requestedImageCount,
        requestModes: requestModePlan.candidates,
        streamingStrategy
    });
    validateAgentEditPartialImagesAgainstConfiguredChannels({
        formData,
        model,
        forceRequest,
        requestedImageCount,
        requestedPartialImages,
        requestModes: requestModePlan.candidates,
        streamMode,
        streamingStrategy
    });
    const credentialContext = createOpenAiClient(headers, requestModePlan, model, (credential, requestMode) =>
        isAgentEditCredentialEligible(
            {
                formData,
                model,
                forceRequest,
                requestedImageCount,
                requestedPartialImages,
                streamMode,
                streamingStrategy
            },
            credential,
            requestMode
        )
    );
    const editCountCompatibility = getImageCountRangeCompatibilityForBackend(
        credentialContext.upstreamProfile,
        'edit',
        'images-api'
    );
    if (!editCountCompatibility.compatible) {
        throw new RequestValidationError(editCountCompatibility.error.message, 422);
    }
    const editCountRange = editCountCompatibility.range;
    const n = readCount(formData, 'n', editCountRange.min, editCountRange.min, editCountRange.max, editCountRange);
    const size = readSize(formData, 'size', 'auto', model, credentialContext.upstreamProfile, {
        forceRequest
    }) as OpenAI.Images.ImageEditParams['size'];
    const quality = readEditQuality(formData) as OpenAI.Images.ImageEditParams['quality'];
    const responseMode = readAgentResponseModeFromForm(formData);
    const streamRequest = readAgentEditStreamRequest(
        formData,
        credentialContext.upstreamProfile,
        credentialContext.channelRequestMode
    );
    const imageFiles = readImageFiles(formData, credentialContext.upstreamProfile);
    const maskFile = readMaskFile(formData, credentialContext.upstreamProfile);
    await assertMaskCompatibility(maskFile, imageFiles);
    return { credentialContext, prompt, model, n, size, quality, responseMode, streamRequest, imageFiles, maskFile };
}

function readAgentEditForceRequest(formData: FormData): boolean {
    const value = formData.get('force_request') ?? formData.get('forceRequest');
    if (value === null || value === '') return false;
    if (typeof value !== 'string') {
        throw new RequestValidationError('force_request 必须是 true 或 false。');
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new RequestValidationError('force_request 必须是 true 或 false。');
}

function buildOpenAiRequestOptions(
    context: CredentialContext,
    input: { abortSignal?: AbortSignal; idempotencyKey: string }
): OpenAI.RequestOptions {
    return buildOpenAIImageRequestOptions({
        abortSignal: input.abortSignal,
        idempotencyKey: input.idempotencyKey,
        headers: mergeUpstreamHeadersWithFixed(context.upstreamHeaders, {})
    });
}

function onAgentAcceptedImageTask(context: CredentialContext, modeLabel: string, idempotencyKey: string) {
    return (details: AcceptedImageTaskResponseError, attempt: number, delayMs: number) => {
        appLogger.warn(`Agent ${modeLabel} 上游返回异步图片任务，等待后重试同步结果。`, {
            idempotencyKey,
            channelId: context.selectedCredential?.channelId,
            requestMode: context.channelRequestMode,
            attempt,
            delayMs,
            taskId: details.taskId,
            hasPollUrl: Boolean(details.pollUrl)
        });
    };
}

async function acquireAgentChannelCapacity(
    context: CredentialContext,
    abortSignal?: AbortSignal
): Promise<ChannelCapacityLease | undefined> {
    if (!context.selectedCredential) return undefined;
    const lease = await getServerChannelState().channelCapacityQueue.acquire(context.selectedCredential.id, {
        signal: abortSignal
    });
    appLogger.info('Agent 渠道凭证并发容量已获取。', {
        channelId: context.selectedCredential.channelId,
        credentialId: context.selectedCredential.id,
        queued: lease.queued,
        waitMs: lease.waitMs,
        queueCapacity: lease.capacity,
        queuedCount: lease.queuedCount
    });
    return lease;
}

export async function buildEditRequestHash(formData: FormData): Promise<string> {
    return buildEditRequestHashFromSnapshot(await snapshotAgentEditFormData(formData));
}

export function buildEditRequestHashFromSnapshot(snapshot: Record<string, unknown>): string {
    return hashAgentPayload(snapshot);
}

export async function snapshotAgentEditFormData(formData: FormData): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {};
    const fileFields: Array<Promise<{ key: string; name: string; size: number; type: string; sha256: string }>> = [];
    for (const [key, value] of formData.entries()) {
        if (value instanceof File) {
            fileFields.push(snapshotFileField(key, value));
        } else {
            fields[key] = value;
        }
    }
    const files = await Promise.all(fileFields);
    return { mode: 'edit', fields, files: files.sort((a, b) => a.key.localeCompare(b.key)) };
}

async function snapshotFileField(
    key: string,
    file: File
): Promise<{ key: string; name: string; size: number; type: string; sha256: string }> {
    const buffer = Buffer.from(await file.arrayBuffer());
    return {
        key,
        name: file.name,
        size: file.size,
        type: file.type,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
}

export async function executeAgentGenerate(options: {
    request: AgentGenerateRequest;
    headers: Headers;
    requestId: string;
    idempotencyKey: string;
    cached: boolean;
    preparation?: AgentGeneratePreparation;
    transport?: AgentExecutionTransportContext;
    abortSignal?: AbortSignal;
}): Promise<AgentRequestExecutionResult> {
    const credentialContext =
        options.preparation?.credentialContext ??
        prepareAgentGenerate(options.request, options.headers).credentialContext;
    const startedAtMs = Date.now();
    const startedAt = isoDate(new Date(startedAtMs));
    let channelLease: ChannelCapacityLease | undefined;
    try {
        channelLease = await acquireAgentChannelCapacity(credentialContext, options.abortSignal);
        const result = await executeAgentGenerateUpstream(
            options.request,
            credentialContext,
            options.idempotencyKey,
            options.abortSignal
        );
        channelLease?.release();
        channelLease = undefined;
        return await persistOpenAiImages({
            result,
            mode: 'generate',
            model: options.request.model,
            prompt: options.request.prompt,
            outputFormat: options.request.output_format,
            targetDimensions: readRequestedImageDimensions(options.request.size),
            responseMode: options.request.response_mode,
            normalizeOutputFormat: true,
            requestId: options.requestId,
            idempotencyKey: options.idempotencyKey,
            cached: options.cached,
            apiBaseUrl: credentialContext.baseUrl,
            apiKey: credentialContext.apiKey,
            upstreamProxyUrl: credentialContext.upstreamProxyUrl,
            upstreamHeaders: credentialContext.upstreamHeaders,
            execution: {
                startedAtMs,
                startedAt,
                transport: options.transport ?? {
                    transport: 'agent_json',
                    endpoint: AGENT_ENDPOINTS.generate,
                    route_mode: 'agent'
                },
                operation: 'generate',
                imageBackend: options.request.image_backend,
                streamMode: options.request.stream_mode,
                streamingStrategy: options.request.streaming_strategy,
                channelRequestMode: credentialContext.channelRequestMode,
                channelRequestModeFallbackApplied: credentialContext.channelRequestModeFallbackApplied,
                channelRequestModeDecision: credentialContext.channelRequestModeDecision,
                selectedCredential: credentialContext.selectedCredential
            },
            abortSignal: options.abortSignal
        });
    } catch (error) {
        const failureReport = reportServerCredentialFailure(
            credentialContext.selectedCredential,
            error,
            credentialContext.channelRequestMode,
            options.request.model
        );
        throw normalizeAgentError(error, buildAgentExecutionDiagnostics(credentialContext, startedAtMs, failureReport));
    } finally {
        channelLease?.release();
    }
}

async function executeAgentGenerateUpstream(
    request: AgentGenerateRequest,
    credentialContext: CredentialContext,
    idempotencyKey: string,
    abortSignal?: AbortSignal
): Promise<OpenAI.Images.ImagesResponse> {
    const { openai } = credentialContext;
    const streamOptions: AgentStreamOptions = {
        mode: 'generate',
        imageBackend: request.image_backend,
        streamMode: request.stream_mode,
        streamingStrategy: request.streaming_strategy,
        partialImages: request.partial_images,
        selectedCredential: credentialContext.selectedCredential,
        channelRequestMode: credentialContext.channelRequestMode
    };
    if (request.image_backend === 'responses-image-generation') {
        return executeAgentResponsesGenerate(request, credentialContext, idempotencyKey, abortSignal);
    }
    const baseParams = {
        model: request.model,
        prompt: request.prompt,
        n: request.n,
        size: request.size as OpenAI.Images.ImageGenerateParams['size'],
        quality: request.quality as OpenAI.Images.ImageGenerateParams['quality'],
        output_format: request.output_format,
        background: request.background as OpenAI.Images.ImageGenerateParams['background'],
        moderation: request.moderation as OpenAI.Images.ImageGenerateParams['moderation'],
        ...(request.output_compression !== undefined ? { output_compression: request.output_compression } : {}),
        ...(request.force_web !== undefined ? { force_web: request.force_web } : {})
    };
    if (!shouldUseAgentUpstreamStream(streamOptions)) {
        return resolveAcceptedImageTaskResponse(
            () =>
                openai.images
                    .generate(
                        { ...baseParams, stream: false },
                        buildOpenAiRequestOptions(credentialContext, { abortSignal, idempotencyKey })
                    )
                    .withResponse(),
            { abortSignal, onAcceptedTask: onAgentAcceptedImageTask(credentialContext, 'generate', idempotencyKey) }
        );
    }
    const fallback = () =>
        resolveAcceptedImageTaskResponse(
            () =>
                openai.images
                    .generate(
                        { ...baseParams, stream: false },
                        buildOpenAiRequestOptions(credentialContext, { abortSignal, idempotencyKey })
                    )
                    .withResponse(),
            { abortSignal, onAcceptedTask: onAgentAcceptedImageTask(credentialContext, 'generate', idempotencyKey) }
        );
    try {
        const stream = await createImagesApiGenerateStream({
            apiBaseUrl: credentialContext.baseUrl,
            apiKey: credentialContext.apiKey,
            upstreamProxyUrl: credentialContext.upstreamProxyUrl,
            upstreamHeaders: credentialContext.upstreamHeaders,
            idempotencyKey,
            abortSignal,
            params: {
                ...baseParams,
                stream: true,
                partial_images: request.partial_images
            }
        });
        return await collectOpenAiImagesFromStream(stream, {
            apiBaseUrl: credentialContext.baseUrl,
            apiKey: credentialContext.apiKey,
            upstreamProxyUrl: credentialContext.upstreamProxyUrl,
            upstreamHeaders: credentialContext.upstreamHeaders,
            abortSignal,
            onStreamingDegraded: (reason) => markAgentStreamingUnavailable(streamOptions, reason, 200)
        });
    } catch (error) {
        if (request.stream_mode === 'stream' || isAbortLikeError(error, abortSignal)) throw error;
        markAgentStreamingUnavailable(streamOptions, 'stream_error_without_final_image', undefined, error);
        return fallback();
    }
}

function validateAgentGenerateAgainstUpstreamProfile(
    request: AgentGenerateRequest,
    upstreamProfile: ImageUpstreamProfile,
    options: { forceRequest?: boolean; requestMode?: ChannelRequestMode } = {}
): void {
    const nonStreamResponses = isNonStreamResponsesRequest(request, options.requestMode);
    const compatibility = getImageBackendCompatibility(upstreamProfile, 'generate', request.image_backend, undefined, {
        validatePartialImages: !nonStreamResponses
    });
    if (!compatibility.compatible) {
        throw new RequestValidationError(compatibility.errors.map((error) => error.message).join(' '), 422);
    }
    const imageCountRange = compatibility.imageCountRange;
    const partialImagesRange = compatibility.partialImagesRange;
    if (!imageCountRange) {
        throw new RequestValidationError('当前图片后端没有可用的图片数量约束。', 422);
    }
    if (!isIntegerWithinRange(request.n, imageCountRange)) {
        throw new RequestValidationError(`n 必须在 ${imageCountRange.min} 到 ${imageCountRange.max} 之间。`, 422);
    }
    if (!nonStreamResponses) {
        if (!partialImagesRange) {
            throw new RequestValidationError('当前图片后端没有可用的 partial_images 约束。', 422);
        }
        if (!isIntegerWithinRange(request.partial_images, partialImagesRange)) {
            throw new RequestValidationError(
                `partial_images 必须在 ${partialImagesRange.min} 到 ${partialImagesRange.max} 之间。`,
                422
            );
        }
    }
    if (options.forceRequest) return;
    if (
        isGptImage2Model(request.model) &&
        request.background === 'transparent' &&
        !upstreamProfile.gptImage2.allowTransparentBackground
    ) {
        throw new RequestValidationError('gpt-image-2 不支持 transparent 背景。', 422);
    }
    if (!isGptImage2Model(request.model) || request.size === 'auto') return;
    const formData = new FormData();
    formData.set('size', request.size);
    readSize(formData, 'size', '1024x1024', request.model, upstreamProfile);
}

function isNonStreamResponsesRequest(request: AgentGenerateRequest, requestMode?: ChannelRequestMode): boolean {
    if (requestMode) return !isStreamingChannelRequestMode(requestMode);
    if (request.stream_mode === 'non_stream') return true;
    return (
        request.stream_mode === 'auto' &&
        (request.streaming_strategy === 'auto' || request.streaming_strategy === 'off')
    );
}

function isAgentGenerateCredentialEligible(
    request: AgentGenerateRequest,
    credential: ChannelCredential,
    requestMode?: ChannelRequestMode
): boolean {
    if (credential.models !== undefined && credential.models.length > 0 && !credential.models.includes(request.model)) {
        return false;
    }
    const serverChannelState = getServerChannelState();
    if (requestMode && !isChannelCredentialRequestModeHealthy(serverChannelState.router, credential, requestMode)) {
        return false;
    }
    if (
        requestMode &&
        isStreamingChannelRequestMode(requestMode) &&
        serverChannelState.streamingAvailability.isUnavailable({
            channelId: credential.channelId,
            imageBackend: request.image_backend,
            streamingStrategy: request.streaming_strategy,
            operation: 'generate'
        })
    ) {
        return false;
    }
    const nonStreamResponses = isNonStreamResponsesRequest(request, requestMode);
    const upstreamProfile =
        credential.providerProfile ||
        readImageUpstreamProfile({
            explicitProfile: credential.upstreamProfile,
            channelId: credential.channelId,
            baseUrl: credential.baseUrl
        });
    const compatibility = getImageBackendCompatibility(upstreamProfile, 'generate', request.image_backend, undefined, {
        validatePartialImages: !nonStreamResponses
    });
    const imageCountRange = compatibility.imageCountRange;
    if (!compatibility.compatible || !imageCountRange) return false;
    if (!isIntegerWithinRange(request.n, imageCountRange)) return false;
    if (!nonStreamResponses) {
        const partialImagesRange = compatibility.partialImagesRange;
        if (!partialImagesRange || !isIntegerWithinRange(request.partial_images, partialImagesRange)) {
            return false;
        }
    }
    if (request.force_request === true) return true;
    if (
        isGptImage2Model(request.model) &&
        request.background === 'transparent' &&
        !upstreamProfile.gptImage2.allowTransparentBackground
    ) {
        return false;
    }
    if (!isGptImage2Model(request.model) || request.size === 'auto') return true;
    try {
        const formData = new FormData();
        formData.set('size', request.size);
        readSize(formData, 'size', '1024x1024', request.model, upstreamProfile);
        return true;
    } catch (error) {
        if (error instanceof RequestValidationError) return false;
        throw error;
    }
}

function isAgentEditCredentialEligible(
    input: {
        formData: FormData;
        model: GptImageModel;
        forceRequest: boolean;
        requestedImageCount?: number;
        requestedPartialImages?: number;
        streamMode: ImageStreamMode;
        streamingStrategy: ImageStreamingStrategy;
    },
    credential: ChannelCredential,
    requestMode?: ChannelRequestMode
): boolean {
    if (credential.models !== undefined && credential.models.length > 0 && !credential.models.includes(input.model)) {
        return false;
    }
    const serverChannelState = getServerChannelState();
    if (requestMode && !isChannelCredentialRequestModeHealthy(serverChannelState.router, credential, requestMode)) {
        return false;
    }
    if (
        requestMode &&
        isStreamingChannelRequestMode(requestMode) &&
        serverChannelState.streamingAvailability.isUnavailable({
            channelId: credential.channelId,
            imageBackend: 'images-api',
            streamingStrategy: input.streamingStrategy,
            operation: 'edit'
        })
    ) {
        return false;
    }
    const upstreamProfile =
        credential.providerProfile ||
        readImageUpstreamProfile({
            explicitProfile: credential.upstreamProfile,
            channelId: credential.channelId,
            baseUrl: credential.baseUrl
        });
    const validatePartialImages = requestMode
        ? isStreamingChannelRequestMode(requestMode)
        : input.streamMode !== 'non_stream' && !(input.streamMode === 'auto' && input.streamingStrategy === 'off');
    const compatibility = getImageBackendCompatibility(upstreamProfile, 'edit', 'images-api', undefined, {
        validatePartialImages
    });
    const imageCountRange = compatibility.imageCountRange;
    if (!compatibility.compatible || !imageCountRange) return false;
    if (input.requestedImageCount !== undefined && !isIntegerWithinRange(input.requestedImageCount, imageCountRange)) {
        return false;
    }
    if (validatePartialImages) {
        const partialImagesRange = compatibility.partialImagesRange;
        if (
            !partialImagesRange ||
            (input.requestedPartialImages !== undefined &&
                !isIntegerWithinRange(input.requestedPartialImages, partialImagesRange))
        ) {
            return false;
        }
    }
    try {
        readImageFiles(input.formData, upstreamProfile);
        readMaskFile(input.formData, upstreamProfile);
        readSize(input.formData, 'size', 'auto', input.model, upstreamProfile, { forceRequest: input.forceRequest });
        return true;
    } catch (error) {
        if (error instanceof RequestValidationError) return false;
        throw error;
    }
}

function validateAgentEditInputAgainstConfiguredProfiles(input: {
    formData: FormData;
    model: GptImageModel;
    forceRequest: boolean;
    requestedImageCount?: number;
    requestModes: readonly ChannelRequestMode[];
    streamingStrategy: ImageStreamingStrategy;
}): void {
    const serverChannelState = getServerChannelState();
    const candidates =
        serverChannelState.config.credentials.length > 0
            ? serverChannelState.config.credentials.flatMap((credential) => {
                  if (
                      credential.models !== undefined &&
                      credential.models.length > 0 &&
                      !credential.models.includes(input.model)
                  ) {
                      return [];
                  }
                  const requestModes = input.requestModes.filter((requestMode) => {
                      if (!getEffectiveChannelRequestModes(credential).includes(requestMode)) return false;
                      if (!isChannelCredentialRequestModeHealthy(serverChannelState.router, credential, requestMode)) {
                          return false;
                      }
                      return !(
                          isStreamingChannelRequestMode(requestMode) &&
                          serverChannelState.streamingAvailability.isUnavailable({
                              channelId: credential.channelId,
                              imageBackend: 'images-api',
                              streamingStrategy: input.streamingStrategy,
                              operation: 'edit'
                          })
                      );
                  });
                  if (requestModes.length === 0) {
                      return [];
                  }
                  const profile =
                      credential.providerProfile ||
                      readImageUpstreamProfile({
                          explicitProfile: credential.upstreamProfile,
                          channelId: credential.channelId,
                          baseUrl: credential.baseUrl
                      });
                  return [profile];
              })
            : [readImageUpstreamProfile()];
    if (candidates.length === 0) return;
    let firstValidationError: RequestValidationError | undefined;
    for (const profile of candidates) {
        try {
            const countCompatibility = getImageCountRangeCompatibilityForBackend(profile, 'edit', 'images-api');
            if (!countCompatibility.compatible) {
                throw new RequestValidationError(countCompatibility.error.message, 422);
            }
            const count = input.requestedImageCount;
            if (count !== undefined && !isIntegerWithinRange(count, countCompatibility.range)) {
                throw new RequestValidationError(
                    countCompatibility.range.allowedValues
                        ? `n 必须是以下值之一：${countCompatibility.range.allowedValues.join(', ')}。`
                        : `n 必须在 ${countCompatibility.range.min} 到 ${countCompatibility.range.max} 之间。`,
                    422
                );
            }
            readSize(input.formData, 'size', 'auto', input.model, profile, { forceRequest: input.forceRequest });
            readImageFiles(input.formData, profile);
            readMaskFile(input.formData, profile);
            return;
        } catch (error) {
            if (!(error instanceof RequestValidationError)) throw error;
            firstValidationError ??= error;
        }
    }
    if (firstValidationError) throw firstValidationError;
}

function validateAgentEditPartialImagesAgainstConfiguredChannels(input: {
    formData: FormData;
    model: GptImageModel;
    forceRequest: boolean;
    requestedImageCount?: number;
    requestedPartialImages?: number;
    requestModes: readonly ChannelRequestMode[];
    streamMode: ImageStreamMode;
    streamingStrategy: ImageStreamingStrategy;
}): void {
    if (input.requestedPartialImages === undefined) return;
    const state = getServerChannelState();
    if (new Set(state.config.credentials.map((credential) => credential.channelId)).size <= 1) return;

    let hasEligibleNonStreamCandidate = false;
    let hasEligibleStreamingCandidate = false;
    let firstRangeError: RequestValidationError | undefined;
    for (const credential of state.config.credentials) {
        const requestModes = input.requestModes.filter((requestMode) =>
            getEffectiveChannelRequestModes(credential).includes(requestMode)
        );
        for (const requestMode of requestModes) {
            const eligibleWithoutPartialImages = isAgentEditCredentialEligible(
                {
                    formData: input.formData,
                    model: input.model,
                    forceRequest: input.forceRequest,
                    requestedImageCount: input.requestedImageCount,
                    requestedPartialImages: undefined,
                    streamMode: input.streamMode,
                    streamingStrategy: input.streamingStrategy
                },
                credential,
                requestMode
            );
            if (!eligibleWithoutPartialImages) continue;
            if (!isStreamingChannelRequestMode(requestMode)) {
                hasEligibleNonStreamCandidate = true;
                continue;
            }
            hasEligibleStreamingCandidate = true;
            const profile =
                credential.providerProfile ||
                readImageUpstreamProfile({
                    explicitProfile: credential.upstreamProfile,
                    channelId: credential.channelId,
                    baseUrl: credential.baseUrl
                });
            const compatibility = getImageBackendCompatibility(profile, 'edit', 'images-api', undefined, {
                validatePartialImages: true
            });
            const partialImagesRange = compatibility.partialImagesRange;
            if (partialImagesRange && isIntegerWithinRange(input.requestedPartialImages, partialImagesRange)) return;
            if (partialImagesRange) {
                const message = partialImagesRange.allowedValues
                    ? `partial_images 必须是以下值之一：${partialImagesRange.allowedValues.join(', ')}。`
                    : `partial_images 必须在 ${partialImagesRange.min} 到 ${partialImagesRange.max} 之间。`;
                firstRangeError ??= new RequestValidationError(message, 422, { fields: { partial_images: message } });
            }
        }
    }
    if (hasEligibleNonStreamCandidate || !hasEligibleStreamingCandidate) return;
    if (firstRangeError) throw firstRangeError;
}

async function executeAgentResponsesGenerate(
    request: AgentGenerateRequest,
    credentialContext: CredentialContext,
    idempotencyKey: string,
    abortSignal?: AbortSignal
): Promise<OpenAI.Images.ImagesResponse> {
    const { openai } = credentialContext;
    if (!readBooleanEnv(process.env, 'ENABLE_RESPONSES_IMAGE_BACKEND')) {
        throw new RequestValidationError(
            'Responses API 图片后端仍是实验能力，必须设置 ENABLE_RESPONSES_IMAGE_BACKEND=true 后才能使用。',
            400
        );
    }
    if (request.n !== 1) {
        throw new RequestValidationError('Responses API 图片后端当前只支持单张生成。', 400);
    }
    const input: ResponsesImageGenerateInput = {
        responses: openai.responses,
        prompt: request.prompt,
        responsesModel: readAgentResponsesApiModel(request.responsesModel),
        imageModel: request.model,
        size: readAgentResponsesImageSize(request.size),
        quality: request.quality,
        outputFormat: request.output_format,
        background: request.background,
        moderation: request.moderation,
        idempotencyKey,
        abortSignal,
        ...(request.output_compression !== undefined ? { outputCompression: request.output_compression } : {}),
        ...(request.promptOptimization !== undefined ? { promptOptimization: request.promptOptimization } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {})
    };
    const streamOptions: AgentStreamOptions = {
        mode: 'generate',
        imageBackend: request.image_backend,
        streamMode: request.stream_mode,
        streamingStrategy: request.streaming_strategy,
        partialImages: request.partial_images,
        selectedCredential: credentialContext.selectedCredential,
        channelRequestMode: credentialContext.channelRequestMode
    };
    if (!shouldUseAgentUpstreamStream(streamOptions)) {
        return generateImageWithResponsesBackend(input);
    }
    const responsesPartialImages = readAgentResponsesPartialImagesCount(request.partial_images);
    try {
        return await collectOpenAiImagesFromStream(
            await createResponsesImageStream({ ...input, partialImagesCount: responsesPartialImages }),
            {
                apiBaseUrl: credentialContext.baseUrl,
                apiKey: credentialContext.apiKey,
                upstreamProxyUrl: credentialContext.upstreamProxyUrl,
                upstreamHeaders: credentialContext.upstreamHeaders,
                abortSignal,
                onStreamingDegraded: (reason) => markAgentStreamingUnavailable(streamOptions, reason, 200)
            }
        );
    } catch (error) {
        if (request.stream_mode === 'stream' || isAbortLikeError(error, abortSignal)) throw error;
        markAgentStreamingUnavailable(streamOptions, 'stream_error_without_final_image', undefined, error);
        return generateImageWithResponsesBackend(input);
    }
}

function readAgentResponsesPartialImagesCount(value: PartialImagesCount): 1 | 2 | 3 {
    if (value === 1 || value === 2 || value === 3) return value;
    throw new RequestValidationError('Responses API 图片后端的 partial_images 必须在 1 到 3 之间。', 400);
}

function shouldUseAgentUpstreamStream(input: AgentStreamOptions): boolean {
    const key = createAgentStreamingAvailabilityKey(input);
    const availability = getServerChannelState().streamingAvailability;
    if (input.streamMode === 'non_stream') return false;
    if (input.channelRequestMode && !isStreamingChannelRequestMode(input.channelRequestMode)) return false;
    if (input.streamMode === 'auto' && availability.isUnavailable(key)) return false;
    return resolveImageStreamEnabled({
        imageBackend: input.imageBackend,
        requestedStream: true,
        streamingStrategy: input.streamingStrategy
    });
}

function createAgentStreamingAvailabilityKey(input: AgentStreamOptions): StreamingAvailabilityKey {
    return {
        channelId: input.selectedCredential?.channelId,
        imageBackend: input.imageBackend,
        streamingStrategy: input.streamingStrategy,
        operation: input.mode
    };
}

function readErrorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    if ('status' in error && typeof error.status === 'number') return error.status;
    if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
    return undefined;
}

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    if ('code' in error && typeof error.code === 'string') return error.code;
    return undefined;
}

function markAgentStreamingUnavailable(
    input: AgentStreamOptions,
    reason: string,
    status?: number,
    error?: unknown
): void {
    const finalStatus = status ?? readErrorStatus(error);
    getServerChannelState().streamingAvailability.markUnavailable({
        ...createAgentStreamingAvailabilityKey(input),
        reason,
        ...(finalStatus !== undefined ? { status: finalStatus } : {}),
        ...(readErrorCode(error) ? { code: readErrorCode(error) } : {})
    });
}

function isAbortLikeError(error: unknown, abortSignal?: AbortSignal): boolean {
    if (abortSignal?.aborted) return true;
    if (typeof error !== 'object' || error === null) return false;
    const name = 'name' in error ? error.name : undefined;
    return name === 'AbortError' || name === 'CanceledError';
}

function readAgentResponsesApiModel(requestModel?: string): string {
    const model = requestModel?.trim() || process.env.OPENAI_RESPONSES_API_MODEL?.trim();
    if (!model) {
        throw new RequestValidationError(
            'Responses API 图片后端必须配置 OPENAI_RESPONSES_API_MODEL 或请求字段 responsesModel，作为 /responses 顶层模型。',
            500
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

function readAgentResponsesImageSize(size: string): ResponsesImageGenerateInput['size'] {
    return size;
}

export async function executeAgentEdit(options: {
    formData: FormData;
    headers: Headers;
    requestId: string;
    idempotencyKey: string;
    cached: boolean;
    preparation?: AgentEditPreparation;
    transport?: AgentExecutionTransportContext;
    abortSignal?: AbortSignal;
}): Promise<AgentRequestExecutionResult> {
    let credentialContext: CredentialContext | undefined;
    const startedAtMs = Date.now();
    const startedAt = isoDate(new Date(startedAtMs));
    let channelLease: ChannelCapacityLease | undefined;
    let failureModel: string | undefined;
    try {
        const preparation = options.preparation ?? (await prepareAgentEdit(options.formData, options.headers));
        credentialContext = preparation.credentialContext;
        failureModel = preparation.model;
        // Keep a const alias so TypeScript preserves the narrowed credential context below.
        const activeCredentialContext = credentialContext;
        const editParams: OpenAI.Images.ImageEditParamsNonStreaming = {
            model: preparation.model,
            prompt: preparation.prompt,
            image: preparation.imageFiles,
            n: preparation.n,
            size: preparation.size === 'auto' ? undefined : preparation.size,
            quality: preparation.quality === 'auto' ? undefined : preparation.quality,
            ...(preparation.maskFile ? { mask: preparation.maskFile } : {})
        };
        const streamOptions: AgentStreamOptions = {
            mode: 'edit',
            imageBackend: 'images-api',
            streamMode: preparation.streamRequest.streamMode,
            streamingStrategy: preparation.streamRequest.streamingStrategy,
            partialImages: preparation.streamRequest.partialImages,
            selectedCredential: activeCredentialContext.selectedCredential,
            channelRequestMode: activeCredentialContext.channelRequestMode
        };
        channelLease = await acquireAgentChannelCapacity(activeCredentialContext, options.abortSignal);
        const result = shouldUseAgentUpstreamStream(streamOptions)
            ? await executeAgentEditStream({
                  credentialContext: activeCredentialContext,
                  params: editParams,
                  streamOptions,
                  idempotencyKey: options.idempotencyKey,
                  abortSignal: options.abortSignal
              })
            : await resolveAcceptedImageTaskResponse(
                  () =>
                      activeCredentialContext.openai.images
                          .edit(
                              editParams,
                              buildOpenAiRequestOptions(activeCredentialContext, {
                                  abortSignal: options.abortSignal,
                                  idempotencyKey: options.idempotencyKey
                              })
                          )
                          .withResponse(),
                  {
                      abortSignal: options.abortSignal,
                      onAcceptedTask: onAgentAcceptedImageTask(activeCredentialContext, 'edit', options.idempotencyKey)
                  }
              );
        channelLease?.release();
        channelLease = undefined;

        return await persistOpenAiImages({
            result,
            mode: 'edit',
            model: preparation.model,
            prompt: preparation.prompt,
            outputFormat: AGENT_EDIT_OUTPUT_FORMAT,
            targetDimensions: readRequestedImageDimensions(preparation.size),
            responseMode: preparation.responseMode,
            normalizeOutputFormat: true,
            requestId: options.requestId,
            idempotencyKey: options.idempotencyKey,
            cached: options.cached,
            apiBaseUrl: activeCredentialContext.baseUrl,
            apiKey: activeCredentialContext.apiKey,
            upstreamProxyUrl: activeCredentialContext.upstreamProxyUrl,
            upstreamHeaders: activeCredentialContext.upstreamHeaders,
            execution: {
                startedAtMs,
                startedAt,
                transport: options.transport ?? {
                    transport: 'agent_json',
                    endpoint: AGENT_ENDPOINTS.edit,
                    route_mode: 'agent'
                },
                operation: 'edit',
                imageBackend: 'images-api',
                streamMode: preparation.streamRequest.streamMode,
                streamingStrategy: preparation.streamRequest.streamingStrategy,
                channelRequestMode: activeCredentialContext.channelRequestMode,
                channelRequestModeFallbackApplied: activeCredentialContext.channelRequestModeFallbackApplied,
                channelRequestModeDecision: activeCredentialContext.channelRequestModeDecision,
                selectedCredential: activeCredentialContext.selectedCredential
            },
            abortSignal: options.abortSignal
        });
    } catch (error) {
        const failureReport = reportServerCredentialFailure(
            credentialContext?.selectedCredential,
            error,
            credentialContext?.channelRequestMode,
            failureModel
        );
        throw normalizeAgentError(error, buildAgentExecutionDiagnostics(credentialContext, startedAtMs, failureReport));
    } finally {
        channelLease?.release();
    }
}

async function executeAgentEditStream(input: {
    credentialContext: CredentialContext;
    params: OpenAI.Images.ImageEditParamsNonStreaming;
    streamOptions: AgentStreamOptions;
    idempotencyKey: string;
    abortSignal?: AbortSignal;
}): Promise<OpenAI.Images.ImagesResponse> {
    const requestOptions = buildOpenAiRequestOptions(input.credentialContext, {
        abortSignal: input.abortSignal,
        idempotencyKey: input.idempotencyKey
    });
    const fallback = () =>
        resolveAcceptedImageTaskResponse(
            () => input.credentialContext.openai.images.edit(input.params, requestOptions).withResponse(),
            {
                abortSignal: input.abortSignal,
                onAcceptedTask: onAgentAcceptedImageTask(input.credentialContext, 'edit', input.idempotencyKey)
            }
        );
    try {
        const stream = await input.credentialContext.openai.images.edit(
            {
                ...input.params,
                stream: true,
                partial_images: input.streamOptions.partialImages
            },
            requestOptions
        );
        return await collectOpenAiImagesFromStream(stream, {
            apiBaseUrl: input.credentialContext.baseUrl,
            apiKey: input.credentialContext.apiKey,
            upstreamProxyUrl: input.credentialContext.upstreamProxyUrl,
            upstreamHeaders: input.credentialContext.upstreamHeaders,
            abortSignal: input.abortSignal,
            onStreamingDegraded: (reason) => markAgentStreamingUnavailable(input.streamOptions, reason, 200)
        });
    } catch (error) {
        if (input.streamOptions.streamMode === 'stream' || isAbortLikeError(error, input.abortSignal)) throw error;
        markAgentStreamingUnavailable(input.streamOptions, 'stream_error_without_final_image', undefined, error);
        return fallback();
    }
}

export async function parseAgentGenerateRequest(request: Request): Promise<AgentGenerateRequest> {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new RequestValidationError('Agent 生成端点要求使用 application/json。', 415);
    }
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new RequestValidationError('请求正文必须是有效 JSON。', 422);
    }
    return validateAgentGenerateRequest(body);
}

export async function parseAgentEditFormData(request: Request): Promise<FormData> {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
        throw new RequestValidationError('Agent 编辑端点要求使用 multipart/form-data。', 415);
    }
    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        throw new RequestValidationError('请求正文必须是有效的 multipart/form-data。', 422);
    }
    validateAgentEditUnsupportedFields(formData);
    return formData;
}

function validateAgentEditUnsupportedFields(formData: FormData): void {
    const fields: Record<string, string> = {};
    for (const field of AGENT_EDIT_UNSUPPORTED_FIELDS) {
        if (formData.has(field)) {
            fields[field] =
                field === 'image_streaming_strategy' || field === 'imageStreamingStrategy'
                    ? 'Agent edit 不接受页面专用字段，请使用 streaming_strategy。'
                    : 'Agent edit 不接受该字段。';
        }
    }
    if (Object.keys(fields).length > 0) {
        throw new RequestValidationError('Agent edit 请求包含不支持的字段。', 422, { fields });
    }
}

export async function deleteAgentArtifactFiles(store: AgentStateStore, id: string): Promise<boolean> {
    const artifact = await store.getArtifact(id);
    if (!artifact) return false;
    await deleteArtifactFileIfAllowed(artifact.filepath);
    await store.deleteArtifact(id);
    await store.failRequest({
        requestId: artifact.requestId,
        error: {
            error: {
                code: 'artifact_not_found',
                message: '产物已删除。',
                retryable: false,
                request_id: artifact.requestId
            }
        }
    });
    return true;
}

export async function deleteAgentExecutionFiles(execution: AgentRequestExecutionResult): Promise<void> {
    const results = await Promise.allSettled(
        execution.artifacts.map((artifact) => deleteArtifactFileIfAllowed(artifact.filepath))
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
        throw failed.reason;
    }
}

export async function saveAgentExecutionArtifacts(
    store: AgentStateStore,
    execution: AgentRequestExecutionResult
): Promise<void> {
    await store.saveArtifacts(execution.artifacts);
}

export async function completeAgentExecutionState(
    store: AgentStateStore,
    execution: AgentRequestExecutionResult
): Promise<void> {
    await store.completeRequest({
        requestId: execution.response.request_id,
        response: execution.stateResponse,
        artifacts: []
    });
}

export function createArtifactPersistenceError(): AgentApiError {
    return new AgentApiError({
        code: 'unexpected_error',
        message: '保存产物元数据失败。',
        status: 500,
        retryable: true
    });
}

export function createCompletionPersistenceError(): AgentApiError {
    return new AgentApiError({
        code: 'unexpected_error',
        message: '保存请求完成状态失败。',
        status: 500,
        retryable: true
    });
}

export function errorToAgentErrorBody(error: unknown, requestId: string): AgentErrorBody {
    const normalized = normalizeAgentError(error);
    return {
        error: {
            code: normalized.code,
            message: normalized.message,
            retryable: normalized.retryable,
            ...(normalized.retryable && normalized.retryAfterSeconds
                ? { retry_after_seconds: normalized.retryAfterSeconds }
                : {}),
            ...(normalized.details ? { details: normalized.details } : {}),
            ...(normalized.upstreamStatus ? { upstream_status: normalized.upstreamStatus } : {}),
            ...(normalized.diagnostics ? { diagnostics: normalized.diagnostics } : {}),
            request_id: requestId
        }
    };
}

export async function hydrateAgentReplayResponse(
    store: AgentStateStore,
    record: { requestId: string; requestJson: unknown },
    response: AgentImageResponse,
    cached = true
): Promise<AgentImageResponse> {
    const responseMode = readAgentResponseModeFromRequestJson(record.requestJson);
    if (!shouldIncludeBase64(responseMode)) {
        return { ...response, cached };
    }
    const artifacts = await store.listArtifactsForRequest(record.requestId);
    const encodedById = new Map<string, string>();
    for (const artifact of artifacts) {
        assertArtifactFilepathAllowed(artifact.filepath);
        encodedById.set(artifact.id, await readArtifactBase64(artifact.filepath));
    }
    return {
        ...response,
        cached,
        images: response.images.map((image) => ({
            ...image,
            ...(encodedById.has(image.id) ? { b64_json: encodedById.get(image.id) } : {})
        }))
    };
}

function createOpenAiClient(
    headers: Headers,
    requestModePlan: AgentChannelRequestModePlan,
    model: string,
    isCredentialEligible?: (credential: ChannelCredential, requestMode?: ChannelRequestMode) => boolean
): CredentialContext {
    const serverChannelState = getServerChannelState();
    const serverChannelRouter = serverChannelState.router;
    if (isModelUnavailableForAllCredentials(serverChannelState.config.credentials, model)) {
        throw new AgentApiError({
            code: 'channel_unavailable',
            message: `当前没有支持模型 ${model} 的健康渠道凭证。请调整 OPENAI_CHANNEL_N_MODELS。`,
            status: 503,
            retryable: false
        });
    }
    const hasMultipleServerChannels =
        new Set(serverChannelState.config.credentials.map((credential) => credential.channelId)).size > 1;
    const selectionEligibility = hasMultipleServerChannels
        ? isCredentialEligible
        : (credential: ChannelCredential) =>
              credential.models?.length !== undefined && credential.models.length > 0
                  ? credential.models.includes(model)
                  : true;
    const selection = selectAgentChannelCredential({
        router: serverChannelRouter,
        headers,
        requestModePlan,
        isCredentialEligible: selectionEligibility
    });
    const selectedCredential = selection.selectedCredential;
    const {
        apiKey,
        baseUrl,
        upstreamProxyUrl,
        providerProfile,
        selectedCredential: effectiveSelectedCredential
    } = resolveEffectiveCredential({
        requestApiKey: '',
        requestApiBaseUrl: '',
        legacyBaseUrl: process.env.OPENAI_API_BASE_URL,
        legacyUpstreamProxyUrl: process.env.OPENAI_UPSTREAM_PROXY_URL,
        selectedCredential
    });
    validateApiBaseUrl(baseUrl || '', {
        allowedPlainHttpBaseUrls: readPlainHttpApiBaseUrlAllowlist(process.env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS)
    });
    const channelRequestModeDecision = buildAgentChannelRequestModeDecision({
        requestModePlan,
        selection,
        selectedCredential: effectiveSelectedCredential,
        upstreamHost: baseUrl ? readUrlHost(baseUrl) : undefined
    });
    if (!apiKey) {
        throw new AgentApiError({
            code: 'configuration_error',
            message: '未配置服务端 API Key。请设置 OPENAI_API_KEY 或 OPENAI_CHANNEL_N_API_KEYS。',
            status: 500,
            retryable: false,
            diagnostics: {
                route_decision: channelRequestModeDecision
            }
        });
    }
    return {
        openai: new OpenAI(
            createOpenAIImageClientOptions({
                apiKey,
                baseURL: baseUrl || undefined,
                upstreamProxyUrl,
                allowedPlainHttpBaseUrls: readPlainHttpApiBaseUrlAllowlist(
                    process.env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS
                ),
                defaultHeaders: mergeUpstreamHeadersWithFixed(effectiveSelectedCredential?.upstreamHeaders, {})
            })
        ),
        selectedCredential: effectiveSelectedCredential,
        channelRequestMode: selection.requestMode,
        channelRequestModeFallbackApplied: selection.fallbackApplied,
        channelRequestModeDecision,
        baseUrl,
        apiKey,
        upstreamProxyUrl,
        upstreamProfile:
            providerProfile ||
            readImageUpstreamProfile({
                explicitProfile: effectiveSelectedCredential?.upstreamProfile,
                channelId: effectiveSelectedCredential?.channelId,
                baseUrl
            }),
        upstreamHeaders: effectiveSelectedCredential?.upstreamHeaders
    };
}

function buildAgentExecutionDiagnostics(
    context: CredentialContext | undefined,
    startedAtMs: number,
    failureReport?: ChannelFailureReport
): AgentErrorDiagnostics {
    const upstreamHost = context?.baseUrl ? readUrlHost(context.baseUrl) : undefined;
    return {
        elapsed_ms: Date.now() - startedAtMs,
        ...(context?.channelRequestMode ? { channel_request_mode: context.channelRequestMode } : {}),
        ...(context ? { channel_request_mode_fallback_applied: context.channelRequestModeFallbackApplied } : {}),
        ...(context?.channelRequestModeDecision ? { route_decision: context.channelRequestModeDecision } : {}),
        ...(context?.selectedCredential?.channelId
            ? { selected_channel_id: context.selectedCredential.channelId }
            : {}),
        ...(upstreamHost ? { upstream_host: upstreamHost } : {}),
        ...(failureReport?.cooldownApplied
            ? {
                  retry_after_ms: failureReport.retryAfterMs,
                  cooldown_until: isoDate(new Date(failureReport.cooldownUntil)),
                  cooldown_target: {
                      channel_id: failureReport.target.channelId,
                      ...(failureReport.target.credentialId
                          ? { credential_id: failureReport.target.credentialId }
                          : {}),
                      ...(failureReport.target.requestMode ? { request_mode: failureReport.target.requestMode } : {})
                  },
                  channel_cooldown_scope: failureReport.scope
              }
            : {})
    };
}

function readUrlHost(value: string): string | undefined {
    try {
        return new URL(value).host;
    } catch {
        return undefined;
    }
}

async function persistOpenAiImages(options: {
    result: OpenAI.Images.ImagesResponse;
    mode: 'generate' | 'edit';
    model: GptImageModel;
    prompt: string;
    outputFormat: ValidOutputFormat;
    targetDimensions?: ReturnType<typeof readRequestedImageDimensions>;
    responseMode: AgentResponseMode;
    normalizeOutputFormat?: boolean;
    requestId: string;
    idempotencyKey: string;
    cached: boolean;
    apiBaseUrl?: string;
    apiKey?: string;
    upstreamProxyUrl?: string;
    upstreamHeaders?: UpstreamRequestHeaders;
    execution: AgentExecutionMetadata;
    abortSignal?: AbortSignal;
}): Promise<AgentRequestExecutionResult> {
    let persistedImages;
    try {
        persistedImages = await persistSharedOpenAiImages({
            result: options.result,
            outputFormat: options.outputFormat,
            storageMode: 'fs',
            includeBase64: shouldIncludeBase64(options.responseMode),
            normalizeOutputFormat: options.normalizeOutputFormat,
            targetDimensions: options.targetDimensions,
            apiBaseUrl: options.apiBaseUrl,
            apiKey: options.apiKey,
            upstreamProxyUrl: options.upstreamProxyUrl,
            upstreamHeaders: options.upstreamHeaders,
            abortSignal: options.abortSignal
        });
    } catch (error) {
        if (error instanceof ImageDimensionMismatchError) {
            throw new AgentApiError({
                code: 'image_dimension_mismatch',
                message: error.message,
                status: error.status,
                retryable: false,
                details: {
                    dimension_check_failed: true,
                    expected_dimensions: `${error.expected.width}x${error.expected.height}`,
                    actual_dimensions:
                        error.actual.width !== null && error.actual.height !== null
                            ? `${error.actual.width}x${error.actual.height}`
                            : null
                }
            });
        }
        if (!(error instanceof InvalidOpenAiImagesResponseError) && !(error instanceof MissingOpenAiImageDataError)) {
            throw error;
        }
        const acceptedTask =
            error instanceof InvalidOpenAiImagesResponseError ? readAcceptedImageTaskDetails(error.result) : undefined;
        throw new AgentApiError({
            code: 'upstream_unavailable',
            message:
                error instanceof MissingOpenAiImageDataError
                    ? `索引 ${error.index} 的图片数据缺少 base64 数据。`
                    : acceptedTask
                      ? '上游返回了异步图片任务元数据，而不是最终图片结果；当前渠道不兼容该请求方式。'
                      : '上游返回了空的 Images 响应。',
            status: 502,
            retryable: !acceptedTask,
            upstreamStatus: 502,
            ...(acceptedTask ? {} : { retryAfterSeconds: 15 })
        });
    }

    const completedAtMs = Date.now();
    const createdAt = isoDate(new Date(completedAtMs));
    const execution = buildAgentImageExecution(options.execution, options.apiBaseUrl, options.upstreamHeaders);
    const timing = {
        started_at: options.execution.startedAt,
        completed_at: createdAt,
        elapsed_ms: Math.max(0, completedAtMs - options.execution.startedAtMs),
        server_elapsed_ms: Math.max(0, completedAtMs - options.execution.startedAtMs)
    };
    const images: AgentImageResponseItem[] = [];
    const stateImages: AgentImageResponseItem[] = [];
    const artifacts: AgentArtifactRecord[] = [];
    const promptHash = hashText(options.prompt);

    for (const persistedImage of persistedImages) {
        const artifactId = createArtifactId();
        const contentUrl = `/api/agent/artifacts/${artifactId}/content`;
        const metadataUrl = `/api/agent/artifacts/${artifactId}`;
        const artifact: AgentArtifactRecord = {
            id: artifactId,
            requestId: options.requestId,
            filename: persistedImage.filename,
            filepath: persistedImage.filepath,
            contentUrl,
            metadataUrl,
            outputFormat: persistedImage.outputFormat,
            mimeType: persistedImage.mimeType,
            sizeBytes: persistedImage.sizeBytes,
            width: persistedImage.width,
            height: persistedImage.height,
            model: options.model,
            promptHash,
            createdAt
        };
        artifacts.push(artifact);
        images.push(artifactRecordToResponseItem(artifact, persistedImage.responseJson));
        stateImages.push(artifactRecordToResponseItem(artifact));
    }

    return {
        artifacts,
        response: {
            request_id: options.requestId,
            idempotency_key: options.idempotencyKey,
            cached: options.cached,
            images,
            usage: options.result.usage,
            created_at: createdAt,
            timing,
            execution
        },
        stateResponse: {
            request_id: options.requestId,
            idempotency_key: options.idempotencyKey,
            cached: options.cached,
            images: stateImages,
            usage: options.result.usage,
            created_at: createdAt,
            timing,
            execution
        }
    };
}

function buildAgentImageExecution(
    metadata: AgentExecutionMetadata,
    apiBaseUrl: string | undefined,
    upstreamHeaders: UpstreamRequestHeaders | undefined
): AgentImageResponseExecution {
    const upstreamHost = apiBaseUrl ? readUrlHost(apiBaseUrl) : undefined;
    return {
        ...metadata.transport,
        operation: metadata.operation,
        image_backend: metadata.imageBackend,
        stream_mode: metadata.streamMode,
        streaming_strategy: metadata.streamingStrategy,
        ...(metadata.channelRequestMode ? { channel_request_mode: metadata.channelRequestMode } : {}),
        channel_request_mode_fallback_applied: metadata.channelRequestModeFallbackApplied,
        route_decision: {
            ...metadata.channelRequestModeDecision,
            ...(upstreamHost ? { upstream_host: upstreamHost } : {})
        },
        ...(metadata.selectedCredential?.channelId
            ? { selected_channel_id: metadata.selectedCredential.channelId }
            : {}),
        ...(upstreamHost ? { upstream_host: upstreamHost } : {}),
        request_headers: summarizeUpstreamRequestHeaders(upstreamHeaders)
    };
}

function shouldIncludeBase64(responseMode: AgentResponseMode): boolean {
    return responseMode === 'base64' || responseMode === 'both';
}

function readAgentResponseModeFromForm(formData: FormData): AgentResponseMode {
    const value = formData.get('response_mode');
    if (value === null) return 'path';
    if (value === 'path' || value === 'base64' || value === 'both') return value;
    throw new RequestValidationError('response_mode 必须是 path、base64 或 both。', 422);
}

function readAgentEditStreamRequest(
    formData: FormData,
    upstreamProfile: ImageUpstreamProfile,
    requestMode?: ChannelRequestMode
): AgentEditStreamRequest {
    const streamMode = readAgentEditStreamMode(formData);
    const streamingStrategy = readAgentEditStreamingStrategy(formData);
    if (streamMode !== 'non_stream') {
        resolveImageStreamEnabled({
            imageBackend: 'images-api',
            requestedStream: true,
            streamingStrategy
        });
    }
    const partialImagesRange = upstreamProfile.partialImages;
    const requestedPartialImages = readAgentEditPartialImages(formData);
    const shouldValidatePartialImages = requestMode
        ? isStreamingChannelRequestMode(requestMode)
        : streamMode !== 'non_stream';
    return {
        streamMode,
        streamingStrategy,
        partialImages: shouldValidatePartialImages
            ? (readCount(
                  formData,
                  'partial_images',
                  clampIntegerToRange(2, partialImagesRange),
                  partialImagesRange.min,
                  partialImagesRange.max,
                  partialImagesRange
              ) as PartialImagesCount)
            : ((requestedPartialImages ?? clampIntegerToRange(2, partialImagesRange)) as PartialImagesCount)
    };
}

function readOptionalPositiveCount(formData: FormData, field: string): number | undefined {
    const value = formData.get(field);
    if (value === null) return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new RequestValidationError(`${field} 必须是整数。`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new RequestValidationError(`${field} 必须是正整数。`);
    }
    return count;
}

function readOptionalInteger(formData: FormData, field: string): number | undefined {
    const value = formData.get(field);
    if (value === null) return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new RequestValidationError(`${field} 必须是整数。`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
        throw new RequestValidationError(`${field} 必须是整数。`);
    }
    return count;
}

function readAgentEditPartialImages(formData: FormData): number | undefined {
    const value = readOptionalInteger(formData, 'partial_images');
    if (value === undefined) return undefined;
    if (value > 4) {
        throw new RequestValidationError('partial_images 必须在 0 到 4 之间。', 422);
    }
    return value;
}

function readAgentEditStreamMode(formData: FormData): ImageStreamMode {
    const value = formData.get('stream_mode');
    if (value === null && formData.get('streaming_strategy') === 'off') return 'non_stream';
    if (value === null) return 'auto';
    if (typeof value !== 'string') {
        throw new RequestValidationError('stream_mode 必须是 auto、stream 或 non_stream。', 422);
    }
    try {
        return parseImageStreamModeValue(value);
    } catch (error) {
        throw new RequestValidationError(error instanceof Error ? error.message : 'stream_mode 无效。', 422);
    }
}

function readAgentEditStreamingStrategy(formData: FormData): ImageStreamingStrategy {
    const value = formData.get('streaming_strategy');
    if (value === null) return 'auto';
    if (typeof value !== 'string') {
        throw new RequestValidationError(
            'streaming_strategy 必须是 off、auto、openai-sse、newapi-keepalive-sse、responses-sse 或 force-sse。',
            422
        );
    }
    try {
        return parseImageStreamingStrategyValue(value);
    } catch (error) {
        throw new RequestValidationError(error instanceof Error ? error.message : 'streaming_strategy 无效。', 422);
    }
}

function readAgentResponseModeFromRequestJson(requestJson: unknown): AgentResponseMode {
    if (typeof requestJson !== 'object' || requestJson === null) return 'path';
    const body = requestJson as Record<string, unknown>;
    const directValue = body.response_mode;
    if (directValue === 'path' || directValue === 'base64' || directValue === 'both') return directValue;
    const fields = body.fields;
    if (typeof fields !== 'object' || fields === null) return 'path';
    const formValue = (fields as Record<string, unknown>).response_mode;
    return formValue === 'path' || formValue === 'base64' || formValue === 'both' ? formValue : 'path';
}

async function readArtifactBase64(filepath: string): Promise<string> {
    const buffer = await fs.readFile(filepath);
    return buffer.toString('base64');
}
