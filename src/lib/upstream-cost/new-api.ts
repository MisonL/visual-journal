import { fetchOpenAIUpstream } from '../openai-image-transport';
import type { ActualCostDetails, ActualCostResolver, ResolveActualCostInput } from './types';

export const NEW_API_QUOTA_PER_UNIT = 500_000;

const LOG_TOKEN_PATH = '/api/log/token';
const LOG_MATCH_WINDOW_BEFORE_MS = 5_000;
const LOG_MATCH_WINDOW_AFTER_MS = 15_000;
const POLL_ATTEMPTS = 3;
const POLL_DELAY_MS = 600;
const FETCH_TIMEOUT_MS = 1_500;

type NewApiLogEntry = {
    id?: unknown;
    created_at?: unknown;
    type?: unknown;
    model_name?: unknown;
    quota?: unknown;
    request_id?: unknown;
};

type NewApiLogResponse = {
    success?: unknown;
    data?: unknown;
};

function unavailable(reason: string): ActualCostDetails {
    return {
        currency: 'usd-equivalent',
        source: 'unavailable',
        confidence: 'none',
        upstreamProvider: 'new-api',
        reason
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function quotaToUsdEquivalent(quota: number): number {
    return Math.round((quota / NEW_API_QUOTA_PER_UNIT) * 1_000_000) / 1_000_000;
}

export function buildNewApiLogTokenUrl(apiBaseUrl: string): URL | undefined {
    try {
        const parsed = new URL(apiBaseUrl);
        return new URL(LOG_TOKEN_PATH, `${parsed.protocol}//${parsed.host}`);
    } catch {
        return undefined;
    }
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isConsumeLog(entry: NewApiLogEntry): boolean {
    const type = readNumber(entry.type);
    return type === 2;
}

export function matchNewApiCostLog(input: {
    logs: NewApiLogEntry[];
    model: string;
    startedAtMs: number;
    finishedAtMs: number;
}): ActualCostDetails {
    const windowStart = Math.floor((input.startedAtMs - LOG_MATCH_WINDOW_BEFORE_MS) / 1000);
    const windowEnd = Math.ceil((input.finishedAtMs + LOG_MATCH_WINDOW_AFTER_MS) / 1000);
    const matches = input.logs.filter((entry) => {
        const createdAt = readNumber(entry.created_at);
        const quota = readNumber(entry.quota);
        return (
            isConsumeLog(entry) &&
            entry.model_name === input.model &&
            createdAt !== undefined &&
            createdAt >= windowStart &&
            createdAt <= windowEnd &&
            quota !== undefined &&
            quota > 0
        );
    });

    if (matches.length === 0) {
        return unavailable('未匹配到当前请求时间窗口内的 new-api 扣费日志。');
    }
    if (matches.length > 1) {
        return {
            currency: 'usd-equivalent',
            source: 'unavailable',
            confidence: 'low',
            upstreamProvider: 'new-api',
            reason: `匹配到 ${matches.length} 条候选扣费日志，无法唯一确认。`
        };
    }

    const match = matches[0];
    const quota = readNumber(match.quota) as number;

    const id = readNumber(match.id);
    const requestId = typeof match.request_id === 'string' && match.request_id ? match.request_id : undefined;
    return {
        actualAmount: quotaToUsdEquivalent(quota),
        actualQuota: quota,
        currency: 'usd-equivalent',
        source: 'new-api-log-token',
        confidence: 'high',
        upstreamProvider: 'new-api',
        ...(id === undefined ? {} : { matchedLogId: id }),
        ...(requestId ? { matchedRequestId: requestId } : {})
    };
}

async function fetchLogs(
    url: URL,
    apiKey: string,
    upstreamProxyUrl?: string,
    input?: Pick<ResolveActualCostInput, 'apiBaseUrl' | 'allowedPlainHttpBaseUrls'>
): Promise<NewApiLogEntry[] | undefined> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetchOpenAIUpstream(
            url,
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                },
                signal: abortController.signal
            },
            upstreamProxyUrl,
            undefined,
            {
                baseURL: input?.apiBaseUrl,
                allowedPlainHttpBaseUrls: input?.allowedPlainHttpBaseUrls
            }
        );
        if (!response.ok) return undefined;

        const body = (await response.json()) as NewApiLogResponse;
        if (body.success !== true || !Array.isArray(body.data)) return undefined;
        return body.data as NewApiLogEntry[];
    } finally {
        clearTimeout(timeout);
    }
}

export class NewApiCostResolver implements ActualCostResolver {
    readonly provider = 'new-api' as const;

    async resolve(input: ResolveActualCostInput): Promise<ActualCostDetails> {
        if (!input.apiBaseUrl || !input.apiKey) {
            return unavailable('缺少上游 API URL 或 API key，无法查询 new-api 扣费日志。');
        }

        const url = buildNewApiLogTokenUrl(input.apiBaseUrl);
        if (!url) {
            return unavailable('上游 API URL 无效，无法查询 new-api 扣费日志。');
        }

        try {
            for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
                const logs = await fetchLogs(url, input.apiKey, input.upstreamProxyUrl, input);
                if (logs) {
                    const result = matchNewApiCostLog({
                        logs,
                        model: input.model,
                        startedAtMs: input.startedAtMs,
                        finishedAtMs: input.finishedAtMs
                    });
                    if (result.source === 'new-api-log-token' || attempt === POLL_ATTEMPTS - 1) {
                        return result;
                    }
                }
                if (attempt < POLL_ATTEMPTS - 1) {
                    await sleep(POLL_DELAY_MS);
                }
            }
            return unavailable('new-api 扣费日志接口没有返回可解析日志。');
        } catch (error) {
            return unavailable(error instanceof Error ? error.message : String(error));
        }
    }
}
