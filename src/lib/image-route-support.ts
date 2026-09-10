import { readAcceptedImageTaskDetails } from './accepted-image-task';
import { PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH } from './agent-api-contracts';
import { appLogger } from './app-logger';
import type { ChannelRequestMode } from './channel-request-mode';
import {
    type ChannelCredential,
    type ChannelFailureReport,
    describeChannelFailure,
    isChannelFailure,
    isChannelRequestModeFailure,
    isCredentialFailure
} from './channel-router';
import { readPlainHttpApiBaseUrlAllowlist, RequestValidationError } from './image-request-utils';
import type { ImageGenerationBackend } from './image-upstream-strategy';
import { getServerChannelState } from './server-channel-router';
import { buildAccessCookie, readBooleanEnv, resolveImageOutputDir, serializeAccessCookie } from './server-runtime';
import { resolveActualCost, type ActualCostDetails } from './upstream-cost/resolve';
import fs from 'fs/promises';
import { NextResponse } from 'next/server';

export type AccessCookie = ReturnType<typeof buildAccessCookie>;
export type ImageBackend = ImageGenerationBackend;
export type RequestLogContext = { clientRequestId: string };
export type UpstreamErrorCategory =
    | 'image_task_pending'
    | 'missing_image_call_result'
    | 'html_response'
    | 'connection_error'
    | 'url_only_result'
    | 'partial_no_final'
    | 'responses_disabled'
    | 'unknown_response_format';

export type UpstreamResponseDiagnostics = {
    category: UpstreamErrorCategory;
    structure?: unknown;
    diagnostic_hint?: string;
};

const SENSITIVE_RESPONSE_KEYS = new Set([
    'api_key',
    'api-key',
    'authorization',
    'b64_json',
    'base64',
    'image',
    'image_url',
    'input',
    'mask',
    'prompt',
    'result',
    'signature',
    'token',
    'url'
]);
const MAX_STRUCTURE_DEPTH = 4;
const MAX_STRUCTURE_ARRAY_ITEMS = 5;
const MAX_STRUCTURE_OBJECT_KEYS = 30;

const HTTP_HEADER_VALUE_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export function readClientRequestId(formData: FormData): string | undefined {
    const value = formData.get('clientRequestId');
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized.length > PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH) {
        throw new RequestValidationError(
            `clientRequestId 长度不能超过 ${PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH} 个字符。`
        );
    }
    if (HTTP_HEADER_VALUE_CONTROL_CHAR_PATTERN.test(normalized)) {
        throw new RequestValidationError('clientRequestId 不能包含控制字符。');
    }
    return normalized;
}

export function assertResponsesImageBackendAllowed(input: { imageBackend: ImageBackend; mode: string }) {
    if (input.imageBackend !== 'responses-image-generation') return;
    if (!readBooleanEnv(process.env, 'ENABLE_RESPONSES_IMAGE_BACKEND')) {
        throw new RequestValidationError(
            'Responses API 图片后端仍是实验能力，必须设置 ENABLE_RESPONSES_IMAGE_BACKEND=true 后才能使用。',
            400
        );
    }
    if (input.mode !== 'generate' && input.mode !== 'edit') {
        throw new RequestValidationError('Responses API 图片后端当前只支持 generate 或 edit 模式。', 400);
    }
}

export function reportServerCredentialFailure(
    credential: ChannelCredential | undefined,
    error: unknown,
    requestMode?: ChannelRequestMode,
    model?: string
): ChannelFailureReport | undefined {
    const serverChannelRouter = getServerChannelState().router;
    if (!credential || !serverChannelRouter) return undefined;
    if (isChannelRequestModeFailure(error, requestMode)) {
        const reason = {
            ...describeChannelFailure(error, 'channel'),
            ...(requestMode ? { requestMode } : {}),
            ...(model ? { model } : {})
        };
        const report = serverChannelRouter.reportFailure(credential, { scope: 'channel', requestMode, reason, model });
        appLogger.warn(
            report.cooldownApplied
                ? `暂时冷却 API 渠道请求方式：${credential.channelId}/${requestMode}`
                : `记录 API 渠道请求方式失败，未启用冷却：${credential.channelId}/${requestMode}`,
            reason
        );
        return report;
    }
    if (isChannelFailure(error)) {
        const reason = {
            ...describeChannelFailure(error, 'channel'),
            ...(requestMode ? { requestMode } : {}),
            ...(model ? { model } : {})
        };
        const report = serverChannelRouter.reportFailure(credential, { scope: 'channel', requestMode, reason, model });
        appLogger.warn(
            report.cooldownApplied
                ? `暂时冷却 API 渠道：${credential.channelId}`
                : `记录 API 渠道失败，未启用冷却：${credential.channelId}`,
            reason
        );
        return report;
    }
    if (isCredentialFailure(error)) {
        const reason = {
            ...describeChannelFailure(error, 'credential'),
            ...(requestMode ? { requestMode } : {}),
            ...(model ? { model } : {})
        };
        const report = serverChannelRouter.reportFailure(credential, { requestMode, reason, model });
        appLogger.warn(
            report.cooldownApplied
                ? `暂时冷却 API 渠道凭证：${credential.channelId}/${credential.id}`
                : `记录 API 渠道凭证失败，未启用冷却：${credential.channelId}/${credential.id}`,
            reason
        );
        return report;
    }
    return undefined;
}

export function inspectInvalidImagesResponse(result: unknown): UpstreamResponseDiagnostics {
    if (typeof result === 'string') {
        const normalized = result.trim().toLowerCase();
        if (normalized.includes('<!doctype html') || normalized.includes('<html')) {
            return {
                category: 'html_response',
                structure: {
                    type: 'string',
                    contains_html: true,
                    length: result.length
                },
                diagnostic_hint:
                    '请确认 API URL 填的是兼容接口根地址，通常需要以 /v1 结尾，不要填写管理后台或网页首页地址。'
            };
        }
    }
    const acceptedTask = readAcceptedImageTaskDetails(result);
    if (acceptedTask) {
        return {
            category: 'image_task_pending',
            structure: summarizeUpstreamResponseStructure(result),
            diagnostic_hint:
                '该上游先返回 image.task pending。服务端只会进行同幂等键有界重试，不会直接轮询 poll_url；若重试后仍拿不到最终图片，就不能把该渠道配置为 images-non-stream。'
        };
    }
    const responseDiagnostics = inspectResponsesImageOutput(result);
    if (responseDiagnostics) {
        return responseDiagnostics;
    }
    const structure = summarizeUpstreamResponseStructure(result);
    if (containsRemoteUrlOnlyImageResult(result)) {
        return {
            category: 'url_only_result',
            structure,
            diagnostic_hint:
                '上游返回了远程 URL 形式的图片结果。服务端会在 HTTPS、公共 DNS 地址且未配置代理时安全下载跨域 URL；不满足这些条件时，请让上游返回 b64_json 或同源 artifact URL。'
        };
    }
    return {
        category: 'unknown_response_format',
        structure,
        diagnostic_hint: '请确认 API URL 是 OpenAI 兼容接口，并且该接口支持 Images generate/edit。'
    };
}

export function describeInvalidImagesResponse(result: unknown): string {
    const diagnostics = inspectInvalidImagesResponse(result);
    if (diagnostics.category === 'html_response') {
        return 'API 返回的是 HTML 页面，不是 OpenAI Images JSON 响应。请确认 API URL 填的是兼容接口根地址，通常需要以 /v1 结尾，例如 https://api.openai.com/v1；不要填写管理后台或网页首页地址。';
    }
    if (diagnostics.category === 'image_task_pending') {
        const acceptedTask = readAcceptedImageTaskDetails(result) ?? {};
        const taskSuffix = acceptedTask.taskId ? ` task_id=${acceptedTask.taskId}` : '';
        const pollSuffix = acceptedTask.pollUrl ? ' poll_url=present' : '';
        return `上游返回了异步图片任务${taskSuffix}${pollSuffix}，不是可直接消费的 OpenAI Images 完成结果。如果同一业务幂等键有界重试后仍拿不到最终图片，就不能把该渠道配置为 images-non-stream；poll_url 当前只作为诊断线索，不会被静默轮询。`;
    }
    if (diagnostics.category === 'responses_disabled') {
        return 'Responses API 图片后端不可用：上游返回该分组未启用 image_generation。请从该渠道的 OPENAI_CHANNEL_N_REQUEST_MODES 移除 responses-non-stream 和 responses-sse。';
    }
    if (diagnostics.category === 'missing_image_call_result') {
        return 'Responses API 未返回可消费的 image_generation_call.result 或 url。请检查上游是否只返回文本、pending 或 failed 状态；不要把未返回最终图片的 responses request mode 写入该渠道白名单。';
    }
    if (diagnostics.category === 'url_only_result') {
        return 'API 返回了远程 URL 形式的图片结果。服务端只会安全下载 HTTPS 且解析到公共地址的跨域 URL；配置代理时跨域下载会被拒绝。请让上游返回 b64_json，或返回同源 artifact URL。';
    }
    if (diagnostics.category === 'partial_no_final') {
        return '流式图片响应只返回了 partial image，没有返回最终图片 b64_json。请检查上游 SSE 事件是否包含 completed/final image 事件。';
    }
    return 'API 返回的数据不是 OpenAI Images 格式。请确认 API URL 是 OpenAI 兼容接口，并且该接口支持 Images generate/edit。';
}

export function inspectUpstreamError(error: unknown): UpstreamResponseDiagnostics | undefined {
    if (isUpstreamResponseFormatError(error)) {
        return {
            category: 'html_response',
            diagnostic_hint:
                '上游成功返回了 HTML 页面而不是 JSON 或 SSE。请确认 API URL 填的是兼容接口根地址，通常需要以 /v1 结尾，不要填写管理后台或网页首页地址。'
        };
    }
    if (isConnectionError(error)) {
        return {
            category: 'connection_error',
            diagnostic_hint: '上游网络连接失败。请检查 API URL、DNS、TLS 和服务可达性。'
        };
    }
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    if (!message) return undefined;
    const normalized = message.toLowerCase();
    if (
        normalized.includes('image generation is not enabled for this group') ||
        (normalized.includes('responses') && normalized.includes('403') && normalized.includes('image_generation'))
    ) {
        return {
            category: 'responses_disabled',
            diagnostic_hint:
                '该上游的 /v1/responses 不允许 image_generation。请移除 responses-non-stream/responses-sse，或更换启用了 Responses image_generation 的分组。'
        };
    }
    if (
        normalized.includes('未返回已完成的 image_generation_call.result') ||
        (normalized.includes('missing') && normalized.includes('image_generation_call'))
    ) {
        return {
            category: 'missing_image_call_result',
            diagnostic_hint:
                '建议用 --page-sse --image-backend responses-image-generation --streaming-strategy responses-sse 验证同一上游；若 SSE 可用但非流式失败，请不要把 responses-non-stream 写入该渠道。'
        };
    }
    if (normalized.includes('<!doctype html') || normalized.includes('<html')) {
        return inspectInvalidImagesResponse(message);
    }
    if (normalized.includes('unexpected token') && normalized.includes('<')) {
        return {
            category: 'html_response',
            diagnostic_hint:
                '上游响应无法按 JSON 解析，内容疑似 HTML 页面。请确认 API URL 填的是兼容接口根地址，通常需要以 /v1 结尾。'
        };
    }
    if (normalized.includes('流式图片响应未返回最终图片') || normalized.includes('missing final image')) {
        return {
            category: 'partial_no_final',
            diagnostic_hint:
                '上游 SSE 未给出最终图片。请检查是否只有 partial image 事件，或改用真实通过的非流式请求方式。'
        };
    }
    return undefined;
}

export function summarizeUpstreamResponseStructure(value: unknown, depth = 0): unknown {
    if (value === null) return null;
    if (Array.isArray(value)) {
        if (depth >= MAX_STRUCTURE_DEPTH) return { type: 'array', length: value.length };
        return {
            type: 'array',
            length: value.length,
            items: value
                .slice(0, MAX_STRUCTURE_ARRAY_ITEMS)
                .map((item) => summarizeUpstreamResponseStructure(item, depth + 1))
        };
    }
    if (typeof value !== 'object') {
        return summarizeScalar(value);
    }
    if (depth >= MAX_STRUCTURE_DEPTH) {
        return {
            type: 'object',
            keys: Object.keys(value as Record<string, unknown>)
                .sort()
                .slice(0, MAX_STRUCTURE_OBJECT_KEYS)
        };
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort().slice(0, MAX_STRUCTURE_OBJECT_KEYS)) {
        result[key] = shouldRedactResponseKey(key)
            ? summarizeSensitiveValue(record[key])
            : summarizeUpstreamResponseStructure(record[key], depth + 1);
    }
    return result;
}

function inspectResponsesImageOutput(result: unknown): UpstreamResponseDiagnostics | undefined {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const record = result as Record<string, unknown>;
    const output = Array.isArray(record.output) ? record.output : undefined;
    if (!output) return undefined;
    const imageCalls = output
        .map((item) =>
            item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined
        )
        .filter((item): item is Record<string, unknown> => item?.type === 'image_generation_call');
    if (imageCalls.length === 0) {
        return {
            category: 'missing_image_call_result',
            structure: summarizeUpstreamResponseStructure(result),
            diagnostic_hint:
                'Responses 返回了 output 但没有 image_generation_call，通常表示上游只兼容文本 Responses 而不支持 image_generation。请不要把该 responses request mode 写入渠道白名单。'
        };
    }
    if (imageCalls.some((item) => readStatus(item) === 'failed' && readResponsesDisabledMessage(item))) {
        return {
            category: 'responses_disabled',
            structure: summarizeUpstreamResponseStructure(result),
            diagnostic_hint:
                '该上游的 Responses image_generation 权限不可用。请从该渠道 request modes 移除 responses-non-stream 和 responses-sse。'
        };
    }
    if (imageCalls.some((item) => typeof item.result === 'string' || typeof item.url === 'string')) {
        if (imageCalls.some((item) => containsRemoteUrlOnlyImageResult(item))) {
            return {
                category: 'url_only_result',
                structure: summarizeUpstreamResponseStructure(result),
                diagnostic_hint:
                    'Responses image_generation_call 返回 URL。服务端会在 HTTPS、公共 DNS 地址且未配置代理时安全下载跨域 URL；不满足这些条件时，请让上游改为 base64 或同源 artifact URL。'
            };
        }
        return undefined;
    }
    return {
        category: 'missing_image_call_result',
        structure: summarizeUpstreamResponseStructure(result),
        diagnostic_hint:
            'Responses 返回了 image_generation_call 但没有 completed result。建议分别验证 responses-non-stream 和 responses-sse；未返回最终图片的 mode 不应写入渠道白名单。'
    };
}

function isUpstreamResponseFormatError(error: unknown, seen = new WeakSet<object>()): boolean {
    if (typeof error !== 'object' || error === null) return false;
    if (seen.has(error)) return false;
    seen.add(error);
    if ((error as { code?: unknown }).code === 'upstream_response_format') return true;
    const cause = (error as { cause?: unknown }).cause;
    return cause !== undefined && isUpstreamResponseFormatError(cause, seen);
}

function summarizeScalar(value: unknown): unknown {
    if (typeof value === 'string') {
        return { type: 'string', length: value.length };
    }
    if (typeof value === 'number') return { type: 'number' };
    if (typeof value === 'boolean') return { type: 'boolean', value };
    if (typeof value === 'undefined') return { type: 'undefined' };
    return { type: typeof value };
}

function summarizeSensitiveValue(value: unknown): unknown {
    if (typeof value === 'string') return { type: 'string', length: value.length, redacted: true };
    if (Array.isArray(value)) return { type: 'array', length: value.length, redacted: true };
    if (value && typeof value === 'object') {
        return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort(), redacted: true };
    }
    return summarizeScalar(value);
}

function shouldRedactResponseKey(key: string): boolean {
    const normalized = key.trim().toLowerCase();
    return SENSITIVE_RESPONSE_KEYS.has(normalized) || normalized.includes('secret') || normalized.endsWith('_key');
}

function containsRemoteUrlOnlyImageResult(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => containsRemoteUrlOnlyImageResult(item));
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const candidate =
        typeof record.result === 'string' ? record.result : typeof record.url === 'string' ? record.url : undefined;
    if (candidate?.trim().startsWith('http://') || candidate?.trim().startsWith('https://')) return true;
    return Object.values(record).some((item) => containsRemoteUrlOnlyImageResult(item));
}

function readResponsesDisabledMessage(record: Record<string, unknown>): string | undefined {
    const nested = record.error;
    let message: unknown;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        message = (nested as Record<string, unknown>).message ?? (nested as Record<string, unknown>).code;
    } else {
        message = nested ?? record.message;
    }
    return typeof message === 'string' && message.toLowerCase().includes('image generation is not enabled')
        ? message
        : undefined;
}

function readStatus(record: Record<string, unknown>): string | undefined {
    return typeof record.status === 'string' ? record.status.trim().toLowerCase() : undefined;
}

function isConnectionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const name = typeof record.name === 'string' ? record.name : error instanceof Error ? error.name : undefined;
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
        name === 'APIConnectionError' ||
        name === 'APIConnectionTimeoutError' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        message.includes('connection error') ||
        message.includes('fetch failed')
    );
}

export function appendAccessCookie(response: Response, accessCookie: AccessCookie | undefined): Response {
    if (accessCookie) {
        response.headers.append('Set-Cookie', serializeAccessCookie(accessCookie));
    }
    return response;
}

export function attachAccessCookie<T extends NextResponse>(response: T, accessCookie: AccessCookie | undefined): T {
    if (accessCookie) {
        response.cookies.set(accessCookie.name, accessCookie.value, accessCookie.options);
    }
    return response;
}

export async function ensureOutputDirExists() {
    const outputDir = resolveImageOutputDir();
    try {
        await fs.access(outputDir);
    } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            try {
                await fs.mkdir(outputDir, { recursive: true });
                appLogger.info(`已创建图片输出目录：${outputDir}`);
            } catch (mkdirError) {
                appLogger.error(`创建图片输出目录失败 ${outputDir}：`, mkdirError);
                throw new Error('创建图片输出目录失败。');
            }
            return;
        }
        appLogger.error(`访问图片输出目录失败 ${outputDir}：`, error);
        throw new Error(
            `访问或确认图片输出目录失败。原始错误：${error instanceof Error ? error.message : String(error)}`
        );
    }
}

async function resolveRequestActualCost(input: {
    apiBaseUrl?: string;
    apiKey: string;
    upstreamProxyUrl?: string;
    model: string;
    startedAtMs: number;
    expectedImageCount: number;
}): Promise<ActualCostDetails> {
    const finishedAtMs = Date.now();
    const allowedPlainHttpBaseUrls = readPlainHttpApiBaseUrlAllowlist(
        process.env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS
    );
    if (!input.apiBaseUrl) {
        return resolveActualCost({
            allowedPlainHttpBaseUrls,
            model: input.model,
            startedAtMs: input.startedAtMs,
            finishedAtMs,
            expectedImageCount: input.expectedImageCount
        });
    }
    return resolveActualCost({
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
        ...(input.upstreamProxyUrl ? { upstreamProxyUrl: input.upstreamProxyUrl } : {}),
        allowedPlainHttpBaseUrls,
        model: input.model,
        startedAtMs: input.startedAtMs,
        finishedAtMs,
        expectedImageCount: input.expectedImageCount
    });
}

export async function resolveRequestActualCostSafely(input: {
    apiBaseUrl?: string;
    apiKey: string;
    upstreamProxyUrl?: string;
    model: string;
    startedAtMs: number;
    expectedImageCount: number;
    requestLogContext?: RequestLogContext;
}): Promise<ActualCostDetails> {
    try {
        return await resolveRequestActualCost(input);
    } catch (error) {
        appLogger.warn('解析实际扣费失败，继续返回图片结果。', {
            ...input.requestLogContext,
            error: error instanceof Error ? error.message : String(error)
        });
        return {
            currency: 'usd-equivalent',
            source: 'unavailable',
            confidence: 'none',
            upstreamProvider: 'unknown',
            reason: '解析实际扣费失败。'
        };
    }
}
