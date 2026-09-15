import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import net from 'node:net';

const DEFAULT_BASE_URL = 'http://localhost:4783';
const DEFAULT_TIMEOUT_MS = 900_000;
const AGENT_ENDPOINTS = Object.freeze({
    capabilities: '/api/agent/capabilities',
    generate: '/api/agent/image-requests',
    diagnostics: '/api/agent/diagnostics/requests',
    jobResult: (jobId) => `/api/agent/jobs/${encodeURIComponent(jobId)}/result`
});

export const name = 'visual-journal-dsh-plugin';
export const inject = ['tools'];
export const Config = z.object({
    baseUrl: z.string().default(undefined),
    timeoutMs: z.number().min(1).default(DEFAULT_TIMEOUT_MS)
});

const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
};

const generateParameters = {
    prompt: { type: 'string', required: true, description: 'Image generation prompt.' },
    model: { type: 'string', description: 'Image model.' },
    size: { type: 'string', description: 'Requested image size.' },
    quality: { type: 'string', description: 'Image quality.' },
    n: { type: 'integer', description: 'Number of images.' },
    output_format: { type: 'string', description: 'Output format.' },
    output_compression: { type: 'integer', description: 'Output compression for lossy formats.' },
    response_mode: { type: 'string', description: 'Response mode.' },
    background: { type: 'string', description: 'Background mode.' },
    moderation: { type: 'string', description: 'Moderation mode.' },
    image_backend: { type: 'string', description: 'Image backend.' },
    stream_mode: { type: 'string', description: 'Streaming mode.' },
    streaming_strategy: { type: 'string', description: 'Streaming strategy.' },
    partial_images: { type: 'integer', description: 'Partial image count.' },
    responsesModel: { type: 'string', description: 'Responses image model.' },
    thinking: { type: 'string', description: 'Reasoning level.' },
    promptOptimization: { type: 'boolean', description: 'Enable prompt optimization.' },
    force_web: { type: 'boolean', description: 'Force web search.' },
    force_request: { type: 'boolean', description: 'Force request despite compatibility checks.' },
    allow_billable: { type: 'boolean', description: 'Explicitly allow a billable request.' },
    idempotency_key: { type: 'string', description: 'Stable key for a billable operation.' }
};

const diagnosticsParameters = {
    request_id: { type: 'string', description: 'Agent request_id to inspect.' },
    idempotency_key: { type: 'string', description: 'Idempotency-Key to inspect.' }
};

export function apply(ctx, config) {
    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    registerCapabilitiesTool(ctx, config?.baseUrl, timeoutMs);
    registerGenerateTool(ctx, config?.baseUrl, timeoutMs);
    registerDiagnosticsTool(ctx, config?.baseUrl, timeoutMs);
}

function registerCapabilitiesTool(ctx, configuredBaseUrl, timeoutMs) {
    ctx.tools.register(
        defineTool({
            name: 'visual_journal_capabilities',
            description: 'Read the Visual Journal Agent API capabilities and limits without generating an image.',
            parameters: {},
            output: JSON_OUTPUT,
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(_args, exec) {
                return requestJson({
                    baseUrl: resolveBaseUrl(configuredBaseUrl),
                    path: AGENT_ENDPOINTS.capabilities,
                    timeoutMs,
                    signal: exec.signal,
                    headers: authHeaders()
                });
            }
        })
    );
}

function registerGenerateTool(ctx, configuredBaseUrl, timeoutMs) {
    ctx.tools.register(
        defineTool({
            name: 'visual_journal_generate',
            description:
                'Plan a Visual Journal image generation request. It is a dry-run by default; set allow_billable=true and provide idempotency_key to submit a real request.',
            parameters: generateParameters,
            output: JSON_OUTPUT,
            timeoutMs,
            async execute(args, exec) {
                const baseUrl = resolveBaseUrl(configuredBaseUrl);
                const request = buildGenerateRequest(args);
                if (args.allow_billable !== true) {
                    return {
                        ok: true,
                        billable: false,
                        dry_run: true,
                        service_base_url: baseUrl,
                        endpoint: AGENT_ENDPOINTS.generate,
                        request,
                        idempotency_key: args.idempotency_key ?? null,
                        guardrails: {
                            billable_request_sent: false,
                            requires: ['allow_billable=true', 'idempotency_key']
                        }
                    };
                }
                const idempotencyKey = requireIdempotencyKey(args.idempotency_key);
                const deadline = Date.now() + timeoutMs;
                const createTimeoutMs = deadline - Date.now();
                if (createTimeoutMs <= 0) throw new Error('Visual Journal 创建请求超时。');
                const created = await requestJson({
                    baseUrl,
                    path: AGENT_ENDPOINTS.generate,
                    method: 'POST',
                    timeoutMs: createTimeoutMs,
                    signal: exec.signal,
                    headers: {
                        ...authHeaders(),
                        'Content-Type': 'application/json',
                        'Idempotency-Key': idempotencyKey
                    },
                    body: request,
                    metadata: { idempotency_key: idempotencyKey, billable: true }
                });
                if (!created.response?.job) {
                    if (created.response?.request_id || created.response?.images) return created;
                    throw new Error('Visual Journal 创建 job 的响应缺少 job。');
                }
                const remainingTimeoutMs = deadline - Date.now();
                if (remainingTimeoutMs <= 0) throw new Error('等待 Visual Journal job 结果超时。');
                return pollJobResult({
                    baseUrl,
                    job: created.response.job,
                    idempotencyKey,
                    timeoutMs: remainingTimeoutMs,
                    signal: exec.signal
                });
            }
        })
    );
}

function registerDiagnosticsTool(ctx, configuredBaseUrl, timeoutMs) {
    ctx.tools.register(
        defineTool({
            name: 'visual_journal_diagnose',
            description: 'Read a stored Visual Journal Agent request diagnostic by request_id or idempotency_key.',
            parameters: diagnosticsParameters,
            output: JSON_OUTPUT,
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const lookup = resolveDiagnosticLookup(args);
                const baseUrl = resolveBaseUrl(configuredBaseUrl);
                return requestJson({
                    baseUrl,
                    path: `${AGENT_ENDPOINTS.diagnostics}?${lookup.type}=${encodeURIComponent(lookup.value)}`,
                    timeoutMs,
                    signal: exec.signal,
                    headers: authHeaders(),
                    allowMissingDiagnostic: true
                });
            }
        })
    );
}

function buildGenerateRequest(args) {
    const request = { prompt: args.prompt };
    const fields = [
        'model',
        'size',
        'quality',
        'n',
        'output_format',
        'output_compression',
        'response_mode',
        'background',
        'moderation',
        'image_backend',
        'stream_mode',
        'streaming_strategy',
        'partial_images',
        'responsesModel',
        'thinking',
        'promptOptimization',
        'force_web',
        'force_request'
    ];
    for (const field of fields) if (args[field] !== undefined) request[field] = args[field];
    return request;
}

function resolveDiagnosticLookup(args) {
    const requestId = normalizeNonEmpty(args.request_id);
    const idempotencyKey = normalizeNonEmpty(args.idempotency_key);
    if (requestId && idempotencyKey) throw new Error('request_id 和 idempotency_key 只能提供一个。');
    if (!requestId && !idempotencyKey) throw new Error('必须提供 request_id 或 idempotency_key。');
    return requestId ? { type: 'request_id', value: requestId } : { type: 'idempotency_key', value: idempotencyKey };
}

function requireIdempotencyKey(value) {
    const normalized = normalizeNonEmpty(value);
    if (!normalized) throw new Error('allow_billable=true 时必须提供 idempotency_key。');
    if (normalized.length > 200) throw new Error('idempotency_key 长度不能超过 200 个字符。');
    if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('idempotency_key 不能包含控制字符。');
    return normalized;
}

function normalizeNonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveBaseUrl(configured) {
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

function isLoopbackHost(hostname) {
    const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
    const family = net.isIP(normalized);
    if (family === 4) return normalized.startsWith('127.');
    if (family === 6) {
        const hextets = parseIpv6Hextets(normalized);
        if (!hextets) return false;
        if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true;
        const embeddedIpv4 = readEmbeddedIpv4(hextets);
        return embeddedIpv4?.startsWith('127.') === true;
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
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    const parsePart = (part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : undefined);
    const leftValues = left.map(parsePart);
    const rightValues = right.map(parsePart);
    if (leftValues.some((value) => value === undefined) || rightValues.some((value) => value === undefined)) {
        return undefined;
    }
    const values = [...leftValues, ...rightValues];
    if (compressionIndex < 0) return values.length === 8 ? values : undefined;
    const missing = 8 - values.length;
    if (missing < 1) return undefined;
    return [...leftValues, ...Array.from({ length: missing }, () => 0), ...rightValues];
}

function readEmbeddedIpv4(hextets) {
    if (hextets.slice(0, 5).every((value) => value === 0) && hextets[5] === 0xffff) {
        return ipv4FromHextets(hextets[6], hextets[7]);
    }
    return undefined;
}

function ipv4FromHextets(high, low) {
    return (high >> 8) + '.' + (high & 255) + '.' + (low >> 8) + '.' + (low & 255);
}

function authHeaders() {
    const token =
        normalizeNonEmpty(process.env.AGENT_API_TOKEN) || normalizeNonEmpty(process.env.GPT_IMAGE_AGENT_TOKEN);
    if (token) return { Authorization: `Bearer ${token}` };
    const passwordHash = normalizeNonEmpty(process.env.GPT_IMAGE_APP_PASSWORD_HASH);
    if (passwordHash) return { 'X-App-Password-Hash': passwordHash };
    return {};
}

async function requestJson(options) {
    const { response, result, text } = await fetchJson(options);
    if (!response.ok) {
        if (options.allowMissingDiagnostic === true && response.status === 404 && result?.found === false) {
            return {
                ok: true,
                billable: options.metadata?.billable === true,
                service_base_url: options.baseUrl,
                endpoint: options.path.split('?')[0],
                ...(options.metadata ?? {}),
                response: result
            };
        }
        const message = result?.error?.message ?? result?.message ?? (text.trim() || `HTTP ${response.status}`);
        throw new Error(`Visual Journal 请求失败，状态码 ${response.status}：${message}`);
    }
    return {
        ok: true,
        billable: options.metadata?.billable === true,
        service_base_url: options.baseUrl,
        endpoint: options.path.split('?')[0],
        ...(options.metadata ?? {}),
        response: result
    };
}

async function fetchJson(options) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', abort, { once: true });
    try {
        const response = await fetch(options.url ?? `${options.baseUrl}${options.path}`, {
            method: options.method ?? 'GET',
            headers: options.headers,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            redirect: 'error',
            signal: controller.signal
        });
        const text = await response.text();
        let result;
        try {
            result = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`Visual Journal 返回了非 JSON 响应，状态码 ${response.status}。`);
        }
        return { response, result, text };
    } catch (error) {
        if (timedOut) throw new Error(`Visual Journal 请求超时（${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒）。`);
        throw error;
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
    }
}

async function pollJobResult({ baseUrl, job, idempotencyKey, timeoutMs, signal }) {
    if (!job || typeof job.id !== 'string' || !job.id.trim()) {
        throw new Error('创建 job 的响应缺少有效 job.id。');
    }
    const fallbackResultUrl = `${baseUrl}${AGENT_ENDPOINTS.jobResult(job.id)}`;
    const resultUrl = resolveSameOriginUrl(baseUrl, job.result_url || fallbackResultUrl);
    const deadline = Date.now() + timeoutMs;
    let retryAfterSeconds = readRetryAfterSeconds(job.retry_after_seconds, 1);
    let lastResult;

    while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        const { response, result, text } = await fetchJson({
            url: resultUrl,
            signal,
            timeoutMs: Math.max(1, remainingMs),
            headers: authHeaders()
        });
        if (response.ok) {
            return {
                ok: true,
                billable: true,
                service_base_url: baseUrl,
                endpoint: AGENT_ENDPOINTS.jobResult(job.id),
                idempotency_key: idempotencyKey,
                job_id: job.id,
                response: result
            };
        }
        lastResult = result;
        if (result?.error?.code !== 'request_in_progress' || result?.error?.retryable !== true) {
            const message = result?.error?.message ?? result?.message ?? (text.trim() || `HTTP ${response.status}`);
            throw new Error(`Visual Journal job 结果失败，状态码 ${response.status}：${message}`);
        }
        retryAfterSeconds = readRetryAfterSeconds(
            response.headers.get('retry-after') ?? result.retry_after ?? result.error.retry_after_seconds,
            retryAfterSeconds
        );
        await sleepWithSignal(Math.min(retryAfterSeconds * 1000, Math.max(1, deadline - Date.now())), signal);
    }

    const message = lastResult?.error?.message ?? '等待 Visual Journal job 结果超时。';
    throw new Error(`等待 Visual Journal job 结果超时：${message}`);
}

function readRetryAfterSeconds(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(30, parsed);
}

function sleepWithSignal(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('请求已取消。'));
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            signal?.removeEventListener('abort', abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(signal.reason ?? new Error('请求已取消。'));
        };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

function resolveSameOriginUrl(baseUrl, value) {
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
        throw new Error('job.result_url 指向不同 origin，拒绝携带鉴权头访问。');
    }
    return resolved.toString();
}

export const internals = Object.freeze({
    AGENT_ENDPOINTS,
    DEFAULT_TIMEOUT_MS,
    buildGenerateRequest,
    pollJobResult,
    resolveBaseUrl,
    resolveDiagnosticLookup,
    requireIdempotencyKey,
    resolveSameOriginUrl
});
