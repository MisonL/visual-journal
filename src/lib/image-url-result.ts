import { readPlainHttpApiBaseUrlAllowlist, RequestValidationError } from './image-request-utils';
import { mergeUpstreamHeadersWithFixed, type UpstreamRequestHeaders } from './image-upstream-profile';
import { isPublicIpAddress, isSyntheticDnsIpAddress } from './network-security';
import {
    createPinnedDnsDispatcher,
    fetchOpenAIUpstream,
    readSyntheticDnsSetting,
    UpstreamResponseFormatError
} from './openai-image-transport';
import dns from 'node:dns/promises';
import net from 'node:net';

export { isPublicIpAddress } from './network-security';

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;

export class RemoteImageResultError extends Error {
    readonly status = 502;

    constructor(message: string) {
        super(message);
        this.name = 'RemoteImageResultError';
    }
}

function resolveRemoteImageUrl(rawUrl: string, apiBaseUrl: string | undefined): URL {
    if (!apiBaseUrl) {
        throw new RemoteImageResultError('上游返回远程图片 URL，但当前请求缺少 API Base URL，无法安全下载。');
    }
    let base: URL;
    let resolved: URL;
    try {
        base = new URL(apiBaseUrl);
        resolved = new URL(rawUrl, base);
    } catch {
        throw new RemoteImageResultError('上游返回的图片 URL 格式无效。');
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        throw new RemoteImageResultError('上游图片 URL 必须使用 http 或 https。');
    }
    if (resolved.username || resolved.password) {
        throw new RemoteImageResultError('上游图片 URL 不能包含用户名或密码。');
    }
    const sameOrigin = resolved.origin === base.origin;
    // Same-origin results stay within the already validated API origin; only cross-origin results need
    // the stricter public-host and pinned-DNS checks below.
    if (resolved.protocol === 'http:' && !sameOrigin) {
        throw new RemoteImageResultError('跨域上游图片 URL 必须使用 HTTPS。');
    }
    if (!sameOrigin && isBlockedRemoteHostname(resolved.hostname)) {
        throw new RemoteImageResultError('上游图片 URL 指向被禁止的本地或内网地址。');
    }
    return resolved;
}

function isSameOrigin(url: URL, apiBaseUrl: string | undefined): boolean {
    return Boolean(apiBaseUrl && new URL(apiBaseUrl).origin === url.origin);
}

export async function downloadSameOriginImageAsBase64(input: {
    imageUrl: string;
    apiBaseUrl?: string;
    apiKey?: string;
    upstreamProxyUrl?: string;
    upstreamHeaders?: UpstreamRequestHeaders;
    allowedPlainHttpBaseUrls?: string[];
    allowSyntheticDns?: boolean;
    abortSignal?: AbortSignal;
    lookup?: typeof dns.lookup;
}): Promise<string> {
    const url = resolveRemoteImageUrl(input.imageUrl, input.apiBaseUrl);
    const sameOrigin = isSameOrigin(url, input.apiBaseUrl);
    if (input.upstreamProxyUrl && !sameOrigin) {
        throw new RemoteImageResultError('配置代理时不允许下载跨域上游图片 URL。');
    }
    const allowedPlainHttpBaseUrls =
        input.allowedPlainHttpBaseUrls ??
        readPlainHttpApiBaseUrlAllowlist(process.env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS);
    const abortListener = () => controller.abort();
    if (input.abortSignal?.aborted) {
        controller.abort();
    } else {
        input.abortSignal?.addEventListener('abort', abortListener, { once: true });
    }
    let pinnedDispatcher: ReturnType<typeof createPinnedDnsDispatcher> | undefined;
    try {
        if (!sameOrigin) {
            pinnedDispatcher = await resolvePinnedRemoteHost(
                url.hostname,
                input.lookup ?? dns.lookup,
                controller.signal,
                input.allowSyntheticDns ?? readSyntheticDnsSetting()
            );
        }
        const response = await fetchOpenAIUpstream(
            url,
            {
                headers: buildDownloadHeaders(
                    sameOrigin ? input.apiKey : undefined,
                    sameOrigin ? input.upstreamHeaders : undefined
                ),
                redirect: 'error',
                signal: controller.signal
            },
            input.upstreamProxyUrl,
            pinnedDispatcher,
            {
                baseURL: input.apiBaseUrl,
                allowedPlainHttpBaseUrls
            }
        );
        if (!response.ok) {
            throw new RemoteImageResultError(`下载上游图片失败：HTTP ${response.status}。`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().startsWith('image/')) {
            throw new RemoteImageResultError('下载上游图片失败：响应不是图片类型。');
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > MAX_REMOTE_IMAGE_BYTES) {
            throw new RemoteImageResultError('下载上游图片失败：图片超过 25 MB 限制。');
        }
        const buffer = await readBoundedResponseBody(response);
        if (buffer.length === 0) {
            throw new RemoteImageResultError('下载上游图片失败：图片为空。');
        }
        return buffer.toString('base64');
    } catch (error) {
        if (error instanceof RemoteImageResultError) throw error;
        if (error instanceof UpstreamResponseFormatError) {
            throw new RemoteImageResultError('下载上游图片失败：响应不是图片类型。');
        }
        if (controller.signal.aborted) {
            throw new RemoteImageResultError('下载上游图片失败：请求超时或已取消。');
        }
        throw new RemoteImageResultError('下载上游图片失败：网络请求失败。');
    } finally {
        await pinnedDispatcher?.close();
        clearTimeout(timeout);
        input.abortSignal?.removeEventListener('abort', abortListener);
    }
}

async function resolvePinnedRemoteHost(
    hostname: string,
    lookup: typeof dns.lookup,
    signal?: AbortSignal,
    allowSyntheticDns = false
) {
    const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
    const literalFamily = net.isIP(normalizedHostname);
    if (literalFamily) {
        if (!isPublicIp(normalizedHostname)) {
            throw new RemoteImageResultError('上游图片 URL 解析到了被禁止的本地或内网地址。');
        }
        return createPinnedDnsDispatcher([{ address: normalizedHostname, family: literalFamily }]);
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await lookupWithAbort(lookup, normalizedHostname, signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new RemoteImageResultError('上游图片 URL 主机无法解析，已拒绝下载。');
    }
    const safeAddresses = addresses.filter(
        ({ address }) => isPublicIp(address) || (allowSyntheticDns && isSyntheticDnsIpAddress(address))
    );
    if (addresses.length === 0 || safeAddresses.length !== addresses.length) {
        throw new RemoteImageResultError('上游图片 URL 解析到了被禁止的本地或内网地址。');
    }
    return createPinnedDnsDispatcher(safeAddresses);
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

function isPublicIp(address: string): boolean {
    return isPublicIpAddress(address);
}

function buildDownloadHeaders(
    apiKey: string | undefined,
    upstreamHeaders: UpstreamRequestHeaders | undefined
): UpstreamRequestHeaders | undefined {
    const headers = mergeUpstreamHeadersWithFixed(upstreamHeaders, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    return Object.keys(headers).length > 0 ? headers : undefined;
}

async function readBoundedResponseBody(response: Response): Promise<Buffer> {
    if (!response.body) {
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > MAX_REMOTE_IMAGE_BYTES) {
            throw new RemoteImageResultError('下载上游图片失败：图片超过 25 MB 限制。');
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
            throw new RemoteImageResultError('下载上游图片失败：图片超过 25 MB 限制。');
        }
        return buffer;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_REMOTE_IMAGE_BYTES) {
                await reader.cancel();
                throw new RemoteImageResultError('下载上游图片失败：图片超过 25 MB 限制。');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes
    );
}

export function assertRemoteImageResultSafety(apiBaseUrl: string | undefined, imageUrl: string): void {
    try {
        resolveRemoteImageUrl(imageUrl, apiBaseUrl);
    } catch (error) {
        if (error instanceof RemoteImageResultError) throw error;
        throw new RequestValidationError('上游图片 URL 无效。', 502);
    }
}

function isBlockedRemoteHostname(hostname: string): boolean {
    const host = hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true;
    if (net.isIP(host)) return !isPublicIpAddress(host);
    if (
        host === '::1' ||
        host === '0:0:0:0:0:0:0:1' ||
        host.startsWith('127.') ||
        host.startsWith('169.254.') ||
        host === '::' ||
        host === '0:0:0:0:0:0:0:0'
    )
        return true;
    const mappedIpv4 = host.match(/^::ffff:(?:0:0:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4 && isBlockedRemoteHostname(mappedIpv4[1])) return true;
    if (host.includes(':')) return isPrivateIpv6(host);
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    return !isPublicIpAddress(host);
}

function isPrivateIpv6(host: string): boolean {
    return !isPublicIpAddress(host);
}
