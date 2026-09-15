import { buildAgentModelDirectory, probeAgentModelDirectory } from './agent-model-directory';
import { closeOpenAIImageTransportResources } from './openai-image-transport';
import assert from 'node:assert/strict';
import { after, afterEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const publicLookup = (async () => [
    { address: '93.184.216.34', family: 4 }
]) as unknown as typeof import('node:dns/promises').lookup;
const loopbackLookup = (async () => [
    { address: '127.0.0.1', family: 4 }
]) as unknown as typeof import('node:dns/promises').lookup;
const syntheticDnsLookup = (async () => [
    { address: '198.18.1.24', family: 4 }
]) as unknown as typeof import('node:dns/promises').lookup;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

after(async () => {
    await closeOpenAIImageTransportResources();
});

describe('agent model directory', () => {
    it('keeps configured channel model allowlists on channel entries', () => {
        const directory = buildAgentModelDirectory({
            OPENAI_CHANNEL_1_ID: 'images',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'key',
            OPENAI_CHANNEL_1_MODELS: 'gpt-image-2-1k, custom-image'
        });
        assert.deepEqual(directory.channels[0].models, ['gpt-image-2-1k', 'custom-image']);
    });

    it('does not mark a shared channel as fully allowlisted when one credential is unrestricted', () => {
        const directory = buildAgentModelDirectory({
            OPENAI_CHANNEL_1_ID: 'images',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'restricted-key',
            OPENAI_CHANNEL_1_MODELS: 'custom-image',
            OPENAI_CHANNEL_2_ID: 'images',
            OPENAI_CHANNEL_2_BASE_URL: 'https://images.example/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'unrestricted-key'
        });

        assert.equal(directory.channels[0]?.model_allowlist_configured, false);
        assert.equal(directory.channels[0]?.model_allowlist_state, 'mixed');
        assert.deepEqual(directory.channels[0]?.declared_models, ['custom-image']);
    });

    it('filters probed models to the configured channel allowlist', async () => {
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({ data: [{ id: 'gpt-image-2-1k' }, { id: 'chat-model' }, { id: 'custom-image' }] }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key',
                OPENAI_CHANNEL_1_MODELS: 'gpt-image-2-1k, custom-image'
            },
            { lookup: publicLookup }
        );
        assert.deepEqual(directory.channels[0].models, ['custom-image', 'gpt-image-2-1k']);
        assert.equal(directory.channels[0].models.includes('chat-model'), false);
        assert.equal(directory.known_models.find((entry) => entry.id === 'custom-image')?.status, 'verified_usable');
    });

    it('uses channel headers and proxy while probing models', async () => {
        const requests: Array<{ headers: Headers }> = [];
        globalThis.fetch = async (_input, init) => {
            requests.push({ headers: new Headers(init?.headers) });
            return new Response(JSON.stringify({ data: [{ id: 'custom-image' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key',
                OPENAI_CHANNEL_1_PROXY_URL: 'http://proxy.example:8080',
                OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON: '{"X-App-ID":"app-id"}'
            },
            { lookup: publicLookup }
        );
        assert.equal(directory.channels[0].probe_status, 'ok');
        assert.equal(requests[0]?.headers.get('Authorization'), 'Bearer key');
        assert.equal(requests[0]?.headers.get('X-App-ID'), 'app-id');
    });

    it('probes an explicitly allowed plain HTTP channel', async () => {
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'custom-image' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'local-images',
                OPENAI_CHANNEL_1_BASE_URL: 'http://127.0.0.1:4783/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key',
                OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS: 'http://127.0.0.1:4783/v1'
            },
            { lookup: loopbackLookup }
        );
        assert.equal(directory.channels[0]?.probe_status, 'ok');
    });

    it('probes IPv4-mapped loopback HTTP channels', async () => {
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'custom-image' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'local-images',
                OPENAI_CHANNEL_1_BASE_URL: 'http://[::ffff:7f00:1]:4783/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key'
            },
            { lookup: publicLookup }
        );
        assert.equal(directory.channels[0]?.probe_status, 'ok');
    });

    it('rejects HTTPS channels whose DNS resolves to a private address', async () => {
        let fetchCalled = false;
        globalThis.fetch = async () => {
            fetchCalled = true;
            throw new Error('fetch must not run for a private DNS result');
        };
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://private.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key'
            },
            {
                lookup: (async () => [
                    { address: '10.0.0.8', family: 4 }
                ]) as unknown as typeof import('node:dns/promises').lookup
            }
        );
        assert.equal(fetchCalled, false);
        assert.equal(directory.channels[0]?.probe_status, 'failed');
        assert.equal(directory.channels[0]?.error_code, 'request_failed');
    });

    it('allows synthetic DNS answers only with explicit opt-in', async () => {
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'custom-image' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });

        const baseEnv = {
            OPENAI_CHANNEL_1_ID: 'images',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'key'
        };
        const disabled = await probeAgentModelDirectory(baseEnv, { lookup: syntheticDnsLookup });
        assert.equal(disabled.channels[0]?.probe_status, 'failed');
        assert.equal(disabled.channels[0]?.error_code, 'request_failed');

        const enabled = await probeAgentModelDirectory(
            { ...baseEnv, OPENAI_ALLOW_SYNTHETIC_DNS_IPS: 'true' },
            { lookup: syntheticDnsLookup }
        );
        assert.equal(enabled.channels[0]?.probe_status, 'ok');
        assert.deepEqual(enabled.channels[0]?.models, ['custom-image']);

        const literal = await probeAgentModelDirectory(
            { ...baseEnv, OPENAI_CHANNEL_1_BASE_URL: 'https://198.18.1.24/v1', OPENAI_ALLOW_SYNTHETIC_DNS_IPS: 'true' },
            { lookup: syntheticDnsLookup }
        );
        assert.equal(literal.channels[0]?.probe_status, 'failed');
        assert.equal(literal.channels[0]?.error_code, 'request_failed');
    });

    it('keeps custom model metadata generic', () => {
        const directory = buildAgentModelDirectory({
            OPENAI_CHANNEL_1_ID: 'images',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'key',
            OPENAI_CHANNEL_1_MODELS: 'nai-diffusion-4-5-full'
        });
        assert.deepEqual(
            directory.known_models.find((entry) => entry.id === 'nai-diffusion-4-5-full'),
            {
                id: 'nai-diffusion-4-5-full',
                source: 'configured',
                custom: true,
                status: 'declared',
                size_policy: 'provider_defined',
                strict_dimensions: false
            }
        );
    });

    it('keeps both gpt-image-2 aliases on provider-defined sizing', () => {
        const directory = buildAgentModelDirectory({ OPENAI_IMAGE_MODEL: 'gpt-image-2-1k' });
        assert.equal(
            directory.known_models.find((entry) => entry.id === 'gpt-image-2')?.size_policy,
            'provider_defined'
        );
        assert.equal(
            directory.known_models.find((entry) => entry.id === 'gpt-image-2-1k')?.size_policy,
            'provider_defined'
        );
        assert.equal(
            directory.known_models.find((entry) => entry.id === 'gpt-image-1')?.size_policy,
            'legacy_allowlist'
        );
    });

    it('derives the configured legacy default model size policy', () => {
        const directory = buildAgentModelDirectory({ OPENAI_IMAGE_MODEL: 'gpt-image-1' });
        assert.deepEqual(directory.known_models[0], {
            id: 'gpt-image-1',
            source: 'project_default',
            custom: false,
            status: 'declared',
            size_policy: 'legacy_allowlist',
            strict_dimensions: false
        });
    });

    it('rejects oversized model probe responses', async () => {
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'custom-image' }], padding: 'x'.repeat(1024 * 1024) }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key'
            },
            { lookup: publicLookup }
        );
        assert.equal(directory.channels[0]?.probe_status, 'failed');
        assert.equal(directory.channels[0]?.error_code, 'invalid_response');
    });

    it('uses a later valid credential when an earlier credential cannot be probed', async () => {
        const requests: string[] = [];
        globalThis.fetch = async (input) => {
            requests.push(String(input));
            if (requests.length === 1) return new Response('upstream failure', { status: 503 });
            return new Response(JSON.stringify({ data: [{ id: 'custom-image' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'first-key,second-key'
            },
            { lookup: publicLookup }
        );

        assert.equal(directory.channels[0]?.probe_status, 'ok');
        assert.equal(directory.channels[0]?.configured, true);
        assert.equal(directory.channels[0]?.host, 'images.example');
        assert.deepEqual(directory.channels[0]?.models, ['custom-image']);
        assert.equal(requests.length, 2);
    });

    it('merges models discovered by multiple credentials in one channel', async () => {
        let requestCount = 0;
        globalThis.fetch = async () => {
            requestCount += 1;
            return new Response(
                JSON.stringify({ data: [{ id: requestCount === 1 ? 'first-model' : 'second-model' }] }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        };
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'first-key,second-key'
            },
            { lookup: publicLookup }
        );

        assert.deepEqual(directory.channels[0]?.models, ['first-model', 'second-model']);
        assert.equal(directory.channels[0]?.probe_status, 'ok');
        assert.equal(requestCount, 2);
    });

    it('keeps the configured allowlist visible when probing returns no matching models', async () => {
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key',
                OPENAI_CHANNEL_1_MODELS: 'configured-image'
            },
            { lookup: publicLookup }
        );

        assert.deepEqual(directory.channels[0]?.declared_models, ['configured-image']);
        assert.equal(directory.channels[0]?.model_allowlist_configured, true);
        assert.deepEqual(directory.channels[0]?.models, []);
        assert.equal(directory.channels[0]?.probe_status, 'ok');
    });

    it('bounds model probe bodies without relying on Content-Length', async () => {
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"data":['));
                        controller.enqueue(new Uint8Array(1024 * 1024));
                        controller.close();
                    }
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        const directory = await probeAgentModelDirectory(
            {
                OPENAI_CHANNEL_1_ID: 'images',
                OPENAI_CHANNEL_1_BASE_URL: 'https://images.example/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'key'
            },
            { lookup: publicLookup }
        );

        assert.equal(directory.channels[0]?.probe_status, 'failed');
        assert.equal(directory.channels[0]?.error_code, 'invalid_response');
    });
});
