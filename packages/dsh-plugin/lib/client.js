import net from 'node:net';

export const DEFAULT_BASE_URL = 'http://localhost:4783';
export const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_RETRY_AFTER_SECONDS = 30;

/** Agent API paths owned by the Visual Journal server contract. */
export const AGENT_ENDPOINTS = Object.freeze({
    capabilities: '/api/agent/capabilities',
    models: '/api/agent/models',
    generate: '/api/agent/image-requests',
    edit: '/api/agent/images/edit',
    requestDiagnostics: '/api/agent/diagnostics/requests',
    channelHealth: '/api/agent/diagnostics/channel-health',
    jobResult: (jobId) => `/api/agent/jobs/${encodeURIComponent(jobId)}/result`,
    artifact: (artifactId) => `/api/agent/artifacts/${encodeURIComponent(artifactId)}`,
    artifactShare: (artifactId) => `/api/agent/artifacts/${encodeURIComponent(artifactId)}/share`,
    pageRequestDiagnostics: (pageRequestId) =>
        `/api/agent/diagnostics/page-requests/${encodeURIComponent(pageRequestId)}`
});

/** Failure carrying the server's structured error contract instead of parsed message text. */
export class VisualJournalError extends Error {
    constructor(message, { code, status, retryable, retryAfterSeconds, requestId } = {}) {
        super(message);
        this.name = 'VisualJournalError';
        this.code = code ?? 'visual_journal_error';
        this.status = status;
        this.retryable = retryable === true;
        this.retryAfterSeconds = retryAfterSeconds;
        this.requestId = requestId;
    }
}

/**
 * Resolve the service origin from profile config or the process environment only;
 * tool arguments never reach this function.
 */
export function resolveBaseUrl(configured) {
    const raw =
        normalizeNonEmpty(configured) || normalizeNonEmpty(process.env.GPT_IMAGE_PLAYGROUND_URL) || DEFAULT_BASE_URL;
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('base_url 必须是无凭据、无查询参数、无片段的 http/https URL。');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        throw new Error('base_url 使用 HTTP 时仅允许 localhost 或回环地址；远程服务必须使用 HTTPS。');
    }
    return url.toString().replace(/\/+$/, '');
}

/** Agent credentials come from the process environment and never from tool arguments. */
export function authHeaders(env = process.env) {
    const token = normalizeNonEmpty(env.AGENT_API_TOKEN) || normalizeNonEmpty(env.GPT_IMAGE_AGENT_TOKEN);
    if (token) return { Authorization: `Bearer ${token}` };
    const passwordHash = normalizeNonEmpty(env.GPT_IMAGE_APP_PASSWORD_HASH);
    if (passwordHash) return { 'X-App-Password-Hash': passwordHash };
    return {};
}

/** Resolve a server-provided URL and refuse to send credentials anywhere but the configured origin. */
export function resolveSameOriginUrl(baseUrl, value) {
    const base = new URL(baseUrl);
    const isRootRelative = typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
    const resolved = new URL(value, isRootRelative ? base.origin : `${baseUrl}/`);
    if (isRootRelative && base.pathname !== '/') {
        const prefix = base.pathname.replace(/\/+$/, '');
        if (resolved.pathname !== prefix && !resolved.pathname.startsWith(`${prefix}/`)) {
            resolved.pathname = `${prefix}${resolved.pathname}`;
        }
    }
    if (resolved.origin !== base.origin || resolved.username || resolved.password) {
        throw new Error('服务端返回的 URL 指向不同 origin，拒绝携带鉴权头访问。');
    }
    return resolved.toString();
}

/**
 * One tool invocation's view of the service: a fixed origin, credentials, one
 * shared deadline, and the caller's cancellation signal.
 */
export function createClient({ baseUrl, timeoutMs, signal, env = process.env }) {
    const deadline = Date.now() + timeoutMs;
    const headers = authHeaders(env);

    const remainingMs = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new VisualJournalError('Visual Journal 请求超出工具时间预算。', { code: 'deadline' });
        return remaining;
    };

    async function request(path, options = {}) {
        const { response, result, text } = await send({
            url: options.url ?? `${baseUrl}${path}`,
            method: options.method ?? 'GET',
            headers: { ...headers, ...(options.headers ?? {}) },
            body: options.body,
            timeoutMs: remainingMs(),
            signal
        });
        if (response.ok) {
            const data = parseJson(text, response.status, result);
            // The create endpoints flag a cached replay, which is the only signal
            // that a resubmitted operation was answered without new work.
            return options.withResponse === true
                ? { data, replayed: response.headers.get('x-idempotent-replay') === 'true' }
                : data;
        }
        if (options.allowNotFound === true && response.status === 404 && result?.found === false) return result;
        throw toServiceError(response, result, text);
    }

    async function requestBytes(url, maxBytes) {
        const response = await sendRaw({ url, headers, timeoutMs: remainingMs(), signal });
        if (!response.ok) {
            const text = await response.text();
            throw toServiceError(response, safeParse(text), text);
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error(`产物大小 ${declared} 字节超过附件上限 ${maxBytes} 字节。`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength > maxBytes) {
            throw new Error(`产物大小 ${data.byteLength} 字节超过附件上限 ${maxBytes} 字节。`);
        }
        return { data, contentType: response.headers.get('content-type') ?? '' };
    }

    /** Poll a server-orchestrated job until its final response, honoring Retry-After within the deadline. */
    async function waitForJob(job) {
        if (!job || typeof job.id !== 'string' || !job.id.trim()) {
            throw new Error('创建 job 的响应缺少有效 job.id。');
        }
        const resultUrl = resolveSameOriginUrl(
            baseUrl,
            job.result_url || `${baseUrl}${AGENT_ENDPOINTS.jobResult(job.id)}`
        );
        let retryAfterSeconds = readRetryAfterSeconds(job.retry_after_seconds, 1);
        for (;;) {
            const { response, result, text } = await send({
                url: resultUrl,
                method: 'GET',
                headers,
                timeoutMs: remainingMs(),
                signal
            });
            if (response.ok) return parseJson(text, response.status, result);
            if (result?.error?.code !== 'request_in_progress' || result?.error?.retryable !== true) {
                throw toServiceError(response, result, text);
            }
            retryAfterSeconds = readRetryAfterSeconds(
                response.headers.get('retry-after') ?? result.retry_after ?? result.error.retry_after_seconds,
                retryAfterSeconds
            );
            await sleepWithSignal(Math.min(retryAfterSeconds * 1000, remainingMs()), signal);
        }
    }

    return { baseUrl, request, requestBytes, waitForJob, remainingMs };
}

async function send(options) {
    const response = await sendRaw(options);
    const text = await response.text();
    return { response, result: safeParse(text), text };
}

async function sendRaw({ url, method = 'GET', headers, body, timeoutMs, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', abort, { once: true });
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
        return await fetch(url, {
            method,
            headers: body === undefined || isForm ? headers : { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
            redirect: 'error',
            signal: controller.signal
        });
    } catch (error) {
        if (timedOut) {
            throw new VisualJournalError(`Visual Journal 请求超时（${timeoutMs} 毫秒）。`, { code: 'timeout' });
        }
        // The caller's own cancellation stays untouched; a transport failure
        // must not reach the model as a bare `fetch failed`, because skill.js
        // tells it to branch on `code`/`retryable` rather than parse messages.
        if (signal?.aborted) throw error;
        throw new VisualJournalError(unreachableMessage(url, error), {
            code: 'network',
            retryable: true
        });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** Describe a transport failure without leaking the raw `fetch failed` text. */
function unreachableMessage(url, error) {
    let origin = url;
    try {
        origin = new URL(url).origin;
    } catch {
        // keep the raw url when it cannot be parsed
    }
    const cause = error?.cause?.code ?? error?.code;
    return cause
        ? `无法连接 Visual Journal（${origin}）：${cause}。`
        : `无法连接 Visual Journal（${origin}）：${error?.message ?? '网络错误'}。`;
}

function parseJson(text, status, parsed) {
    if (text && parsed === undefined) {
        throw new VisualJournalError(`Visual Journal 返回了非 JSON 响应，状态码 ${status}。`, {
            code: 'invalid_response',
            status
        });
    }
    return parsed ?? null;
}

function safeParse(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function toServiceError(response, result, text) {
    const error = result?.error;
    const code = typeof error?.code === 'string' ? error.code : `http_${response.status}`;
    const message = error?.message ?? result?.message ?? (text?.trim().slice(0, 500) || `HTTP ${response.status}`);
    const retryable = error?.retryable === true;
    const retryAfterSeconds = readRetryAfterSeconds(
        response.headers.get('retry-after') ?? error?.retry_after_seconds,
        undefined
    );
    const hints = [`code=${code}`, `retryable=${retryable}`];
    if (retryAfterSeconds !== undefined) hints.push(`retry_after_seconds=${retryAfterSeconds}`);
    return new VisualJournalError(
        `Visual Journal 请求失败，状态码 ${response.status}（${hints.join(', ')}）：${message}`,
        {
            code,
            status: response.status,
            retryable,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id') ?? error?.request_id
        }
    );
}

export function readRetryAfterSeconds(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(MAX_RETRY_AFTER_SECONDS, parsed);
}

export function sleepWithSignal(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('请求已取消。'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error('请求已取消。'));
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

export function normalizeNonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A stable operation key: bounded, printable, and required before any billable call. */
export function requireIdempotencyKey(value, label = 'idempotency_key') {
    const normalized = normalizeNonEmpty(value);
    if (!normalized) throw new Error(`allow_billable=true 时必须提供 ${label}。`);
    if (normalized.length > 200) throw new Error(`${label} 长度不能超过 200 个字符。`);
    if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} 不能包含控制字符。`);
    return normalized;
}

function isLoopbackHost(hostname) {
    const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
    const family = net.isIP(normalized);
    if (family === 4) return normalized.startsWith('127.');
    if (family === 6) {
        const hextets = parseIpv6Hextets(normalized);
        if (!hextets) return false;
        if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true;
        return readEmbeddedIpv4(hextets)?.startsWith('127.') === true;
    }
    return false;
}

function parseIpv6Hextets(address) {
    let normalized = address.toLowerCase();
    if (normalized.includes('%')) return undefined;
    if (normalized.includes('.')) {
        const separator = normalized.lastIndexOf(':');
        const ipv4 = normalized.slice(separator + 1);
        if (separator < 0 || !/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return undefined;
        const octets = ipv4.split('.').map(Number);
        if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
        normalized = `${normalized.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const compressionIndex = normalized.indexOf('::');
    if (compressionIndex >= 0 && normalized.indexOf('::', compressionIndex + 2) >= 0) return undefined;
    const leftText = compressionIndex >= 0 ? normalized.slice(0, compressionIndex) : normalized;
    const rightText = compressionIndex >= 0 ? normalized.slice(compressionIndex + 2) : '';
    const parsePart = (part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : undefined);
    const leftValues = (leftText ? leftText.split(':') : []).map(parsePart);
    const rightValues = (rightText ? rightText.split(':') : []).map(parsePart);
    if ([...leftValues, ...rightValues].some((value) => value === undefined)) return undefined;
    const values = [...leftValues, ...rightValues];
    if (compressionIndex < 0) return values.length === 8 ? values : undefined;
    const missing = 8 - values.length;
    if (missing < 1) return undefined;
    return [...leftValues, ...Array.from({ length: missing }, () => 0), ...rightValues];
}

function readEmbeddedIpv4(hextets) {
    if (hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff) {
        const [high, low] = [hextets[6], hextets[7]];
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return undefined;
}
