import { AGENT_MODELS } from './agent-api-contracts';
import { parseChannelPoolConfig, type ChannelCredential } from './channel-router';
import { readPlainHttpApiBaseUrlAllowlist, resolveDefaultImageModel, validateApiBaseUrl } from './image-request-utils';
import { mergeUpstreamHeadersWithFixed } from './image-upstream-profile';
import { isLoopbackIpAddress, isPublicIpAddress, isSyntheticDnsIpAddress } from './network-security';
import { createPinnedDnsDispatcher, fetchOpenAIUpstream, readSyntheticDnsSetting } from './openai-image-transport';
import dns from 'node:dns/promises';
import net from 'node:net';

export type AgentModelEntry = {
    id: string;
    source: 'project_default' | 'project_known' | 'configured';
    custom: boolean;
    status: 'declared' | 'verified_usable' | 'known_unavailable';
    size_policy: 'provider_defined' | 'legacy_allowlist';
    strict_dimensions: boolean;
};

export type AgentModelChannel = {
    id: string;
    host?: string;
    configured: boolean;
    declared_models?: string[];
    model_allowlist_configured?: boolean;
    model_allowlist_state?: 'unrestricted' | 'restricted' | 'mixed' | 'redacted';
    models: string[];
    probe_status: 'not_probed' | 'ok' | 'failed';
    http_status?: number;
    error_code?: 'missing_base_url' | 'missing_api_key' | 'request_failed' | 'invalid_response' | 'upstream_error';
};

export type AgentModelDirectory = {
    ok: true;
    default_model: string;
    known_models: AgentModelEntry[];
    channels: AgentModelChannel[];
    probe: { requested: boolean; timeout_ms: number };
};

const PROBE_TIMEOUT_MS = 5000;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

class ProbeResponseTooLargeError extends Error {
    constructor() {
        super('模型目录响应超过大小限制。');
        this.name = 'ProbeResponseTooLargeError';
    }
}

export function buildAgentModelDirectory(env: Record<string, string | undefined>): AgentModelDirectory {
    const defaultModel = resolveDefaultImageModel(env);
    const configured = new Set<string>();
    for (const name of ['OPENAI_IMAGE_MODEL', 'OPENAI_CONFIGURED_MODELS']) {
        for (const model of (env[name] || '').split(',')) if (model.trim()) configured.add(model.trim());
    }
    for (const [name, value] of Object.entries(env)) {
        if (!/^OPENAI_CHANNEL_\d+_MODELS$/.test(name)) continue;
        for (const model of (value || '').split(',')) if (model.trim()) configured.add(model.trim());
    }
    const channelsById = new Map<string, AgentModelChannel>();
    for (const credential of parseChannelPoolConfig(env).credentials) {
        const url = credential.baseUrl;
        const declaredModels = credential.models ?? [];
        const existing = channelsById.get(credential.channelId);
        if (!existing) {
            channelsById.set(credential.channelId, {
                id: credential.channelId,
                ...(url ? { host: safeHost(url) } : {}),
                configured: Boolean(url && credential.apiKey),
                declared_models: [...declaredModels],
                model_allowlist_configured: declaredModels.length > 0,
                model_allowlist_state: declaredModels.length > 0 ? 'restricted' : 'unrestricted',
                models: [...declaredModels],
                probe_status: 'not_probed'
            });
            continue;
        }
        if (!existing.host && url) existing.host = safeHost(url);
        existing.configured ||= Boolean(url && credential.apiKey);
        existing.declared_models = mergeModelIds(existing.declared_models ?? [], declaredModels);
        existing.models = mergeModelIds(existing.models, declaredModels);
        // A channel can share an ID across multiple credentials. Only mark the
        // channel as allowlisted when every credential has an explicit list;
        // otherwise unrestricted credentials must keep generic models visible.
        existing.model_allowlist_configured = existing.model_allowlist_configured === true && declaredModels.length > 0;
        const previousState = existing.model_allowlist_state;
        const currentState = declaredModels.length > 0 ? 'restricted' : 'unrestricted';
        existing.model_allowlist_state =
            previousState === currentState || previousState === 'mixed' ? previousState : 'mixed';
    }
    const channels = Array.from(channelsById.values());
    const knownModels: AgentModelEntry[] = [
        AGENT_MODELS.includes(defaultModel as (typeof AGENT_MODELS)[number])
            ? createDeclaredProjectModelEntry(defaultModel as (typeof AGENT_MODELS)[number], 'project_default')
            : {
                  id: defaultModel,
                  source: 'project_default' as const,
                  custom: true,
                  status: 'declared' as const,
                  size_policy: 'provider_defined' as const,
                  strict_dimensions: false
              },
        ...AGENT_MODELS.filter((model) => model !== defaultModel).map((id) => createDeclaredProjectModelEntry(id))
    ];
    for (const model of configured) {
        if (!knownModels.some((entry) => entry.id === model)) {
            knownModels.push({
                id: model,
                source: 'configured',
                custom: true,
                status: 'declared',
                size_policy: 'provider_defined',
                strict_dimensions: false
            });
        }
    }
    return {
        ok: true,
        default_model: defaultModel,
        known_models: dedupeModelEntries(knownModels),
        channels,
        probe: { requested: false, timeout_ms: PROBE_TIMEOUT_MS }
    };
}

function createDeclaredProjectModelEntry(
    id: (typeof AGENT_MODELS)[number],
    source: 'project_default' | 'project_known' = 'project_known'
): AgentModelEntry {
    const providerDefined = id === 'gpt-image-2' || id === 'gpt-image-2-1k';
    return {
        id,
        source,
        custom: false,
        status: 'declared',
        size_policy: providerDefined ? 'provider_defined' : 'legacy_allowlist',
        strict_dimensions: false
    };
}

export async function probeAgentModelDirectory(
    env: Record<string, string | undefined>,
    options: { lookup?: typeof dns.lookup } = {}
): Promise<AgentModelDirectory> {
    const directory = buildAgentModelDirectory(env);
    const allowedPlainHttpBaseUrls = readPlainHttpApiBaseUrlAllowlist(env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS);
    const allowSyntheticDns = readSyntheticDnsSetting(env);
    const lookup = options.lookup ?? dns.lookup;
    const credentials = parseChannelPoolConfig(env).credentials;
    const credentialsByChannel = new Map<string, ChannelCredential[]>();
    for (const credential of credentials) {
        const channelCredentials = credentialsByChannel.get(credential.channelId) ?? [];
        channelCredentials.push(credential);
        credentialsByChannel.set(credential.channelId, channelCredentials);
    }
    await Promise.all(
        directory.channels.map(async (channel) => {
            const channelCredentials = credentialsByChannel.get(channel.id) ?? [];
            let lastErrorCode: AgentModelChannel['error_code'] = 'missing_base_url';
            let successfulProbe = false;
            let successfulHost: string | undefined;
            let successfulStatus: number | undefined;
            const discoveredModels = new Set<string>();
            const channelDeadline = Date.now() + PROBE_TIMEOUT_MS;
            for (const credential of channelCredentials) {
                if (Date.now() >= channelDeadline) {
                    lastErrorCode = 'request_failed';
                    break;
                }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.max(0, channelDeadline - Date.now()));
                let pinnedDispatcher: ReturnType<typeof createPinnedDnsDispatcher> | undefined;
                try {
                    if (!credential.baseUrl) {
                        lastErrorCode = 'missing_base_url';
                        continue;
                    }
                    if (!credential.apiKey) {
                        lastErrorCode = 'missing_api_key';
                        continue;
                    }
                    validateApiBaseUrl(credential.baseUrl, { allowedPlainHttpBaseUrls });
                    pinnedDispatcher = credential.upstreamProxyUrl
                        ? undefined
                        : await resolvePinnedChannelHost(
                              credential.baseUrl,
                              lookup,
                              allowedPlainHttpBaseUrls,
                              allowSyntheticDns,
                              controller.signal
                          );
                    const response = await fetchOpenAIUpstream(
                        `${credential.baseUrl.replace(/\/$/, '')}/models`,
                        {
                            headers: mergeUpstreamHeadersWithFixed(credential.upstreamHeaders, {
                                Authorization: `Bearer ${credential.apiKey}`,
                                Accept: 'application/json'
                            }),
                            redirect: 'error',
                            signal: controller.signal
                        },
                        credential.upstreamProxyUrl,
                        pinnedDispatcher,
                        {
                            baseURL: credential.baseUrl,
                            allowedPlainHttpBaseUrls,
                            allowSyntheticDns
                        }
                    );
                    channel.http_status = response.status;
                    if (!response.ok) {
                        await cancelResponseBody(response);
                        lastErrorCode = 'upstream_error';
                        continue;
                    }
                    const contentLength = response.headers.get('content-length');
                    if (contentLength && Number(contentLength) > MAX_PROBE_RESPONSE_BYTES) {
                        await cancelResponseBody(response);
                        lastErrorCode = 'invalid_response';
                        continue;
                    }
                    const body = await readBoundedResponseText(response, MAX_PROBE_RESPONSE_BYTES);
                    let payload: { data?: Array<{ id?: unknown }> };
                    try {
                        payload = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
                    } catch {
                        lastErrorCode = 'invalid_response';
                        continue;
                    }
                    if (!Array.isArray(payload.data)) {
                        lastErrorCode = 'invalid_response';
                        continue;
                    }
                    const probedModels = Array.from(
                        new Set(
                            payload.data
                                .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
                                .filter(Boolean)
                        )
                    ).sort();
                    const allowedModels =
                        credential.models !== undefined && credential.models.length > 0
                            ? probedModels.filter((model) => credential.models?.includes(model))
                            : probedModels;
                    successfulProbe = true;
                    successfulHost ??= safeHost(credential.baseUrl);
                    successfulStatus ??= response.status;
                    for (const model of allowedModels) discoveredModels.add(model);
                } catch (error) {
                    lastErrorCode = error instanceof ProbeResponseTooLargeError ? 'invalid_response' : 'request_failed';
                } finally {
                    clearTimeout(timer);
                    await pinnedDispatcher?.close();
                }
            }
            if (successfulProbe) {
                channel.configured = true;
                if (successfulHost) channel.host = successfulHost;
                if (successfulStatus !== undefined) channel.http_status = successfulStatus;
                channel.models = Array.from(discoveredModels).sort();
                channel.probe_status = 'ok';
                delete channel.error_code;
                for (const id of channel.models) {
                    const knownEntry = directory.known_models.find((entry) => entry.id === id);
                    if (knownEntry) {
                        knownEntry.status = 'verified_usable';
                    } else {
                        directory.known_models.push({
                            id,
                            source: 'configured',
                            custom: !AGENT_MODELS.includes(id as (typeof AGENT_MODELS)[number]),
                            status: 'verified_usable',
                            size_policy: 'provider_defined',
                            strict_dimensions: false
                        });
                    }
                }
                return;
            }
            channel.probe_status = 'failed';
            channel.error_code = lastErrorCode;
        })
    );
    directory.known_models = dedupeModelEntries(directory.known_models);
    directory.probe.requested = true;
    return directory;
}

async function resolvePinnedChannelHost(
    baseUrl: string,
    lookup: typeof dns.lookup,
    allowedPlainHttpBaseUrls: string[],
    allowSyntheticDns: boolean,
    signal?: AbortSignal
) {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const literalFamily = net.isIP(hostname);
    const allowPrivate = isExplicitlyAllowedPrivateHttpBaseUrl(parsed, allowedPlainHttpBaseUrls);
    let addresses: Array<{ address: string; family: number }>;
    if (literalFamily) {
        addresses = [{ address: hostname, family: literalFamily }];
    } else {
        addresses = await lookupWithAbort(lookup, hostname, signal);
    }
    if (
        addresses.length === 0 ||
        (!allowPrivate &&
            addresses.some(
                ({ address }) =>
                    !isPublicIpAddress(address) &&
                    !(allowSyntheticDns && !literalFamily && isSyntheticDnsIpAddress(address))
            ))
    ) {
        throw new Error('模型目录渠道主机解析到了被禁止的本地或内网地址。');
    }
    return createPinnedDnsDispatcher(addresses);
}

async function lookupWithAbort(
    lookup: typeof dns.lookup,
    hostname: string,
    signal?: AbortSignal
): Promise<Array<{ address: string; family: number }>> {
    if (!signal) return lookup(hostname, { all: true, verbatim: true });
    if (signal.aborted) throw new Error('DNS lookup aborted');
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error('DNS lookup aborted'));
        signal.addEventListener('abort', abortHandler, { once: true });
    });
    try {
        return await Promise.race([lookup(hostname, { all: true, verbatim: true }), abortPromise]);
    } finally {
        if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
}

function isExplicitlyAllowedPrivateHttpBaseUrl(parsed: URL, allowedPlainHttpBaseUrls: string[]): boolean {
    if (parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    if (net.isIP(hostname) === 4 && hostname.startsWith('127.')) return true;
    if (net.isIP(hostname) === 6 && isLoopbackIpAddress(hostname)) return true;
    const normalized = normalizePlainHttpBaseUrl(parsed);
    return allowedPlainHttpBaseUrls.some((value) => {
        try {
            return normalizePlainHttpBaseUrl(new URL(value)) === normalized;
        } catch {
            return false;
        }
    });
}

function normalizePlainHttpBaseUrl(value: URL): string {
    const pathname = value.pathname.replace(/\/+$/, '') || '/';
    return `${value.protocol}//${value.host}${pathname}`;
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ProbeResponseTooLargeError();
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                throw new ProbeResponseTooLargeError();
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        return chunks.join('');
    } finally {
        reader.releaseLock();
    }
}

async function cancelResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // The probe result is already being discarded; cancellation failures do not change its classification.
    }
}

function mergeModelIds(current: readonly string[], next: readonly string[]): string[] {
    return Array.from(new Set([...current, ...next]));
}

function dedupeModelEntries(entries: AgentModelEntry[]): AgentModelEntry[] {
    const byId = new Map<string, AgentModelEntry>();
    for (const entry of entries) {
        const existing = byId.get(entry.id);
        if (!existing || (entry.status === 'verified_usable' && existing.status !== 'verified_usable')) {
            byId.set(entry.id, entry);
        }
    }
    return Array.from(byId.values());
}

function safeHost(value: string): string | undefined {
    try {
        return new URL(value).host;
    } catch {
        return undefined;
    }
}
