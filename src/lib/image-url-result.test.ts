import { downloadSameOriginImageAsBase64 } from './image-url-result';
import { closeOpenAIImageTransportResources, UpstreamResponseFormatError } from './openai-image-transport';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

afterEach(async () => {
    await closeOpenAIImageTransportResources();
});

describe('downloadSameOriginImageAsBase64', () => {
    it('downloads HTTPS images from a different public origin', async () => {
        let observedUrl = '';
        let observedAuthorization: string | null = null;
        globalThis.fetch = async (url, init) => {
            observedUrl = String(url);
            observedAuthorization = new Headers(init?.headers).get('authorization');
            return new Response(Buffer.from('png'), {
                status: 200,
                headers: { 'content-type': 'image/webp' }
            });
        };

        const result = await downloadSameOriginImageAsBase64({
            imageUrl: 'https://example.com/result.webp',
            apiBaseUrl: 'https://api.example.test/v1',
            apiKey: 'must-not-leak',
            lookup: (async () => [
                { address: '93.184.216.34', family: 4 }
            ]) as unknown as typeof import('node:dns/promises').lookup
        });

        assert.equal(result, Buffer.from('png').toString('base64'));
        assert.equal(observedUrl, 'https://example.com/result.webp');
        assert.equal(observedAuthorization, null);
    });

    it('supports public IPv6 literal image hosts without a DNS lookup', async () => {
        let lookupCalled = false;
        globalThis.fetch = async (_url, init) => {
            assert.ok(init && 'dispatcher' in init && init.dispatcher);
            return new Response(Buffer.from('png'), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        };

        const result = await downloadSameOriginImageAsBase64({
            imageUrl: 'https://[2001:4860:4860::8888]/result.png',
            apiBaseUrl: 'https://api.example.test/v1',
            lookup: (async () => {
                lookupCalled = true;
                return [];
            }) as unknown as typeof import('node:dns/promises').lookup
        });

        assert.equal(result, Buffer.from('png').toString('base64'));
        assert.equal(lookupCalled, false);
    });

    it('rejects cross-origin plaintext HTTP and private hosts', async () => {
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'http://images.example.test/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /HTTPS/
        );
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://127.0.0.1/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://mapped-private.example/result.png',
                    apiBaseUrl: 'https://api.example.test/v1',
                    lookup: (async () => [
                        { address: '::ffff:172.16.0.1', family: 6 },
                        { address: '::ffff:169.254.169.254', family: 6 }
                    ]) as unknown as typeof import('node:dns/promises').lookup
                }),
            /禁止的本地或内网/
        );
    });

    it('rejects synthetic DNS addresses for cross-origin result URLs', async () => {
        const input = {
            imageUrl: 'https://cdn.example.com/result.png',
            apiBaseUrl: 'https://api.example.test/v1',
            lookup: (async () => [
                { address: '198.18.0.1', family: 4 }
            ]) as unknown as typeof import('node:dns/promises').lookup
        };
        await assert.rejects(() => downloadSameOriginImageAsBase64(input), /禁止的本地或内网/);
    });

    it('does not inherit deployment synthetic DNS mode for remote result URLs', async () => {
        const previousTunMode = process.env.OPENAI_TUN_MODE;
        process.env.OPENAI_TUN_MODE = 'synthetic-dns';
        try {
            await assert.rejects(
                () =>
                    downloadSameOriginImageAsBase64({
                        imageUrl: 'https://cdn.example.com/result.png',
                        apiBaseUrl: 'https://api.example.test/v1',
                        lookup: (async () => [
                            { address: '198.18.0.1', family: 4 }
                        ]) as unknown as typeof import('node:dns/promises').lookup
                    }),
                /禁止的本地或内网/
            );
        } finally {
            if (previousTunMode === undefined) delete process.env.OPENAI_TUN_MODE;
            else process.env.OPENAI_TUN_MODE = previousTunMode;
        }
    });

    it('honors an already-aborted request before performing DNS resolution', async () => {
        const controller = new AbortController();
        controller.abort();
        let lookupCalled = false;

        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://example.com/result.png',
                    apiBaseUrl: 'https://api.example.test/v1',
                    abortSignal: controller.signal,
                    lookup: (async () => {
                        lookupCalled = true;
                        return [{ address: '93.184.216.34', family: 4 }];
                    }) as unknown as typeof import('node:dns/promises').lookup
                }),
            /超时或已取消/
        );
        assert.equal(lookupCalled, false);
    });

    it('rejects NAT64 addresses that map to private IPv4 networks', async () => {
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://[64:ff9b::c0a8:101]/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /本地或内网地址/
        );
    });

    it('rejects deprecated site-local IPv6 and 6to4 relay ranges', async () => {
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://[fec0::1]/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://192.88.99.1/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
    });

    it('rejects every address in the reserved 192.0.0.0/24 range', async () => {
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://192.0.0.1/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
    });

    it('rejects IPv4-compatible private IPv6 and multicast targets', async () => {
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://[::c0a8:101]/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: 'https://[ff02::1]/result.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /禁止的本地或内网/
        );
    });

    it('rejects site-local remainder, 6to4 private mappings, and translated IPv4 targets', async () => {
        for (const imageUrl of [
            'https://[fed0::1]/result.png',
            'https://[2002:c0a8:0101::]/result.png',
            'https://[::ffff:0:7f00:1]/result.png',
            'https://[0:0:0:0:0:ffff:ac10:1]/result.png',
            'https://[0:0:0:0:ffff:0:c000:201]/result.png'
        ]) {
            await assert.rejects(
                () => downloadSameOriginImageAsBase64({ imageUrl, apiBaseUrl: 'https://api.example.test/v1' }),
                /禁止的本地或内网/
            );
        }
    });

    it('passes authorization and upstream headers to same-origin image downloads', async () => {
        let observedAuthorization: string | null = null;
        let observedUserAgent: string | null = null;
        let observedAppId: string | null = null;
        let observedAppSecret: string | null = null;
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            observedAuthorization = headers.get('authorization');
            observedUserAgent = headers.get('user-agent');
            observedAppId = headers.get('x-app-id');
            observedAppSecret = headers.get('x-app-secret');
            return new Response(Buffer.from('png'), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        };

        const result = await downloadSameOriginImageAsBase64({
            imageUrl: '/generated/final.png',
            apiBaseUrl: 'https://api.example.test/v1',
            apiKey: 'test-key',
            upstreamHeaders: {
                Authorization: 'Bearer wrong-key',
                'X-App-ID': 'app-id',
                'X-App-Secret': 'app-secret'
            }
        });

        assert.equal(result, Buffer.from('png').toString('base64'));
        assert.equal(observedAuthorization, 'Bearer test-key');
        assert.equal(observedUserAgent, 'visual-journal/2.3.0');
        assert.equal(observedAppId, 'app-id');
        assert.equal(observedAppSecret, 'app-secret');
    });

    it('uses the shared header policy when the image download has no API key', async () => {
        let observedProxyAuthorization: string | null = null;
        let observedUserAgent: string | null = null;
        let observedAppId: string | null = null;
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            observedProxyAuthorization = headers.get('proxy-authorization');
            observedUserAgent = headers.get('user-agent');
            observedAppId = headers.get('x-app-id');
            return new Response(Buffer.from('png'), {
                status: 200,
                headers: { 'content-type': 'image/png' }
            });
        };

        await downloadSameOriginImageAsBase64({
            imageUrl: '/generated/final.png',
            apiBaseUrl: 'https://api.example.test/v1',
            upstreamHeaders: {
                'Proxy-Authorization': 'Basic c2VjcmV0',
                'X-App-ID': 'app-id'
            }
        });

        assert.equal(observedProxyAuthorization, null);
        assert.equal(observedUserAgent, 'visual-journal/2.3.0');
        assert.equal(observedAppId, 'app-id');
    });

    it('enforces the remote image size limit when fetch returns no stream body', async () => {
        let arrayBufferRead = false;
        globalThis.fetch = async () =>
            ({
                ok: true,
                headers: new Headers({ 'content-type': 'image/png' }),
                body: null,
                arrayBuffer: async () => {
                    arrayBufferRead = true;
                    return new Uint8Array(25 * 1024 * 1024 + 1).buffer;
                }
            }) as Response;

        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: '/generated/final.png',
                    apiBaseUrl: 'https://api.example.test/v1',
                    apiKey: 'test-key'
                }),
            /25 MB/
        );
        assert.equal(arrayBufferRead, true);
    });

    it('rejects oversized non-streaming downloads from content-length before buffering', async () => {
        let arrayBufferRead = false;
        globalThis.fetch = async () =>
            ({
                ok: true,
                headers: new Headers({
                    'content-type': 'image/png',
                    'content-length': String(25 * 1024 * 1024 + 1)
                }),
                body: null,
                arrayBuffer: async () => {
                    arrayBufferRead = true;
                    return new Uint8Array(1).buffer;
                }
            }) as Response;

        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: '/generated/final.png',
                    apiBaseUrl: 'https://api.example.test/v1',
                    apiKey: 'test-key'
                }),
            /25 MB/
        );
        assert.equal(arrayBufferRead, false);
    });

    it('keeps HTML artifact responses in the image-result error category', async () => {
        globalThis.fetch = async () => {
            throw new UpstreamResponseFormatError({
                upstreamStatus: 200,
                contentType: 'text/html',
                headers: new Headers({ 'content-type': 'text/html' })
            });
        };

        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: '/generated/final.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /响应不是图片类型/
        );
    });

    it('cancels streaming downloads as soon as the size limit is exceeded', async () => {
        let cancelled = false;
        globalThis.fetch = async () =>
            ({
                ok: true,
                headers: new Headers({ 'content-type': 'image/png' }),
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1));
                    },
                    cancel() {
                        cancelled = true;
                    }
                })
            }) as Response;

        await assert.rejects(
            () =>
                downloadSameOriginImageAsBase64({
                    imageUrl: '/generated/final.png',
                    apiBaseUrl: 'https://api.example.test/v1'
                }),
            /25 MB/
        );
        assert.equal(cancelled, true);
    });
});
