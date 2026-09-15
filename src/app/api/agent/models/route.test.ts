import { resolveModelDirectoryOptions } from '@/lib/model-directory-options';
import { createAccessToken } from '@/lib/server-runtime';
import { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.AGENT_API_TOKEN;
    delete process.env.APP_PASSWORD;
    delete process.env.OPENAI_CHANNEL_1_BASE_URL;
    delete process.env.OPENAI_CHANNEL_1_API_KEYS;
    delete process.env.OPENAI_CHANNEL_1_ID;
    delete process.env.OPENAI_CHANNEL_1_MODELS;
    delete process.env.OPENAI_CHANNEL_2_BASE_URL;
    delete process.env.OPENAI_CHANNEL_2_API_KEYS;
    delete process.env.OPENAI_CHANNEL_2_ID;
    delete process.env.OPENAI_CHANNEL_2_MODELS;
    delete process.env.OPENAI_TUN_MODE;
    delete process.env.OPENAI_ALLOW_SYNTHETIC_DNS_IPS;
});

afterEach(() => {
    process.env = originalEnv;
});

describe('GET /api/agent/models', { concurrency: false }, () => {
    it('allows a redacted declaration directory on an unauthenticated local instance', async () => {
        const { GET } = await import('./route');

        process.env.OPENAI_CHANNEL_1_ID = 'images';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'key';
        const response = await GET(new NextRequest('http://localhost/api/agent/models'));
        const body = (await response.json()) as {
            ok: boolean;
            probe: { requested: boolean };
            channels: Array<{
                id?: string;
                host?: string;
                declared_models?: string[];
                model_allowlist_configured?: boolean;
                probe_status?: string;
            }>;
        };

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.probe.requested, false);
        assert.equal(body.channels[0]?.id, 'channel-1');
        assert.equal(body.channels[0]?.host, undefined);
        assert.deepEqual(body.channels[0]?.declared_models, []);
        assert.equal(body.channels[0]?.model_allowlist_configured, false);
        assert.equal(body.channels[0]?.probe_status, 'not_probed');
    });

    it('does not disclose allowlist state in an unauthenticated declaration directory', async () => {
        const { GET } = await import('./route');

        process.env.OPENAI_CHANNEL_1_ID = 'images';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'key';
        process.env.OPENAI_CHANNEL_1_MODELS = 'custom-image';
        const response = await GET(new NextRequest('http://localhost/api/agent/models'));
        const body = (await response.json()) as {
            channels: Array<{ model_allowlist_configured?: boolean; model_allowlist_state?: string }>;
        };

        assert.equal(response.status, 200);
        assert.equal(body.channels[0]?.model_allowlist_configured, false);
        assert.equal(body.channels[0]?.model_allowlist_state, undefined);
    });

    it('keeps generic models available for an anonymously redacted mixed channel', async () => {
        const { GET } = await import('./route');

        process.env.OPENAI_CHANNEL_1_ID = 'images';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'restricted-key';
        process.env.OPENAI_CHANNEL_1_MODELS = 'custom-image';
        process.env.OPENAI_CHANNEL_2_ID = 'images';
        process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'unrestricted-key';

        const response = await GET(new NextRequest('http://localhost/api/agent/models'));
        const body = (await response.json()) as Parameters<typeof resolveModelDirectoryOptions>[0] & {
            channels?: Array<{ models?: string[]; model_allowlist_state?: string }>;
        };

        assert.equal(response.status, 200);
        assert.equal(body.channels?.[0]?.model_allowlist_state, 'redacted');
        assert.ok(body.channels?.[0]?.models?.includes('custom-image'));
        const options = resolveModelDirectoryOptions(body);
        assert.ok(options.includes('gpt-image-2'));
        assert.ok(options.includes('custom-image'));
    });

    it('rejects active probing on an unauthenticated instance', async () => {
        const { GET } = await import('./route');
        const response = await GET(new NextRequest('http://localhost/api/agent/models?probe=true'));
        const body = (await response.json()) as { error: { code: string } };

        assert.equal(response.status, 401);
        assert.equal(body.error.code, 'unauthorized');
    });

    it('keeps probing protected when an Agent token is configured', async () => {
        process.env.AGENT_API_TOKEN = 'models-test-token';
        const { GET } = await import('./route');

        const response = await GET(new NextRequest('http://localhost/api/agent/models?probe=true'));
        const body = (await response.json()) as { error: { code: string } };

        assert.equal(response.status, 401);
        assert.equal(body.error.code, 'unauthorized');
    });

    it('returns a redacted declaration directory without Agent auth', async () => {
        process.env.AGENT_API_TOKEN = 'models-test-token';
        process.env.OPENAI_CHANNEL_1_ID = 'images';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'key';
        const { GET } = await import('./route');
        const response = await GET(new NextRequest('http://localhost/api/agent/models'));
        const body = (await response.json()) as { channels: Array<{ id?: string; host?: string }> };
        assert.equal(response.status, 200);
        assert.equal(body.channels[0]?.id, 'channel-1');
        assert.equal(body.channels[0]?.host, undefined);
    });

    it('returns the full declaration directory with a valid Agent token', async () => {
        process.env.AGENT_API_TOKEN = 'models-test-token';
        process.env.OPENAI_CHANNEL_1_ID = 'images';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://images.example/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'key';
        const { GET } = await import('./route');
        const response = await GET(
            new NextRequest('http://localhost/api/agent/models', {
                headers: { Authorization: 'Bearer models-test-token' }
            })
        );
        const body = (await response.json()) as { channels: Array<{ id?: string; host?: string }> };
        assert.equal(response.status, 200);
        assert.equal(body.channels[0]?.id, 'images');
        assert.equal(body.channels[0]?.host, 'images.example');
    });

    it('accepts an authenticated page access cookie for browser probing', async () => {
        process.env.APP_PASSWORD = 'models-page-password';
        const { GET } = await import('./route');
        const response = await GET(
            new NextRequest('http://localhost/api/agent/models?probe=true', {
                headers: { Cookie: `gptImageAccess=${createAccessToken('models-page-password')}` }
            })
        );
        assert.equal(response.status, 200);
    });

    it('accepts the authenticated page cookie when both Agent and page auth are configured', async () => {
        process.env.AGENT_API_TOKEN = 'models-agent-token';
        process.env.APP_PASSWORD = 'models-page-password';
        const { GET } = await import('./route');
        const response = await GET(
            new NextRequest('http://localhost/api/agent/models?probe=true', {
                headers: { Cookie: `gptImageAccess=${createAccessToken('models-page-password')}` }
            })
        );
        assert.equal(response.status, 200);
    });
});
