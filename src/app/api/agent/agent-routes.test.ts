import type { AgentErrorCode } from '@/lib/api-error-response';
import { isFeedbackStateStore } from '@/lib/feedback-store';
import { cleanupExpiredWebuiImages } from '@/lib/webui-image-cleanup';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import http from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { Pool } from 'pg';

const PNG_BASE64 = createPngWithDimensions(1024, 1024, 0x40).toString('base64');
const PNG_CONVERTIBLE_BASE64 = createPngWithDimensions(1024, 1024, 0xa0).toString('base64');
const PNG_LANDSCAPE_BASE64 = createPngWithDimensions(3, 2, 0x80).toString('base64');

let originalEnv: NodeJS.ProcessEnv;
let originalCwd = '';
let tempDir = '';

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv) {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(snapshot)) {
        process.env[key] = value;
    }
}

function setPrimaryChannelRequestModes(requestModes: string) {
    process.env.OPENAI_UPSTREAM_REQUEST_MODES = requestModes;
}

beforeEach(async () => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-routes-'));
    process.chdir(tempDir);
    process.env.AGENT_STATE_BACKEND = 'sqlite';
    process.env.AGENT_SQLITE_PATH = path.join(tempDir, 'agent.sqlite');
    process.env.NEXT_PUBLIC_IMAGE_STORAGE_MODE = 'fs';
    for (const key of Object.keys(process.env)) {
        if (/^OPENAI_CHANNEL_\d+_/.test(key)) {
            delete process.env[key];
        }
    }
    delete process.env.APP_PASSWORD;
    delete process.env.AGENT_API_TOKEN;
    delete process.env.AGENT_PUBLIC_BASE_URL;
    delete process.env.AGENT_REQUEST_TTL_SECONDS;
    delete process.env.AGENT_ARTIFACT_SHARE_DEFAULT_EXPIRES_MINUTES;
    delete process.env.AGENT_ARTIFACT_SHARE_MAX_EXPIRES_MINUTES;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_BASE_URL;
    delete process.env.OPENAI_UPSTREAM_REQUEST_MODES;
    delete process.env.OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY;
    delete process.env.OPENAI_UPSTREAM_PROXY_URL;
    delete process.env.OPENAI_TUN_MODE;
    delete process.env.OPENAI_ALLOW_SYNTHETIC_DNS_IPS;
    delete process.env.OPENAI_UPSTREAM_USER_AGENT;
    delete process.env.UPSTREAM_USER_AGENT;
    delete process.env.OPENAI_CHANNEL_1_ID;
    delete process.env.OPENAI_CHANNEL_1_API_KEYS;
    delete process.env.OPENAI_CHANNEL_1_BASE_URL;
    delete process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE;
    delete process.env.OPENAI_CHANNEL_1_REQUEST_MODES;
    delete process.env.OPENAI_CHANNEL_1_REQUEST_MODE_PRIORITY;
    delete process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID;
    delete process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET;
    delete process.env.OPENAI_CHANNEL_1_USER_AGENT;
    delete process.env.OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON;
    delete process.env.OPENAI_CHANNEL_2_ID;
    delete process.env.OPENAI_CHANNEL_2_API_KEYS;
    delete process.env.OPENAI_CHANNEL_2_BASE_URL;
    delete process.env.OPENAI_CHANNEL_2_UPSTREAM_PROFILE;
    delete process.env.OPENAI_CHANNEL_2_REQUEST_MODES;
    delete process.env.OPENAI_CHANNEL_2_REQUEST_MODE_PRIORITY;
    delete process.env.OPENAI_CHANNEL_2_MATSCA_APP_ID;
    delete process.env.OPENAI_CHANNEL_2_MATSCA_APP_SECRET;
    delete process.env.OPENAI_CHANNEL_2_USER_AGENT;
    delete process.env.OPENAI_CHANNEL_2_UPSTREAM_HEADERS_JSON;
    delete process.env.OPENAI_CHANNEL_RECOVERY_PROBE_ENABLED;
    delete process.env.OPENAI_CHANNEL_RECOVERY_PROBE_INTERVAL_MS;
    delete process.env.OPENAI_CHANNEL_RECOVERY_PROBE_TIMEOUT_MS;
    delete process.env.OPENAI_CHANNEL_RECOVERY_PROBE_MAX_PER_TICK;
    delete process.env.OPENAI_CHANNEL_REQUIRE_PROBE_FOR_RECOVERY;
    delete process.env.OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS;
});

afterEach(async () => {
    const { resetAgentStateStoreForTests, setAgentStateStoreFactoryForTests } =
        await import('@/lib/agent-state-runtime');
    const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
    restoreProcessEnv(originalEnv);
    process.chdir(originalCwd);
    setAgentStateStoreFactoryForTests(undefined);
    await resetAgentStateStoreForTests();
    resetServerChannelStateForTests();
    await rm(tempDir, { recursive: true, force: true });
});

describe('Agent route integration', () => {
    it('reports configured Agent auth without exposing secret values', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.AGENT_STATE_BACKEND = 'memory';
        process.env.AGENT_API_TOKEN = 'capability-token';
        process.env.APP_PASSWORD = 'page-access-code';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.auth.required, true);
        assert.deepEqual(body.auth.schemes, ['bearer']);
        assert.equal(JSON.stringify(body).includes('capability-token'), false);
        assert.equal(JSON.stringify(body).includes('page-access-code'), false);
        assert.equal(body.defaults.state_backend, 'memory');
    });

    it('does not report auth as required for blank Agent auth settings', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = '   ';
        process.env.APP_PASSWORD = '   ';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.auth.required, false);
        assert.deepEqual(body.auth.schemes, []);
    });

    it('reports deployed upstream profile limits in capabilities without exposing upstream secrets', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.OPENAI_CHANNEL_1_ID = 'matsca';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://img.matsca.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'sk-matsca-secret';
        process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID = 'matsca-app-id';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET = 'matsca-app-secret';
        process.env.OPENAI_CHANNEL_1_USER_AGENT = 'channel-agent-secret';
        process.env.OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON = JSON.stringify({
            'X-App-Secret': 'channel-header-secret',
            'X-Trace-Token': 'trace-token-secret'
        });
        process.env.OPENAI_UPSTREAM_USER_AGENT = 'global-agent-secret';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.upstream_profile.activeProfile, 'matsca');
        assert.deepEqual(body.limits.partial_images, { min: 0, max: 4 });
        assert.equal(body.limits.upload_images.max, 8);
        assert.equal(body.model_limits['gpt-image-2'].allow_transparent_background, true);
        assert.equal(body.upstream_request_headers.default.user_agent_effective, 'configured');
        assert.deepEqual(body.upstream_request_headers.channels, [
            {
                id: 'matsca',
                upstream_proxy: { configured: false },
                request_modes: ['images-non-stream'],
                request_mode_priority: ['images-non-stream'],
                request_headers: {
                    user_agent_effective: 'configured',
                    has_extra_headers: true,
                    allowed_header_names: ['user-agent', 'x-app-id', 'x-app-secret'],
                    configured_header_names: ['user-agent', 'x-app-id', 'x-app-secret', 'x-trace-token']
                },
                constraints: {
                    generate_images: { min: 1, max: 4 },
                    edit_images: { min: 1, max: 4 },
                    partial_images: { min: 0, max: 4 },
                    generate_images_by_backend: {
                        'images-api': { min: 1, max: 4 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    edit_images_by_backend: {
                        'images-api': { min: 1, max: 4 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    partial_images_by_backend: {
                        'images-api': { min: 0, max: 4 },
                        'responses-image-generation': { min: 1, max: 3 }
                    },
                    upload_images: { max: 8, max_single_mb: 10, max_total_mb: 80 },
                    gpt_image_2: { allow_transparent_background: true, size_policy: 'positive-integer' }
                }
            }
        ]);
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes('sk-matsca-secret'), false);
        assert.equal(serialized.includes('matsca-app-id'), false);
        assert.equal(serialized.includes('matsca-app-secret'), false);
        assert.equal(serialized.includes('channel-agent-secret'), false);
        assert.equal(serialized.includes('channel-header-secret'), false);
        assert.equal(serialized.includes('trace-token-secret'), false);
        assert.equal(serialized.includes('global-agent-secret'), false);
    });

    it('does not serialize configured base URLs or proxy hosts in public capabilities', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = 'https://private-upstream.example/v1';
        process.env.OPENAI_UPSTREAM_PROXY_URL = 'https://private-proxy.example:9443';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const serialized = JSON.stringify(await response.json());
        assert.equal(serialized.includes('private-upstream.example'), false);
        assert.equal(serialized.includes('private-proxy.example'), false);
        assert.equal(serialized.includes('9443'), false);
    });

    it('reports enabled Responses image backend from the deployed runtime environment', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.supported.enabled_image_backends, ['images-api', 'responses-image-generation']);
        assert.equal(body.supported.image_backend_requirements['responses-image-generation'].enabled, true);
        assert.deepEqual(body.supported.image_backend_requirements['responses-image-generation'].missing_env, []);
        assert.deepEqual(body.agent_streaming.upstream_sse.enabled_image_backends, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.deepEqual(body.agent_streaming.upstream_sse.request_fields_by_mode, {
            generate: ['image_backend', 'stream_mode', 'streaming_strategy', 'partial_images'],
            edit: ['stream_mode', 'streaming_strategy', 'partial_images']
        });
    });

    it('reports global request mode priority in deployed capabilities', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = 'https://upstream.example.com/v1';
        process.env.OPENAI_UPSTREAM_REQUEST_MODES = 'images-non-stream,images-sse';
        process.env.OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY = 'images-sse,images-non-stream';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.upstream_request_headers.channels, [
            {
                id: 'default',
                upstream_proxy: { configured: false },
                request_modes: ['images-non-stream', 'images-sse'],
                request_mode_priority: ['images-sse', 'images-non-stream'],
                request_headers: {
                    user_agent_effective: 'visual-journal/2.4.0',
                    has_extra_headers: false,
                    allowed_header_names: ['user-agent', 'x-app-id', 'x-app-secret'],
                    configured_header_names: []
                },
                constraints: {
                    generate_images: { min: 1, max: 10 },
                    edit_images: { min: 1, max: 10 },
                    partial_images: { min: 1, max: 3 },
                    generate_images_by_backend: {
                        'images-api': { min: 1, max: 10 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    edit_images_by_backend: {
                        'images-api': { min: 1, max: 10 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    partial_images_by_backend: {
                        'images-api': { min: 1, max: 3 },
                        'responses-image-generation': { min: 1, max: 3 }
                    },
                    upload_images: { max: 10, max_single_mb: 25 },
                    gpt_image_2: { allow_transparent_background: false, size_policy: 'openai-compatible' }
                }
            }
        ]);
    });

    it('reports global and per-channel upstream proxy summaries without exposing endpoints', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.OPENAI_UPSTREAM_PROXY_URL = 'https://global-proxy.integration.example:9443';
        process.env.OPENAI_CHANNEL_1_ID = 'primary';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://primary.example.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'primary-secret';
        process.env.OPENAI_CHANNEL_2_ID = 'backup';
        process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://backup.example.com/v1';
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'backup-secret';
        process.env.OPENAI_CHANNEL_2_PROXY_URL = 'http://channel-proxy.integration.example:8080';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.image_transport.upstream_proxy, { configured: true, protocol: 'https' });
        assert.deepEqual(
            body.upstream_request_headers.channels.map((channel: { id: string; upstream_proxy: unknown }) => ({
                id: channel.id,
                upstream_proxy: channel.upstream_proxy
            })),
            [
                { id: 'primary', upstream_proxy: { configured: true, protocol: 'https' } },
                { id: 'backup', upstream_proxy: { configured: true, protocol: 'http' } }
            ]
        );
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes('global-proxy.integration.example'), false);
        assert.equal(serialized.includes('channel-proxy.integration.example'), false);
        assert.equal(serialized.includes('9443'), false);
        assert.equal(serialized.includes('8080'), false);
        assert.equal(serialized.includes('primary-secret'), false);
        assert.equal(serialized.includes('backup-secret'), false);
    });

    it('registers cleanup-managed artifacts for every request mode', async () => {
        const { generateImage } = await loadAgentRoutes();
        const { getAgentStateStore } = await import('@/lib/agent-state-runtime');
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        process.env.AGENT_REQUEST_TTL_SECONDS = String(60 * 24 * 60 * 60);
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';

        const cases = [
            {
                mode: 'images-non-stream',
                startUpstream: () => startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] })),
                request: {
                    prompt: 'cleanup lifecycle images non stream',
                    stream_mode: 'non_stream',
                    streaming_strategy: 'off'
                }
            },
            {
                mode: 'images-sse',
                startUpstream: () =>
                    startStreamingImageUpstream(() => [
                        {
                            event: 'image_generation.completed',
                            data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                        }
                    ]),
                request: {
                    prompt: 'cleanup lifecycle images sse',
                    stream_mode: 'stream',
                    streaming_strategy: 'force-sse',
                    partial_images: 1
                }
            },
            {
                mode: 'responses-non-stream',
                startUpstream: () =>
                    startResponsesImageJsonUpstream(200, {
                        id: 'response-cleanup-json',
                        object: 'response',
                        status: 'completed',
                        output: [
                            {
                                id: 'image-cleanup-json',
                                type: 'image_generation_call',
                                status: 'completed',
                                result: PNG_BASE64
                            }
                        ]
                    }),
                request: {
                    prompt: 'cleanup lifecycle responses non stream',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'non_stream',
                    streaming_strategy: 'off'
                }
            },
            {
                mode: 'responses-sse',
                startUpstream: () =>
                    startStreamingResponsesImageUpstream(() => [
                        {
                            event: 'response.output_item.done',
                            data: {
                                type: 'response.output_item.done',
                                item: {
                                    id: 'image-cleanup-sse',
                                    type: 'image_generation_call',
                                    status: 'completed',
                                    result: PNG_BASE64
                                }
                            }
                        }
                    ]),
                request: {
                    prompt: 'cleanup lifecycle responses sse',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'stream',
                    streaming_strategy: 'responses-sse',
                    partial_images: 1
                }
            }
        ] as const;
        const artifacts: Array<{ id: string; filepath: string }> = [];

        for (const testCase of cases) {
            const upstream = await testCase.startUpstream();
            process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
            process.env.OPENAI_UPSTREAM_REQUEST_MODES = testCase.mode;
            process.env.ENABLE_RESPONSES_IMAGE_BACKEND = testCase.mode.startsWith('responses-') ? 'true' : 'false';
            resetServerChannelStateForTests();

            try {
                const response = await generateImage(
                    agentJsonRequest('cleanup-lifecycle-' + testCase.mode, testCase.request)
                );
                assert.equal(response.status, 200, testCase.mode);
                const body = await response.json();
                assert.equal(body.execution.channel_request_mode, testCase.mode);
                const artifactId = body.images[0].content_url.split('/').at(-2);
                assert.equal(typeof artifactId, 'string');
                const filepath = readStoredArtifactFilepath(artifactId);
                await access(filepath);
                artifacts.push({ id: artifactId, filepath });
            } finally {
                await upstream.close();
            }
        }

        const store = getAgentStateStore(process.env);
        const protectedPaths = await store.listArtifactFilepaths();
        assert.deepEqual(artifacts.map((artifact) => artifact.filepath).sort(), protectedPaths.sort());
        const cleanupNow = new Date();
        const expiredWebuiTime = new Date(cleanupNow.getTime() - 31 * 24 * 60 * 60 * 1000);
        await Promise.all(artifacts.map((artifact) => utimes(artifact.filepath, expiredWebuiTime, expiredWebuiTime)));

        const cleanupResult = await cleanupExpiredWebuiImages({
            outputDir: path.dirname(artifacts[0].filepath),
            retentionDays: 30,
            protectedArtifactFilepaths: protectedPaths,
            now: cleanupNow
        });

        assert.equal(cleanupResult.deletedCount, 0);
        assert.equal(cleanupResult.protectedCount, 4);
        await Promise.all(artifacts.map((artifact) => access(artifact.filepath)));

        const purged = await store.purgeExpiredRequests(
            new Date(cleanupNow.getTime() + 60 * 24 * 60 * 60 * 1000 + 1000)
        );
        assert.equal(purged, 4);
        for (const artifact of artifacts) {
            assert.equal(await store.getArtifact(artifact.id), undefined);
            await assert.rejects(() => access(artifact.filepath));
        }
    });

    it('reports Matsca channel limits from the deployed runtime environment without leaking secrets', async () => {
        const { getCapabilities } = await loadAgentRoutes();
        process.env.OPENAI_CHANNEL_1_ID = 'matsca';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://img.matsca.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'sk-matsca-secret';
        process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID = 'app-id-secret';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET = 'app-secret-value';
        process.env.OPENAI_CHANNEL_1_USER_AGENT = 'channel-agent-secret';
        process.env.OPENAI_CHANNEL_1_UPSTREAM_HEADERS_JSON = JSON.stringify({
            'X-App-Secret': 'channel-header-secret',
            'X-Trace-Token': 'trace-token-secret'
        });
        process.env.UPSTREAM_USER_AGENT = 'global-agent-secret';

        const response = await getCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.limits.max_images, 4);
        assert.equal(body.limits.upload_images.max, 8);
        assert.equal(body.limits.max_upload_mb, 10);
        assert.equal(body.limits.max_total_upload_mb, 80);
        assert.deepEqual(body.limits.partial_images, { min: 0, max: 4 });
        assert.equal(body.model_limits['gpt-image-2'].allow_transparent_background, true);
        assert.equal(body.model_limits['gpt-image-2'].size_policy, 'positive-integer');
        assert.equal(body.upstream_request_headers.default.user_agent_effective, 'configured');
        assert.deepEqual(body.upstream_request_headers.channels, [
            {
                id: 'matsca',
                upstream_proxy: { configured: false },
                request_modes: ['images-non-stream'],
                request_mode_priority: ['images-non-stream'],
                request_headers: {
                    user_agent_effective: 'configured',
                    has_extra_headers: true,
                    allowed_header_names: ['user-agent', 'x-app-id', 'x-app-secret'],
                    configured_header_names: ['user-agent', 'x-app-id', 'x-app-secret', 'x-trace-token']
                },
                constraints: {
                    generate_images: { min: 1, max: 4 },
                    edit_images: { min: 1, max: 4 },
                    partial_images: { min: 0, max: 4 },
                    generate_images_by_backend: {
                        'images-api': { min: 1, max: 4 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    edit_images_by_backend: {
                        'images-api': { min: 1, max: 4 },
                        'responses-image-generation': { min: 1, max: 1 }
                    },
                    partial_images_by_backend: {
                        'images-api': { min: 0, max: 4 },
                        'responses-image-generation': { min: 1, max: 3 }
                    },
                    upload_images: { max: 8, max_single_mb: 10, max_total_mb: 80 },
                    gpt_image_2: { allow_transparent_background: true, size_policy: 'positive-integer' }
                }
            }
        ]);
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes('sk-matsca-secret'), false);
        assert.equal(serialized.includes('app-id-secret'), false);
        assert.equal(serialized.includes('app-secret-value'), false);
        assert.equal(serialized.includes('channel-agent-secret'), false);
        assert.equal(serialized.includes('channel-header-secret'), false);
        assert.equal(serialized.includes('trace-token-secret'), false);
        assert.equal(serialized.includes('global-agent-secret'), false);
    });

    it('generates through a compatible upstream once and exposes request diagnostics for the same state record', async () => {
        const { generateImage, getAgentRequestDiagnostics, getArtifactContent, lookupAgentRequestDiagnostics } =
            await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return {
                data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const first = await generateImage(
                agentJsonRequest('route-cache-key', { prompt: 'agent route success', output_format: 'webp' })
            );
            assert.equal(first.status, 200);
            const firstBody = await first.json();
            assert.equal(firstBody.cached, false);
            assert.equal(firstBody.images.length, 1);
            assert.ok(firstBody.images[0].content_url);
            assert.equal('b64_json' in firstBody.images[0], false);
            assert.equal(firstBody.images[0].output_format, 'webp');
            assert.equal(firstBody.images[0].mime_type, 'image/webp');
            const artifactId = firstBody.images[0].content_url.split('/').at(-2);
            assert.equal(typeof artifactId, 'string');
            const artifactContent = await getArtifactContent(
                new Request(`http://localhost/api/agent/artifacts/${artifactId}/content`),
                { params: Promise.resolve({ id: artifactId }) }
            );
            assert.equal(artifactContent.status, 200);
            assert.equal(artifactContent.headers.get('content-type'), 'image/webp');
            assert.equal(Buffer.from(await artifactContent.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
            assert.equal(firstBody.execution.transport, 'agent_json');
            assert.equal(firstBody.execution.endpoint, '/api/agent/images/generate');
            assert.equal(firstBody.execution.route_mode, 'agent');
            assert.equal(firstBody.execution.operation, 'generate');
            assert.equal(firstBody.execution.image_backend, 'images-api');
            assert.equal(firstBody.execution.stream_mode, 'non_stream');
            assert.equal(firstBody.execution.streaming_strategy, 'auto');
            assert.equal(firstBody.execution.channel_request_mode, 'images-non-stream');
            assert.equal(firstBody.execution.channel_request_mode_fallback_applied, false);
            assert.deepEqual(firstBody.execution.route_decision, {
                requested_backend: 'images-api',
                candidate_channel_request_modes: ['images-non-stream'],
                request_mode_priority: ['images-non-stream'],
                preferred_channel_request_mode: 'images-non-stream',
                selected_channel_request_mode: 'images-non-stream',
                fallback_applied: false,
                selected_channel_id: 'default',
                upstream_host: new URL(upstream.baseUrl).host
            });
            assert.equal(firstBody.execution.upstream_host, new URL(upstream.baseUrl).host);
            assert.equal(firstBody.execution.request_headers.user_agent_effective, 'visual-journal/2.4.0');
            assert.equal(firstBody.execution.request_headers.has_extra_headers, false);
            assert.equal(typeof firstBody.timing.elapsed_ms, 'number');
            assert.equal(firstBody.timing.elapsed_ms >= 0, true);
            assert.equal(firstBody.timing.server_elapsed_ms, firstBody.timing.elapsed_ms);
            assert.equal(typeof firstBody.timing.started_at, 'string');
            assert.equal(typeof firstBody.timing.completed_at, 'string');

            const second = await generateImage(
                agentJsonRequest('route-cache-key', { prompt: 'agent route success', output_format: 'webp' })
            );
            assert.equal(second.status, 200);
            const secondBody = await second.json();
            assert.equal(secondBody.cached, true);
            assert.equal(second.headers.get('x-idempotent-replay'), 'true');
            assert.equal(second.headers.get('x-request-id'), firstBody.request_id);
            assert.equal(secondBody.request_id, firstBody.request_id);
            assert.deepEqual(secondBody.execution, firstBody.execution);
            assert.deepEqual(secondBody.timing, firstBody.timing);
            assert.equal(upstreamCalls, 1);

            const byRequestId = await getAgentRequestDiagnostics(
                new Request(`http://localhost/api/agent/diagnostics/requests/${firstBody.request_id}`),
                { params: Promise.resolve({ id: firstBody.request_id }) }
            );
            assert.equal(byRequestId.status, 200);
            const byRequestIdBody = await byRequestId.json();
            assert.equal(byRequestIdBody.found, true);
            assert.equal(byRequestIdBody.diagnostics.request.request_id, firstBody.request_id);
            assert.equal(byRequestIdBody.diagnostics.request.idempotency_key, 'route-cache-key');
            assert.equal(byRequestIdBody.diagnostics.request.status, 'succeeded');
            assert.equal(byRequestIdBody.diagnostics.response.image_count, 1);
            assert.deepEqual(byRequestIdBody.diagnostics.response.timing, firstBody.timing);
            assert.deepEqual(byRequestIdBody.diagnostics.response.execution, firstBody.execution);
            assert.deepEqual(byRequestIdBody.diagnostics.response.content_urls, [firstBody.images[0].content_url]);
            assert.equal(byRequestIdBody.diagnostics.artifacts[0].id, firstBody.images[0].id);
            assert.equal(byRequestIdBody.diagnostics.state_backend, 'sqlite');
            assert.equal(byRequestIdBody.diagnostics.diagnostics_retention.storage, 'agent_state');
            assert.equal(byRequestIdBody.diagnostics.diagnostics_boundary.not_page_request_log, true);
            assert.equal(JSON.stringify(byRequestIdBody).includes(PNG_BASE64), false);

            const byIdempotencyKey = await lookupAgentRequestDiagnostics(
                new Request('http://localhost/api/agent/diagnostics/requests?idempotency_key=route-cache-key')
            );
            assert.equal(byIdempotencyKey.status, 200);
            const byIdempotencyKeyBody = await byIdempotencyKey.json();
            assert.equal(byIdempotencyKeyBody.diagnostics.request.request_id, firstBody.request_id);
        } finally {
            await upstream.close();
        }
    });

    it('retries accepted async image tasks through Agent generate with the same upstream idempotency key', async () => {
        const { generateImage } = await loadAgentRoutes();
        const upstreamIdempotencyKeys: Array<string | undefined> = [];
        let upstreamCalls = 0;
        const upstream = await startImageUpstream((_body, _url, request, response) => {
            upstreamCalls += 1;
            const idempotencyKey = request.headers['idempotency-key'];
            upstreamIdempotencyKeys.push(Array.isArray(idempotencyKey) ? idempotencyKey.join(',') : idempotencyKey);
            if (upstreamCalls === 1) {
                response.setHeader('Retry-After', '1');
                return {
                    object: 'image.task',
                    status: 'pending',
                    task_id: 'agent-route-accepted-task',
                    poll_url: '/v1/image-tasks?ids=agent-route-accepted-task'
                };
            }
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await generateImage(
                agentJsonRequest('agent-route-accepted-task-key', {
                    prompt: 'agent route accepted task',
                    response_mode: 'base64'
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.cached, false);
            assert.equal(body.images[0].b64_json, PNG_BASE64);
            assert.deepEqual(upstreamIdempotencyKeys, [
                'agent-route-accepted-task-key',
                'agent-route-accepted-task-key'
            ]);
            assert.equal(upstreamCalls, 2);
        } finally {
            await upstream.close();
        }
    });

    it('keeps Agent request diagnostics available when feedback lookup fails', async () => {
        const { generateImage, getAgentRequestDiagnostics } = await loadAgentRoutes();
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const first = await generateImage(
                agentJsonRequest('route-feedback-diagnostics-key', { prompt: 'agent route success' })
            );
            assert.equal(first.status, 200);
            const firstBody = await first.json();
            const { ensureAgentStateStoreReady } = await import('@/lib/agent-state-runtime');
            const store = await ensureAgentStateStoreReady();
            if (!isFeedbackStateStore(store)) {
                assert.fail('Agent state store should expose feedback methods for this route test.');
            }
            const originalReadFeedback = store.readFeedback.bind(store);
            store.readFeedback = async () => {
                throw new Error('feedback store unavailable');
            };

            try {
                const response = await getAgentRequestDiagnostics(
                    new Request(`http://localhost/api/agent/diagnostics/requests/${firstBody.request_id}`),
                    { params: Promise.resolve({ id: firstBody.request_id }) }
                );
                assert.equal(response.status, 200);
                const body = await response.json();
                assert.equal(body.found, true);
                assert.equal(body.diagnostics.request.request_id, firstBody.request_id);
                assert.equal(body.diagnostics.response.image_count, 1);
                assert.equal(body.diagnostics.feedback, undefined);
            } finally {
                store.readFeedback = originalReadFeedback;
            }
        } finally {
            await upstream.close();
        }
    });

    it('rejects Agent generate image counts outside the selected Matsca profile before calling upstream', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'matsca';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'test-key';
        process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID = 'app-id';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET = 'app-secret';

        try {
            const response = await generateImage(
                agentJsonRequest('agent-matsca-n-limit-key', {
                    prompt: 'agent matsca n limit',
                    n: 5
                })
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.n, /1 到 4/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('routes mixed provider image counts to the channel that accepts the requested count', async () => {
        const { generateImage } = await loadAgentRoutes();
        let firstCalls = 0;
        let secondCalls = 0;
        const first = await startImageUpstream(() => {
            firstCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        const second = await startImageUpstream(() => {
            secondCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'fixed-one';
        process.env.OPENAI_CHANNEL_1_BASE_URL = first.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'first-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-one-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { generate_count: { min: 1, max: 1 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'fixed-two';
        process.env.OPENAI_CHANNEL_2_BASE_URL = second.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'second-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-two-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { generate_count: { min: 2, max: 2 } }
        });

        try {
            const twoImageResponse = await generateImage(
                agentJsonRequest('mixed-count-two-key', { prompt: 'mixed provider count two', n: 2 })
            );
            assert.equal(twoImageResponse.status, 200);
            const twoImageBody = await twoImageResponse.json();
            assert.equal(twoImageBody.execution.selected_channel_id, 'fixed-two');
            assert.equal(firstCalls, 0);
            assert.equal(secondCalls, 1);

            const oneImageResponse = await generateImage(
                agentJsonRequest('mixed-count-one-key', { prompt: 'mixed provider count one', n: 1 })
            );
            assert.equal(oneImageResponse.status, 200);
            const oneImageBody = await oneImageResponse.json();
            assert.equal(oneImageBody.execution.selected_channel_id, 'fixed-one');
            assert.equal(firstCalls, 1);
            assert.equal(secondCalls, 1);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it('fails explicitly when no mixed-channel provider accepts the requested count', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        const backup = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'fixed-one';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'first-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-one-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { generate_count: { min: 1, max: 1 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'fixed-three';
        process.env.OPENAI_CHANNEL_2_BASE_URL = backup.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'backup-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-three-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { generate_count: { min: 3, max: 3 } }
        });

        try {
            const response = await generateImage(
                agentJsonRequest('mixed-count-no-provider-key', { prompt: 'mixed provider count gap', n: 2 })
            );
            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.n, /以下整数之一：1, 3/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await Promise.all([upstream.close(), backup.close()]);
        }
    });

    it('routes automatic streaming to the mixed-channel credential that accepts partial_images', async () => {
        const { generateImage } = await loadAgentRoutes();
        let firstCalls = 0;
        let secondCalls = 0;
        const first = await startStreamingImageUpstream(() => {
            firstCalls += 1;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        const second = await startStreamingImageUpstream(() => {
            secondCalls += 1;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_ROUTING_STRATEGY = 'round_robin';
        process.env.OPENAI_CHANNEL_1_ID = 'stream-one';
        process.env.OPENAI_CHANNEL_1_BASE_URL = first.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'first-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'stream-one-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { partial_images: { min: 1, max: 1 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'stream-two';
        process.env.OPENAI_CHANNEL_2_BASE_URL = second.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'second-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'stream-two-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { partial_images: { min: 2, max: 2 } }
        });
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        try {
            const response = await generateImage(
                agentJsonRequest('mixed-stream-partial-two-key', {
                    prompt: 'mixed stream partial two',
                    stream_mode: 'auto',
                    streaming_strategy: 'auto',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.selected_channel_id, 'stream-two');
            assert.equal(firstCalls, 0);
            assert.equal(secondCalls, 1);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it('skips an Agent SSE channel marked unavailable during automatic routing', async () => {
        const { generateImage } = await loadAgentRoutes();
        let markedCalls = 0;
        let healthyCalls = 0;
        const marked = await startStreamingImageUpstream(() => {
            markedCalls += 1;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        const healthy = await startStreamingImageUpstream(() => {
            healthyCalls += 1;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_CHANNEL_1_ID = 'marked-agent-sse';
        process.env.OPENAI_CHANNEL_1_BASE_URL = marked.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'marked-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_2_ID = 'healthy-agent-sse';
        process.env.OPENAI_CHANNEL_2_BASE_URL = healthy.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'healthy-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
        const { getServerChannelState, resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        try {
            getServerChannelState().streamingAvailability.markUnavailable({
                channelId: 'marked-agent-sse',
                imageBackend: 'images-api',
                streamingStrategy: 'auto',
                operation: 'generate',
                reason: 'test_mark'
            });
            const response = await generateImage(
                agentJsonRequest('agent-marked-sse-key', {
                    prompt: 'skip marked Agent SSE channel',
                    stream_mode: 'auto',
                    streaming_strategy: 'auto'
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.selected_channel_id, 'healthy-agent-sse');
            assert.equal(markedCalls, 0);
            assert.equal(healthyCalls, 1);
        } finally {
            await Promise.all([marked.close(), healthy.close()]);
        }
    });

    it('chooses the n-compatible SSE channel when automatic partial_images is omitted', async () => {
        const { generateImage } = await loadAgentRoutes();
        let sseCalls = 0;
        const sse = await startStreamingImageUpstream(() => {
            sseCalls += 1;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_ROUTING_STRATEGY = 'round_robin';
        process.env.OPENAI_CHANNEL_1_ID = 'non-stream-count-two';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://non-stream.example.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'non-stream-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'non-stream-count-two-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { generate_count: { min: 2, max: 2 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'sse-count-one';
        process.env.OPENAI_CHANNEL_2_BASE_URL = sse.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'sse-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'sse-count-one-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: {
                generate_count: { min: 1, max: 1 },
                partial_images: { min: 3, max: 3 }
            }
        });
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        try {
            const response = await generateImage(
                agentJsonRequest('mixed-auto-omitted-partial-key', {
                    prompt: 'mixed automatic request without an explicit preview count',
                    n: 1,
                    stream_mode: 'auto',
                    streaming_strategy: 'auto'
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.selected_channel_id, 'sse-count-one');
            assert.equal(body.execution.channel_request_mode, 'images-sse');
            assert.equal(sseCalls, 1);
        } finally {
            await sse.close();
        }
    });

    it('does not send upstream stream parameters when Agent streaming_strategy is off', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamBody = body;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await generateImage(
                agentJsonRequest('agent-upstream-stream-off-key', {
                    prompt: 'agent upstream stream off',
                    streaming_strategy: 'off'
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.channel_request_mode, 'images-non-stream');
            assert.equal(body.execution.channel_request_mode_fallback_applied, false);
            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, false);
            assert.equal(Object.hasOwn(upstreamJson, 'partial_images'), false);
        } finally {
            await upstream.close();
        }
    });

    it('ignores Agent non-stream partial_images outside the provider preview range', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamBody = body;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'no-previews';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'test-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'no-previews-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/images/generations' } } },
            constraints: { partial_images: { min: 0, max: 0 } }
        });
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        try {
            const response = await generateImage(
                agentJsonRequest('agent-non-stream-ignored-partial-key', {
                    prompt: 'agent non-stream ignored partial images',
                    stream_mode: 'auto',
                    streaming_strategy: 'off',
                    partial_images: 2
                })
            );

            const responseBody = await response.json();
            assert.equal(response.status, 200, JSON.stringify(responseBody));
            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, false);
            assert.equal(Object.hasOwn(upstreamJson, 'partial_images'), false);
        } finally {
            await upstream.close();
        }
    });

    it('uses the lower-cost non-streaming channel request mode for Agent auto streaming by default', async () => {
        const { generateImage } = await loadAgentRoutes();
        const { getServerChannelState } = await import('@/lib/server-channel-router');
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamBody = body;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-non-stream,images-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-default-auto-stream-key', {
                    prompt: 'agent default auto stream',
                    stream_mode: 'auto'
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.images[0].content_url.startsWith('/api/agent/artifacts/'), true);
            assert.equal(body.execution.channel_request_mode, 'images-non-stream');
            assert.equal(body.execution.channel_request_mode_fallback_applied, false);
            assert.deepEqual(body.execution.route_decision.candidate_channel_request_modes, [
                'images-non-stream',
                'images-sse'
            ]);
            assert.deepEqual(body.execution.route_decision.request_mode_priority, ['images-non-stream', 'images-sse']);
            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, false);
            assert.equal(Object.hasOwn(upstreamJson, 'partial_images'), false);
            assert.equal(getServerChannelState().streamingAvailability.summary().mark_count, 0);
        } finally {
            await upstream.close();
        }
    });

    it('uses a non-streaming channel request mode when Agent auto streaming has no SSE channel', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamBody = body;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'json-only';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'test-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';

        try {
            const response = await generateImage(
                agentJsonRequest('agent-auto-json-channel-key', {
                    prompt: 'agent auto json channel',
                    stream_mode: 'auto'
                })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.channel_request_mode, 'images-non-stream');
            assert.equal(body.execution.channel_request_mode_fallback_applied, false);
            assert.deepEqual(body.execution.route_decision, {
                requested_backend: 'images-api',
                candidate_channel_request_modes: ['images-non-stream', 'images-sse'],
                request_mode_priority: ['images-non-stream'],
                preferred_channel_request_mode: 'images-non-stream',
                fallback_channel_request_mode: 'images-sse',
                selected_channel_request_mode: 'images-non-stream',
                fallback_applied: false,
                selected_channel_id: 'json-only',
                upstream_host: new URL(upstream.baseUrl).host
            });
            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, false);
            assert.equal(Object.hasOwn(upstreamJson, 'partial_images'), false);
        } finally {
            await upstream.close();
        }
    });

    it('fails explicit Agent stream requests instead of falling back to non-streaming request modes', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'json-only';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'test-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';

        try {
            const response = await generateImage(
                agentJsonRequest('agent-explicit-stream-no-sse-key', {
                    prompt: 'agent explicit stream no sse',
                    stream_mode: 'stream',
                    streaming_strategy: 'openai-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 503);
            const body = await response.json();
            assert.equal(body.error.code, 'configuration_error');
            assert.equal(body.error.diagnostics.channel_request_mode, 'images-sse');
            assert.equal(body.error.diagnostics.channel_request_mode_fallback_applied, false);
            assert.deepEqual(body.error.diagnostics.route_decision, {
                requested_backend: 'images-api',
                candidate_channel_request_modes: ['images-sse'],
                request_mode_priority: ['images-sse'],
                preferred_channel_request_mode: 'images-sse',
                selected_channel_request_mode: 'images-sse',
                fallback_applied: false,
                no_channel_reason:
                    '当前没有支持 images-sse 的健康渠道凭证。请调整请求策略或 OPENAI_CHANNEL_N_REQUEST_MODES。'
            });
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('rejects OpenAI-compatible Agent generate profile violations before calling upstream', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_PROFILE = 'openai-compatible';

        try {
            const response = await generateImage(
                agentJsonRequest('agent-generate-profile-violation-key', {
                    prompt: 'transparent object',
                    background: 'transparent',
                    partial_images: 0
                })
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('does not consume generate idempotency keys for local profile validation failures', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_PROFILE = 'openai-compatible';
        const idempotencyKey = 'agent-generate-profile-validation-key';

        try {
            const invalid = await generateImage(
                agentJsonRequest(idempotencyKey, {
                    prompt: 'transparent object',
                    background: 'transparent'
                })
            );

            assert.equal(invalid.status, 422);
            assert.equal(upstreamCalls, 0);

            const corrected = await generateImage(
                agentJsonRequest(idempotencyKey, {
                    prompt: 'transparent object',
                    background: 'auto'
                })
            );

            assert.equal(corrected.status, 200);
            assert.equal(upstreamCalls, 1);
            const body = await corrected.json();
            assert.equal(body.idempotency_key, idempotencyKey);
        } finally {
            await upstream.close();
        }
    });

    it('consumes upstream image SSE internally while keeping the Agent generate response non-streaming', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'image_generation.partial_image',
                    data: { type: 'image_generation.partial_image', b64_json: 'agent-partial-base64' }
                },
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-upstream-sse-key', {
                    prompt: 'agent upstream sse',
                    response_mode: 'base64',
                    streaming_strategy: 'newapi-keepalive-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.cached, false);
            assert.equal(body.images[0].b64_json, PNG_BASE64);

            const upstreamJson = JSON.parse(upstreamBody);
            assert.equal(upstreamJson.stream, true);
            assert.equal(upstreamJson.partial_images, 2);
        } finally {
            await upstream.close();
        }
    });

    it('consumes JSON Images responses returned to Agent stream requests as final results', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamBody = body;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-stream-json-fallback-key', {
                    prompt: 'agent stream json fallback',
                    response_mode: 'base64',
                    streaming_strategy: 'newapi-keepalive-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.images[0].b64_json, PNG_BASE64);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, true);
            assert.equal(upstreamJson.partial_images, 2);
        } finally {
            await upstream.close();
        }
    });

    it('uses force-sse for Agent upstream image SSE while keeping the final JSON contract', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-force-sse-key', {
                    prompt: 'agent force sse',
                    response_mode: 'base64',
                    streaming_strategy: 'force-sse',
                    partial_images: 3
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.images[0].b64_json, PNG_BASE64);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, true);
            assert.equal(upstreamJson.partial_images, 3);
        } finally {
            await upstream.close();
        }
    });

    it('consumes Responses image_generation SSE internally while keeping the Agent generate response non-streaming', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingResponsesImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'response.image_generation_call.partial_image',
                    data: {
                        type: 'response.image_generation_call.partial_image',
                        partial_image_b64: 'agent-responses-partial-base64',
                        partial_image_index: 0
                    }
                },
                {
                    event: 'response.output_item.done',
                    data: {
                        type: 'response.output_item.done',
                        item: {
                            type: 'image_generation_call',
                            status: 'completed',
                            result: PNG_BASE64
                        }
                    }
                }
            ];
        });
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-upstream-sse-key', {
                    prompt: 'agent responses upstream sse',
                    response_mode: 'base64',
                    image_backend: 'responses-image-generation',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.cached, false);
            assert.equal(body.images[0].b64_json, PNG_BASE64);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.model, 'gpt-5.4');
            assert.equal(upstreamJson.stream, true);
            const tools = upstreamJson.tools as Array<Record<string, unknown>>;
            assert.equal(tools[0].type, 'image_generation');
            assert.equal(tools[0].partial_images, 2);
        } finally {
            await upstream.close();
        }
    });

    it('marks Responses image_generation-disabled 403s as unavailable request modes', async () => {
        process.env.AGENT_STATE_BACKEND = 'memory';
        process.env.OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED = 'true';
        delete process.env.AGENT_SQLITE_PATH;
        const { generateImage } = await loadAgentRoutes();
        const upstream = await startResponsesImageJsonUpstream(403, {
            error: { message: 'Image generation is not enabled for this group' }
        });
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-image-disabled-key', {
                    prompt: 'agent responses disabled',
                    image_backend: 'responses-image-generation',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.equal(body.error.upstream_status, 403);
            assert.equal(body.error.diagnostics.channel_request_mode, 'responses-sse');
            assert.equal(body.error.diagnostics.channel_cooldown_scope, 'channel');
            assert.equal(body.error.diagnostics.cooldown_target.channel_id, 'default');
            assert.equal(body.error.diagnostics.cooldown_target.request_mode, 'responses-sse');
            assert.equal(JSON.stringify(body).includes('test-key'), false);
        } finally {
            await upstream.close();
        }
    });

    it('uses force-sse for Agent Responses image_generation SSE while keeping the final JSON contract', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingResponsesImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'response.output_item.done',
                    data: {
                        type: 'response.output_item.done',
                        item: {
                            type: 'image_generation_call',
                            status: 'completed',
                            result: PNG_BASE64
                        }
                    }
                }
            ];
        });
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-force-sse-key', {
                    prompt: 'agent responses force sse',
                    response_mode: 'base64',
                    image_backend: 'responses-image-generation',
                    streaming_strategy: 'force-sse',
                    partial_images: 3
                })
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.images[0].b64_json, PNG_BASE64);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.model, 'gpt-5.4');
            assert.equal(upstreamJson.stream, true);
            const tools = upstreamJson.tools as Array<Record<string, unknown>>;
            assert.equal(tools[0].type, 'image_generation');
            assert.equal(tools[0].partial_images, 3);
        } finally {
            await upstream.close();
        }
    });

    it('fails Agent Responses upstream SSE requests when partial images arrive without a final image', async () => {
        const { generateImage } = await loadAgentRoutes();
        const upstream = await startStreamingResponsesImageUpstream(() => [
            {
                event: 'response.image_generation_call.partial_image',
                data: {
                    type: 'response.image_generation_call.partial_image',
                    partial_image_b64: 'agent-responses-partial-only',
                    partial_image_index: 0
                }
            }
        ]);
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-upstream-sse-partial-only-key', {
                    prompt: 'agent responses upstream sse partial only',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'stream',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.match(body.error.message, /最终图片 b64_json/);
            assert.equal(body.error.diagnostics.upstream_event_type, 'response.image_generation_call.partial_image');
            assert.equal(body.error.diagnostics.partial_image_count, 1);
            assert.equal(body.error.diagnostics.retry_after_seconds, 15);
            assert.equal(JSON.stringify(body).includes('agent-responses-partial-only'), false);
        } finally {
            await upstream.close();
        }
    });

    it('rejects Agent Responses upstream SSE partial_images outside the Responses backend contract', async () => {
        const { generateImage } = await loadAgentRoutes();
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        setPrimaryChannelRequestModes('responses-sse');

        const response = await generateImage(
            agentJsonRequest('agent-responses-partial-range-key', {
                prompt: 'agent responses partial range',
                image_backend: 'responses-image-generation',
                stream_mode: 'stream',
                streaming_strategy: 'responses-sse',
                partial_images: 4
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.details.fields.partial_images, /1 到 3/);
    });

    it('accepts ignored partial_images on non-stream Responses requests with a zero provider range', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startResponsesImageJsonUpstream(
            200,
            {
                id: 'response-non-stream-partial-zero',
                object: 'response',
                status: 'completed',
                output: [
                    {
                        id: 'image-non-stream-partial-zero',
                        type: 'image_generation_call',
                        status: 'completed',
                        result: PNG_BASE64
                    }
                ]
            },
            (body) => {
                upstreamBody = body;
            }
        );
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_CHANNEL_1_ID = 'responses-non-stream';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'responses-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'responses-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'responses-partial-zero-provider',
            base_profile: 'openai-compatible',
            modes: { generate: { submit: { path: '/responses' } } },
            constraints: { partial_images: { min: 0, max: 0 } }
        });

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-non-stream-partial-zero-key', {
                    prompt: 'agent responses non-stream partial zero',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'non_stream',
                    streaming_strategy: 'off',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 200);
            const responseBody = await response.json();
            assert.equal(responseBody.execution.channel_request_mode, 'responses-non-stream');
            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            const tools = upstreamJson.tools as Array<Record<string, unknown>>;
            assert.equal('partial_images' in tools[0], false);
        } finally {
            await upstream.close();
        }
    });

    it('rejects Agent Images partial_images outside the selected OpenAI-compatible profile before calling upstream', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await generateImage(
                agentJsonRequest('agent-openai-partial-limit-key', {
                    prompt: 'agent openai partial limit',
                    stream_mode: 'stream',
                    streaming_strategy: 'openai-sse',
                    partial_images: 0
                })
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.partial_images, /1 到 3/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('keeps selected upstream image count limits enforced when force_request is enabled', async () => {
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'matsca';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'test-key';
        process.env.OPENAI_CHANNEL_1_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID = 'app-id';
        process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET = 'app-secret';
        const { generateImage } = await loadAgentRoutes();

        try {
            const response = await generateImage(
                agentJsonRequest('agent-force-count-limit-key', {
                    prompt: 'agent force still respects count limits',
                    n: 5,
                    force_request: true
                })
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.n, /1 到 4/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('fails Agent Responses upstream SSE requests when the image_generation_call fails', async () => {
        const { generateImage } = await loadAgentRoutes();
        const upstream = await startStreamingResponsesImageUpstream(() => [
            {
                event: 'response.output_item.done',
                data: {
                    type: 'response.output_item.done',
                    item: {
                        type: 'image_generation_call',
                        status: 'failed',
                        error: {
                            code: 'content_policy_violation',
                            message: 'blocked by upstream policy'
                        }
                    }
                }
            }
        ]);
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-responses-upstream-sse-failed-call-key', {
                    prompt: 'agent responses upstream sse failed call',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'stream',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.match(body.error.message, /blocked by upstream policy/);
        } finally {
            await upstream.close();
        }
    });

    it('fails Agent upstream SSE requests when partial images arrive without a final image', async () => {
        const { generateImage } = await loadAgentRoutes();
        const upstream = await startStreamingImageUpstream(() => [
            {
                event: 'image_generation.partial_image',
                data: { type: 'image_generation.partial_image', b64_json: 'agent-partial-only' }
            }
        ]);
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await generateImage(
                agentJsonRequest('agent-upstream-sse-partial-only-key', {
                    prompt: 'agent upstream sse partial only',
                    stream_mode: 'stream',
                    streaming_strategy: 'newapi-keepalive-sse',
                    partial_images: 2
                })
            );

            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.match(body.error.message, /最终图片 b64_json/);
            assert.equal(body.error.diagnostics.upstream_event_type, 'image_generation.partial_image');
            assert.equal(body.error.diagnostics.partial_image_count, 1);
        } finally {
            await upstream.close();
        }
    });

    it('generates and replays through the memory state backend without creating SQLite state', async () => {
        process.env.AGENT_STATE_BACKEND = 'memory';
        delete process.env.AGENT_SQLITE_PATH;
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const first = await generateImage(
                agentJsonRequest('route-memory-cache-key', { prompt: 'agent memory route success' })
            );
            assert.equal(first.status, 200);
            const firstBody = await first.json();
            assert.equal(firstBody.cached, false);

            const second = await generateImage(
                agentJsonRequest('route-memory-cache-key', { prompt: 'agent memory route success' })
            );
            assert.equal(second.status, 200);
            const secondBody = await second.json();
            assert.equal(secondBody.cached, true);
            assert.equal(second.headers.get('x-idempotent-replay'), 'true');
            assert.equal(secondBody.request_id, firstBody.request_id);
            assert.equal(upstreamCalls, 1);
            assert.deepEqual(await listAgentStateFiles(), []);
        } finally {
            await upstream.close();
        }
    });

    it('returns explicit base64 without storing complete base64 in the request state', async () => {
        const { generateImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        const first = await generateImage(
            agentJsonRequest('route-base64-key', {
                prompt: 'agent route base64',
                response_mode: 'base64'
            })
        );
        assert.equal(first.status, 200);
        const firstBody = await first.json();
        assert.equal(firstBody.cached, false);
        assert.equal(firstBody.images[0].b64_json, PNG_BASE64);

        const storedResponse = readStoredResponseJson('route-base64-key');
        assert.equal(storedResponse.includes(PNG_BASE64), false);
        assert.equal(storedResponse.includes('b64_json'), false);

        const second = await generateImage(
            agentJsonRequest('route-base64-key', {
                prompt: 'agent route base64',
                response_mode: 'base64'
            })
        );
        assert.equal(second.status, 200);
        const secondBody = await second.json();
        assert.equal(secondBody.cached, true);
        assert.equal(secondBody.images[0].b64_json, PNG_BASE64);
        assert.equal(upstreamCalls, 1);

        await upstream.close();
    });

    it('returns field-level errors for invalid generate JSON requests', async () => {
        const { generateImage } = await loadAgentRoutes();

        const response = await generateImage(
            agentJsonRequest('route-validation-key', {
                prompt: '',
                n: 99,
                response_mode: 'url'
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.details.fields.prompt, /必填/);
        assert.match(body.error.details.fields.n, /1 到 10/);
        assert.match(body.error.details.fields.response_mode, /path/);
    });

    it('returns validation errors for malformed generate JSON requests', async () => {
        const { generateImage } = await loadAgentRoutes();

        const response = await generateImage(
            new Request('http://localhost/api/agent/images/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'route-malformed-json-key'
                },
                body: '{"prompt":'
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.retryable, false);
    });

    it('returns sanitized upstream diagnostics for failed generate requests', async () => {
        process.env.OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED = 'true';
        const { generateImage, lookupAgentRequestDiagnostics } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            throw new Error('upstream failed');
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const idempotencyKey = 'route-upstream-diagnostics-key';
            const response = await generateImage(agentJsonRequest(idempotencyKey, { prompt: 'diagnostics' }));
            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.equal(body.error.upstream_status, 500);
            assert.equal(body.error.diagnostics.upstream_status, 500);
            assert.equal(body.error.diagnostics.selected_channel_id, 'default');
            assert.match(body.error.diagnostics.upstream_host, /^127\.0\.0\.1:\d+$/);
            assert.equal(body.error.diagnostics.channel_cooldown_scope, 'channel');
            assert.equal(body.error.diagnostics.cooldown_target.channel_id, 'default');
            assert.equal(body.error.diagnostics.cooldown_target.request_mode, 'images-non-stream');
            assert.equal(typeof body.error.diagnostics.retry_after_ms, 'number');
            assert.equal(typeof body.error.diagnostics.cooldown_until, 'string');
            assert.equal(typeof body.error.diagnostics.elapsed_ms, 'number');
            assert.equal(JSON.stringify(body).includes('test-key'), false);
            const upstreamCallsAfterFirstFailure = upstreamCalls;

            const replay = await generateImage(agentJsonRequest(idempotencyKey, { prompt: 'diagnostics' }));
            assert.equal(replay.status, 502);
            assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
            assert.equal(replay.headers.get('x-request-id'), body.error.request_id);
            const replayBody = await replay.json();
            assert.equal(replayBody.error.code, 'upstream_unavailable');
            assert.equal(replayBody.error.retryable, false);
            assert.equal(replayBody.error.request_id, body.error.request_id);
            assert.equal(upstreamCalls, upstreamCallsAfterFirstFailure);

            const diagnostics = await lookupAgentRequestDiagnostics(
                new Request(`http://localhost/api/agent/diagnostics/requests?idempotency_key=${idempotencyKey}`)
            );
            assert.equal(diagnostics.status, 200);
            const diagnosticsBody = await diagnostics.json();
            assert.equal(diagnosticsBody.found, true);
            assert.equal(diagnosticsBody.diagnostics.request.request_id, body.error.request_id);
            assert.equal(diagnosticsBody.diagnostics.request.status, 'failed');
            assert.equal(diagnosticsBody.diagnostics.error.code, 'upstream_unavailable');
            assert.equal(diagnosticsBody.diagnostics.error.retryable, true);
            assert.equal(diagnosticsBody.diagnostics.error.diagnostics.selected_channel_id, 'default');
            assert.match(diagnosticsBody.diagnostics.error.diagnostics.upstream_host, /^127\.0\.0\.1:\d+$/);
            assert.equal(diagnosticsBody.diagnostics.error.diagnostics.cooldown_target.channel_id, 'default');
            assert.equal(
                diagnosticsBody.diagnostics.error.diagnostics.cooldown_target.request_mode,
                'images-non-stream'
            );
            assert.equal(typeof diagnosticsBody.diagnostics.error.diagnostics.retry_after_ms, 'number');
            assert.equal(JSON.stringify(diagnosticsBody).includes('test-key'), false);
        } finally {
            await upstream.close();
        }
    });

    it('creates a generate job, exposes running status, and returns the completed result', async () => {
        const { createGenerateJob, getJob, getJobResult } = await loadAgentRoutes();
        let releaseUpstream: (() => void) | undefined;
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(async () => {
            upstreamCalls += 1;
            await new Promise<void>((resolve) => {
                releaseUpstream = resolve;
            });
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-key', { prompt: 'agent route job' })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();
            assert.equal(createdBody.job.state, 'running');
            assert.equal(createdBody.job.idempotency_key, 'route-job-key');
            assert.equal(createdBody.job.result_url, `/api/agent/jobs/${createdBody.job.id}/result`);

            await waitFor(() => upstreamCalls === 1);
            const running = await getJob(new Request(`http://localhost/api/agent/jobs/${createdBody.job.id}`), {
                params: Promise.resolve({ id: createdBody.job.id })
            });
            assert.equal(running.status, 200);
            assert.equal((await running.json()).job.state, 'running');

            releaseUpstream?.();
            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 200);
            const resultBody = await result.json();
            assert.equal(resultBody.request_id, createdBody.job.id);
            assert.equal(resultBody.cached, false);
            assert.equal(resultBody.images.length, 1);
            assert.equal('b64_json' in resultBody.images[0], false);
            assert.equal(resultBody.execution.transport, 'agent_job_polling');
            assert.equal(resultBody.execution.endpoint, '/api/agent/jobs/images/generate');
            assert.equal(resultBody.execution.route_mode, 'job');
            assert.equal(resultBody.execution.channel_request_mode, 'images-non-stream');
            assert.equal(resultBody.execution.channel_request_mode_fallback_applied, false);
            assert.equal(typeof resultBody.timing.elapsed_ms, 'number');
            assert.equal(resultBody.timing.elapsed_ms >= 0, true);
        } finally {
            releaseUpstream?.();
            await upstream.close();
        }
    });

    it('creates a server-orchestrated image request job and records the orchestration endpoint', async () => {
        const { createImageRequest, getJobResult } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const created = await createImageRequest(
                agentImageRequest('route-orchestrated-key', { prompt: 'server orchestrated generate' })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();
            assert.equal(createdBody.job.state, 'running');
            assert.equal(createdBody.job.idempotency_key, 'route-orchestrated-key');

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 200);
            const resultBody = await result.json();
            assert.equal(resultBody.request_id, createdBody.job.id);
            assert.equal(resultBody.cached, false);
            assert.equal(resultBody.images.length, 1);
            assert.equal(resultBody.execution.transport, 'agent_job_polling');
            assert.equal(resultBody.execution.endpoint, '/api/agent/image-requests');
            assert.equal(resultBody.execution.route_mode, 'job');
            assert.equal(resultBody.execution.channel_request_mode, 'images-non-stream');
            assert.equal(resultBody.execution.channel_request_mode_fallback_applied, false);
            assert.equal(upstreamCalls, 1);
        } finally {
            await upstream.close();
        }
    });

    it('does not consume generate job idempotency keys for local profile validation failures', async () => {
        const { createGenerateJob, getJobResult } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_PROFILE = 'openai-compatible';
        const idempotencyKey = 'route-job-local-validation-key';

        try {
            const invalid = await createGenerateJob(
                agentJobJsonRequest(idempotencyKey, {
                    prompt: 'job transparent object',
                    background: 'transparent'
                })
            );

            assert.equal(invalid.status, 422);
            assert.equal((await invalid.json()).error.code, 'validation_error');
            assert.equal(upstreamCalls, 0);

            const corrected = await createGenerateJob(
                agentJobJsonRequest(idempotencyKey, {
                    prompt: 'job transparent object',
                    background: 'auto'
                })
            );

            assert.equal(corrected.status, 202);
            const correctedBody = await corrected.json();
            assert.equal(correctedBody.job.idempotency_key, idempotencyKey);
            const result = await waitForJobResult(getJobResult, correctedBody.job.id);
            assert.equal(result.status, 200);
            assert.equal((await result.json()).idempotency_key, idempotencyKey);
            assert.equal(upstreamCalls, 1);
        } finally {
            await upstream.close();
        }
    });

    it('creates a generate job that consumes upstream image SSE and saves the final artifact', async () => {
        const { createGenerateJob, getJobResult, getArtifactContent } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'image_generation.partial_image',
                    data: { type: 'image_generation.partial_image', b64_json: 'job-partial-base64' }
                },
                {
                    event: 'image_generation.completed',
                    data: { type: 'image_generation.completed', b64_json: PNG_BASE64 }
                }
            ];
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-upstream-sse-key', {
                    prompt: 'agent job upstream sse',
                    streaming_strategy: 'newapi-keepalive-sse',
                    partial_images: 2
                })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 200);
            assert.notEqual(result.headers.get('content-type'), 'text/event-stream');
            const resultBody = await result.json();
            assert.equal(resultBody.request_id, createdBody.job.id);
            assert.equal(resultBody.cached, false);
            assert.equal(resultBody.images.length, 1);
            assert.equal('b64_json' in resultBody.images[0], false);
            assert.match(resultBody.images[0].content_url, /^\/api\/agent\/artifacts\/[^/]+\/content$/);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.stream, true);
            assert.equal(upstreamJson.partial_images, 2);

            const artifactId = resultBody.images[0].content_url.split('/').at(-2);
            assert.equal(typeof artifactId, 'string');
            const content = await getArtifactContent(
                new Request(`http://localhost/api/agent/artifacts/${artifactId}/content`),
                { params: Promise.resolve({ id: artifactId }) }
            );
            assert.equal(content.status, 200);
            assert.equal(
                Buffer.compare(Buffer.from(await content.arrayBuffer()), Buffer.from(PNG_BASE64, 'base64')),
                0
            );
        } finally {
            await upstream.close();
        }
    });

    it('fails image upstream SSE generate jobs when partial images arrive without a final image', async () => {
        const { createGenerateJob, getJob, getJobResult } = await loadAgentRoutes();
        const upstream = await startStreamingImageUpstream(() => [
            {
                event: 'image_generation.partial_image',
                data: { type: 'image_generation.partial_image', b64_json: 'job-images-partial-only' }
            }
        ]);
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-images-missing-final-key', {
                    prompt: 'agent job images partial only',
                    stream_mode: 'stream',
                    streaming_strategy: 'newapi-keepalive-sse',
                    partial_images: 2
                })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 502);
            const resultBody = await result.json();
            assert.equal(resultBody.error.code, 'upstream_unavailable');
            assert.match(resultBody.error.message, /最终图片 b64_json/);
            assert.equal(resultBody.error.retryable, false);
            assert.equal(resultBody.error.diagnostics.upstream_event_type, 'image_generation.partial_image');
            assert.equal(resultBody.error.diagnostics.partial_image_count, 1);
            assert.equal(resultBody.error.diagnostics.retry_after_seconds, undefined);
            assert.equal(JSON.stringify(resultBody).includes('job-images-partial-only'), false);

            const status = await getJob(new Request(`http://localhost/api/agent/jobs/${createdBody.job.id}`), {
                params: Promise.resolve({ id: createdBody.job.id })
            });
            assert.equal(status.status, 200);
            const statusBody = await status.json();
            assert.equal(statusBody.job.state, 'failed');
            assert.equal(statusBody.job.error.code, 'upstream_unavailable');
            assert.match(statusBody.job.error.message, /最终图片 b64_json/);
            assert.equal(statusBody.job.error.retryable, false);
            assert.equal(statusBody.job.error.diagnostics.upstream_event_type, 'image_generation.partial_image');
            assert.equal(statusBody.job.error.diagnostics.partial_image_count, 1);
            assert.equal(statusBody.job.error.diagnostics.retry_after_seconds, undefined);
            assert.equal(JSON.stringify(statusBody).includes('job-images-partial-only'), false);
        } finally {
            await upstream.close();
        }
    });

    it('creates a generate job that consumes Responses image_generation SSE and saves the final artifact', async () => {
        const { createGenerateJob, getJobResult, getArtifactContent } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingResponsesImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'response.image_generation_call.partial_image',
                    data: {
                        type: 'response.image_generation_call.partial_image',
                        partial_image_b64: 'job-responses-partial-base64',
                        partial_image_index: 0
                    }
                },
                {
                    event: 'response.output_item.done',
                    data: {
                        type: 'response.output_item.done',
                        item: {
                            type: 'image_generation_call',
                            status: 'completed',
                            result: PNG_BASE64
                        }
                    }
                }
            ];
        });
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-responses-upstream-sse-key', {
                    prompt: 'agent job responses upstream sse',
                    image_backend: 'responses-image-generation',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 200);
            assert.notEqual(result.headers.get('content-type'), 'text/event-stream');
            const resultBody = await result.json();
            assert.equal(resultBody.request_id, createdBody.job.id);
            assert.equal(resultBody.cached, false);
            assert.equal(resultBody.images.length, 1);
            assert.equal('b64_json' in resultBody.images[0], false);
            assert.match(resultBody.images[0].content_url, /^\/api\/agent\/artifacts\/[^/]+\/content$/);

            const upstreamJson = JSON.parse(upstreamBody) as Record<string, unknown>;
            assert.equal(upstreamJson.model, 'gpt-5.4');
            assert.equal(upstreamJson.stream, true);
            assert.equal((upstreamJson.tool_choice as Record<string, unknown>).type, 'image_generation');
            const tools = upstreamJson.tools as Array<Record<string, unknown>>;
            assert.equal(tools[0].type, 'image_generation');
            assert.equal(tools[0].partial_images, 2);

            const artifactId = resultBody.images[0].content_url.split('/').at(-2);
            assert.equal(typeof artifactId, 'string');
            const content = await getArtifactContent(
                new Request(`http://localhost/api/agent/artifacts/${artifactId}/content`),
                { params: Promise.resolve({ id: artifactId }) }
            );
            assert.equal(content.status, 200);
            assert.equal(
                Buffer.compare(Buffer.from(await content.arrayBuffer()), Buffer.from(PNG_BASE64, 'base64')),
                0
            );
        } finally {
            await upstream.close();
        }
    });

    it('fails Responses upstream SSE generate jobs when partial images arrive without a final image', async () => {
        const { createGenerateJob, getJob, getJobResult } = await loadAgentRoutes();
        const upstream = await startStreamingResponsesImageUpstream(() => [
            {
                event: 'response.image_generation_call.partial_image',
                data: {
                    type: 'response.image_generation_call.partial_image',
                    partial_image_b64: 'job-responses-partial-only',
                    partial_image_index: 0
                }
            }
        ]);
        process.env.ENABLE_RESPONSES_IMAGE_BACKEND = 'true';
        process.env.OPENAI_RESPONSES_API_MODEL = 'gpt-5.4';
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('responses-sse');

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-responses-missing-final-key', {
                    prompt: 'agent job responses partial only',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'stream',
                    streaming_strategy: 'responses-sse',
                    partial_images: 2
                })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 502);
            const resultBody = await result.json();
            assert.equal(resultBody.error.code, 'upstream_unavailable');
            assert.match(resultBody.error.message, /最终图片 b64_json/);
            assert.equal(resultBody.error.retryable, false);
            assert.equal(
                resultBody.error.diagnostics.upstream_event_type,
                'response.image_generation_call.partial_image'
            );
            assert.equal(resultBody.error.diagnostics.partial_image_count, 1);
            assert.equal(resultBody.error.diagnostics.retry_after_seconds, undefined);
            assert.equal(JSON.stringify(resultBody).includes('job-responses-partial-only'), false);

            const status = await getJob(new Request(`http://localhost/api/agent/jobs/${createdBody.job.id}`), {
                params: Promise.resolve({ id: createdBody.job.id })
            });
            assert.equal(status.status, 200);
            const statusBody = await status.json();
            assert.equal(statusBody.job.state, 'failed');
            assert.equal(statusBody.job.error.code, 'upstream_unavailable');
            assert.match(statusBody.job.error.message, /最终图片 b64_json/);
            assert.equal(statusBody.job.error.retryable, false);
            assert.equal(
                statusBody.job.error.diagnostics.upstream_event_type,
                'response.image_generation_call.partial_image'
            );
            assert.equal(statusBody.job.error.diagnostics.partial_image_count, 1);
            assert.equal(statusBody.job.error.diagnostics.retry_after_seconds, undefined);
            assert.equal(JSON.stringify(statusBody).includes('job-responses-partial-only'), false);
        } finally {
            await upstream.close();
        }
    });

    it('reuses the running generate job for the same idempotency key', async () => {
        const { createGenerateJob, getJobResult } = await loadAgentRoutes();
        let releaseUpstream: (() => void) | undefined;
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(async () => {
            upstreamCalls += 1;
            await new Promise<void>((resolve) => {
                releaseUpstream = resolve;
            });
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const first = await createGenerateJob(agentJobJsonRequest('route-job-reuse-key', { prompt: 'job reuse' }));
            assert.equal(first.status, 202);
            const firstBody = await first.json();
            await waitFor(() => upstreamCalls === 1);

            const second = await createGenerateJob(agentJobJsonRequest('route-job-reuse-key', { prompt: 'job reuse' }));
            assert.equal(second.status, 202);
            assert.equal(second.headers.get('x-idempotent-replay'), 'true');
            const secondBody = await second.json();
            assert.equal(secondBody.job.id, firstBody.job.id);
            assert.equal(secondBody.job.state, 'running');
            assert.equal(upstreamCalls, 1);

            releaseUpstream?.();
            const result = await waitForJobResult(getJobResult, firstBody.job.id);
            assert.equal(result.status, 200);
        } finally {
            releaseUpstream?.();
            await upstream.close();
        }
    });

    it('rejects generate job idempotency keys reused with a different request body', async () => {
        const { createGenerateJob, getJobResult } = await loadAgentRoutes();
        let releaseUpstream: (() => void) | undefined;
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(async () => {
            upstreamCalls += 1;
            await new Promise<void>((resolve) => {
                releaseUpstream = resolve;
            });
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const first = await createGenerateJob(
                agentJobJsonRequest('route-job-conflict-key', { prompt: 'first job body' })
            );
            assert.equal(first.status, 202);
            const firstBody = await first.json();
            await waitFor(() => upstreamCalls === 1);

            const conflict = await createGenerateJob(
                agentJobJsonRequest('route-job-conflict-key', { prompt: 'different job body' })
            );
            assert.equal(conflict.status, 409);
            assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
            assert.equal(upstreamCalls, 1);

            releaseUpstream?.();
            const result = await waitForJobResult(getJobResult, firstBody.job.id);
            assert.equal(result.status, 200);
        } finally {
            releaseUpstream?.();
            await upstream.close();
        }
    });

    it('returns stored Agent errors for failed generate jobs', async () => {
        const { createGenerateJob, getJob, getJobResult } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            throw new Error('job upstream failed');
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-failure-key', { prompt: 'job failure' })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();

            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 502);
            const resultBody = await result.json();
            assert.equal(resultBody.error.code, 'upstream_unavailable');
            assert.equal(resultBody.error.retryable, false);
            assert.equal(resultBody.error.upstream_status, 500);
            assert.equal(resultBody.error.diagnostics.upstream_status, 500);
            assert.equal(resultBody.error.request_id, createdBody.job.id);
            assert.equal(JSON.stringify(resultBody).includes('test-key'), false);

            const status = await getJob(new Request(`http://localhost/api/agent/jobs/${createdBody.job.id}`), {
                params: Promise.resolve({ id: createdBody.job.id })
            });
            assert.equal(status.status, 200);
            const statusBody = await status.json();
            assert.equal(statusBody.job.state, 'failed');
            assert.equal(statusBody.job.error.code, 'upstream_unavailable');
            assert.equal(statusBody.job.error.retryable, false);
            assert.equal(statusBody.job.error.upstream_status, 500);
            assert.equal(statusBody.job.error.diagnostics.upstream_status, 500);
            assert.equal(upstreamCalls > 0, true);

            const replay = await createGenerateJob(
                agentJobJsonRequest('route-job-failure-key', { prompt: 'job failure' })
            );
            assert.equal(replay.status, 202);
            assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
            const replayBody = await replay.json();
            assert.equal(replayBody.job.id, createdBody.job.id);
            assert.equal(replayBody.job.state, 'failed');
        } finally {
            await upstream.close();
        }
    });

    it('marks generate jobs as failed when completion state persistence fails', async () => {
        const { createGenerateJob, getJob } = await loadAgentRoutes();
        const { setAgentStateStoreFactoryForTests } = await import('@/lib/agent-state-runtime');
        const requestId = 'job-completion-failure-request';
        let failErrorCode: AgentErrorCode | undefined;
        let saveCalls = 0;
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setAgentStateStoreFactoryForTests(() => ({
            async init() {},
            async recoverExpiredRequests() {
                return 0;
            },
            async purgeExpiredRequests() {
                return 0;
            },
            async beginRequest() {
                return {
                    type: 'acquired',
                    record: {
                        requestId,
                        idempotencyKey: 'job-completion-failure-key',
                        requestHash: 'hash',
                        mode: 'generate',
                        status: 'running',
                        requestJson: { prompt: 'job completion persistence failure' },
                        createdAt: '2026-05-12T00:00:00.000Z',
                        updatedAt: '2026-05-12T00:00:00.000Z',
                        expiresAt: '2099-05-13T00:00:00.000Z'
                    }
                };
            },
            async refreshRequestLease() {
                return true;
            },
            async saveArtifacts() {
                saveCalls += 1;
            },
            async completeRequest() {
                throw new Error('job completion persistence failed');
            },
            async failRequest(input: { requestId: string; error: { error: { code: AgentErrorCode } } }) {
                assert.equal(input.requestId, requestId);
                failErrorCode = input.error.error.code;
            },
            async getRequest(id: string) {
                if (id !== requestId || !failErrorCode) return undefined;
                return {
                    requestId,
                    idempotencyKey: 'job-completion-failure-key',
                    requestHash: 'hash',
                    mode: 'generate',
                    status: 'failed',
                    requestJson: { prompt: 'job completion persistence failure' },
                    errorJson: {
                        error: {
                            code: failErrorCode,
                            message: '保存请求完成状态失败。',
                            retryable: true,
                            request_id: requestId
                        }
                    },
                    createdAt: '2026-05-12T00:00:00.000Z',
                    updatedAt: '2026-05-12T00:00:01.000Z',
                    expiresAt: '2099-05-13T00:00:00.000Z'
                };
            },
            async getRequestByIdempotencyKey() {
                return undefined;
            },
            async getArtifact() {
                return undefined;
            },
            async listArtifactsForRequest() {
                return [];
            },
            async listArtifactFilepaths() {
                return [];
            },
            async deleteArtifact() {
                return false;
            }
        }));

        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('job-completion-failure-key', { prompt: 'job completion persistence failure' })
            );
            assert.equal(created.status, 202);
            await waitFor(() => failErrorCode === 'unexpected_error');
            assert.equal(saveCalls, 1);

            const status = await getJob(new Request(`http://localhost/api/agent/jobs/${requestId}`), {
                params: Promise.resolve({ id: requestId })
            });
            assert.equal(status.status, 200);
            const statusBody = await status.json();
            assert.equal(statusBody.job.state, 'failed');
            assert.equal(statusBody.job.error.code, 'unexpected_error');
            assert.equal(statusBody.job.error.retryable, false);
        } finally {
            console.error = originalConsoleError;
            await upstream.close();
        }
    });

    it('keeps a long-running generate job leased while the upstream call is still active', async () => {
        process.env.AGENT_REQUEST_LEASE_MS = '200';
        process.env.AGENT_RECOVERY_INTERVAL_MS = '50';
        const { createGenerateJob, getJob, getJobResult } = await loadAgentRoutes();
        let releaseUpstream: (() => void) | undefined;
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(async () => {
            upstreamCalls += 1;
            await new Promise<void>((resolve) => {
                releaseUpstream = resolve;
            });
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const created = await createGenerateJob(
                agentJobJsonRequest('route-job-lease-key', { prompt: 'job lease' })
            );
            assert.equal(created.status, 202);
            const createdBody = await created.json();
            await waitFor(() => upstreamCalls === 1);
            await new Promise((resolve) => setTimeout(resolve, 350));

            const status = await getJob(new Request(`http://localhost/api/agent/jobs/${createdBody.job.id}`), {
                params: Promise.resolve({ id: createdBody.job.id })
            });
            assert.equal(status.status, 200);
            const statusBody = await status.json();
            assert.equal(statusBody.job.state, 'running');

            releaseUpstream?.();
            const result = await waitForJobResult(getJobResult, createdBody.job.id);
            assert.equal(result.status, 200);
        } finally {
            releaseUpstream?.();
            await upstream.close();
        }
    });

    it('returns structured errors for missing and expired jobs', async () => {
        const { getJob, getJobResult } = await loadAgentRoutes();
        const { resetAgentStateStoreForTests, setAgentStateStoreFactoryForTests } =
            await import('@/lib/agent-state-runtime');

        const missing = await getJob(new Request('http://localhost/api/agent/jobs/missing-job'), {
            params: Promise.resolve({ id: 'missing-job' })
        });
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).error.code, 'job_not_found');

        setAgentStateStoreFactoryForTests(() => ({
            async init() {},
            async recoverExpiredRequests() {
                return 0;
            },
            async purgeExpiredRequests() {
                return 0;
            },
            async beginRequest() {
                throw new Error('not used');
            },
            async refreshRequestLease() {
                return false;
            },
            async saveArtifacts() {},
            async completeRequest() {},
            async failRequest() {},
            async getRequest() {
                return {
                    requestId: 'expired-job',
                    idempotencyKey: 'expired-key',
                    requestHash: 'hash',
                    mode: 'generate',
                    status: 'running',
                    requestJson: { prompt: 'expired' },
                    createdAt: '2026-05-12T00:00:00.000Z',
                    updatedAt: '2026-05-12T00:00:00.000Z',
                    expiresAt: '2026-05-12T00:00:01.000Z'
                };
            },
            async getRequestByIdempotencyKey() {
                return undefined;
            },
            async getArtifact() {
                return undefined;
            },
            async listArtifactsForRequest() {
                return [];
            },
            async listArtifactFilepaths() {
                return [];
            },
            async deleteArtifact() {
                return false;
            }
        }));
        await resetAgentStateStoreForTests();

        const expired = await getJobResult(new Request('http://localhost/api/agent/jobs/expired-job/result'), {
            params: Promise.resolve({ id: 'expired-job' })
        });
        assert.equal(expired.status, 410);
        assert.equal((await expired.json()).error.code, 'job_expired');
    });

    it('edits through multipart input and replays the cached response for the same idempotency key', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        let upstreamBody = '';
        const upstream = await startImageUpstream((body) => {
            upstreamCalls += 1;
            upstreamBody = body;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        const first = await editImage(agentEditRequest('route-edit-key', 'agent edit success'));
        assert.equal(first.status, 200);
        const firstBody = await first.json();
        assert.equal(firstBody.cached, false);
        assert.equal(firstBody.images[0].output_format, 'webp');
        assert.equal(firstBody.images[0].mime_type, 'image/webp');
        assert.equal(firstBody.images[0].filename.endsWith('.webp'), true);
        assert.equal('b64_json' in firstBody.images[0], false);
        assert.doesNotMatch(upstreamBody, /name="output_format"/);
        assert.doesNotMatch(upstreamBody, /name="response_format"/);

        const second = await editImage(agentEditRequest('route-edit-key', 'agent edit success'));
        assert.equal(second.status, 200);
        const secondBody = await second.json();
        assert.equal(secondBody.cached, true);
        assert.equal(second.headers.get('x-idempotent-replay'), 'true');
        assert.equal(second.headers.get('x-request-id'), firstBody.request_id);
        assert.equal(secondBody.request_id, firstBody.request_id);
        assert.equal(upstreamCalls, 1);

        await upstream.close();
    });

    it('routes mixed provider edit counts to the channel that accepts the requested count', async () => {
        const { editImage } = await loadAgentRoutes();
        let firstCalls = 0;
        let secondCalls = 0;
        const first = await startImageUpstream(() => {
            firstCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        const second = await startImageUpstream(() => {
            secondCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_CHANNEL_1_ID = 'fixed-one';
        process.env.OPENAI_CHANNEL_1_BASE_URL = first.baseUrl;
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'first-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-one-edit-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits', content_type: 'multipart/form-data' } } },
            constraints: { edit_count: { min: 1, max: 1 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'fixed-two';
        process.env.OPENAI_CHANNEL_2_BASE_URL = second.baseUrl;
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'second-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'fixed-two-edit-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits', content_type: 'multipart/form-data' } } },
            constraints: { edit_count: { min: 2, max: 2 } }
        });
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        try {
            const response = await editImage(
                agentEditRequest('mixed-agent-edit-two-key', 'mixed provider edit count two', {}, { n: '2' })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.execution.selected_channel_id, 'fixed-two');
            assert.equal(firstCalls, 0);
            assert.equal(secondCalls, 1);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it('rejects mixed-channel Agent edit partial_images before channel selection', async () => {
        const { editImage } = await loadAgentRoutes();
        process.env.OPENAI_CHANNEL_1_ID = 'edit-partial-one';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://edit-one.example.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'edit-one-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'edit-partial-one-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits' } } },
            constraints: { partial_images: { min: 1, max: 1 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'edit-partial-three';
        process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://edit-three.example.com/v1';
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'edit-three-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'edit-partial-three-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits' } } },
            constraints: { partial_images: { min: 3, max: 3 } }
        });
        const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();

        const response = await editImage(
            agentEditRequest(
                'mixed-edit-partial-invalid-key',
                'mixed edit partial invalid',
                {},
                {
                    stream_mode: 'stream',
                    streaming_strategy: 'force-sse',
                    partial_images: '2'
                }
            )
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.details.fields.partial_images, /partial_images 必须在 1 到 1 之间/);
    });

    it('ignores cooled non-stream edit channels when validating partial_images', async () => {
        const { editImage } = await loadAgentRoutes();
        process.env.OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED = 'true';
        process.env.OPENAI_CHANNEL_1_ID = 'cooled-edit-non-stream';
        process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://cooled-edit.example.com/v1';
        process.env.OPENAI_CHANNEL_1_API_KEYS = 'cooled-edit-key';
        process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
        process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
            id: 'cooled-edit-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits' } } },
            constraints: { partial_images: { min: 0, max: 0 } }
        });
        process.env.OPENAI_CHANNEL_2_ID = 'healthy-edit-sse';
        process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://healthy-edit.example.com/v1';
        process.env.OPENAI_CHANNEL_2_API_KEYS = 'healthy-edit-key';
        process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
        process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
            id: 'healthy-edit-provider',
            base_profile: 'openai-compatible',
            modes: { edit: { submit: { path: '/images/edits' } } },
            constraints: { partial_images: { min: 3, max: 3 } }
        });
        const { getServerChannelState, resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
        resetServerChannelStateForTests();
        const state = getServerChannelState();
        const cooledCredential = state.config.credentials.find(
            (credential) => credential.channelId === 'cooled-edit-non-stream'
        );
        assert.ok(cooledCredential);
        assert.ok(state.router);
        state.router.reportFailure(cooledCredential, { scope: 'channel', requestMode: 'images-non-stream' });

        const response = await editImage(
            agentEditRequest(
                'cooled-edit-partial-invalid-key',
                'cooled edit partial invalid',
                {},
                {
                    stream_mode: 'auto',
                    streaming_strategy: 'auto',
                    partial_images: '1'
                }
            )
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.details.fields.partial_images, /partial_images 必须在 3 到 3 之间/);
    });

    it('does not consume edit idempotency keys for local input validation failures', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        const idempotencyKey = 'route-edit-local-validation-key';
        const invalidFormData = new FormData();
        invalidFormData.append('prompt', 'agent edit without image');
        invalidFormData.append('model', 'gpt-image-2');
        invalidFormData.append('stream_mode', 'non_stream');

        try {
            const invalid = await editImage(
                new Request('http://localhost/api/agent/images/edit', {
                    method: 'POST',
                    headers: { 'Idempotency-Key': idempotencyKey },
                    body: invalidFormData
                })
            );

            assert.equal(invalid.status, 422);
            assert.equal(upstreamCalls, 0);

            const corrected = await editImage(agentEditRequest(idempotencyKey, 'agent edit without image'));

            assert.equal(corrected.status, 200);
            assert.equal(upstreamCalls, 1);
            const body = await corrected.json();
            assert.equal(body.idempotency_key, idempotencyKey);
        } finally {
            await upstream.close();
        }
    });

    it('can consume Agent edit upstream SSE internally while returning final JSON', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamBody = '';
        const upstream = await startStreamingImageUpstream((body) => {
            upstreamBody = body;
            return [
                {
                    event: 'image_edit.completed',
                    data: { type: 'image_edit.completed', b64_json: PNG_CONVERTIBLE_BASE64 }
                }
            ];
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-upstream-sse-key',
                    'agent edit stream',
                    {},
                    {
                        stream_mode: 'stream',
                        streaming_strategy: 'openai-sse',
                        partial_images: '2'
                    }
                )
            );

            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('content-type'), 'text/event-stream');
            const body = await response.json();
            assert.equal(body.images[0].content_url.startsWith('/api/agent/artifacts/'), true);
            assert.match(upstreamBody, /name="stream"/);
            assert.match(upstreamBody, /name="partial_images"/);
        } finally {
            await upstream.close();
        }
    });

    it('aborts Agent edit upstream calls when the client request signal aborts', async () => {
        const { editImage } = await loadAgentRoutes();
        const { getServerChannelState } = await import('@/lib/server-channel-router');
        const upstream = await startHangingImageEditUpstream();
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_REQUEST_MODES = 'images-sse';
        const abortController = new AbortController();

        try {
            const responsePromise = editImage(
                agentEditRequest(
                    'route-edit-abort-key',
                    'agent edit abort',
                    {},
                    { stream_mode: 'auto', streaming_strategy: 'openai-sse' },
                    { signal: abortController.signal }
                )
            );
            await waitFor(() => upstream.requests === 1);
            abortController.abort();

            const response = await Promise.race([
                responsePromise,
                new Promise<Response>((_, reject) =>
                    setTimeout(() => reject(new Error('Agent edit upstream call did not abort')), 1500)
                )
            ]);

            assert.notEqual(response.status, 200);
            assert.equal(getServerChannelState().streamingAvailability.summary().mark_count, 0);
        } finally {
            abortController.abort();
            await upstream.close();
        }
    });

    it('returns field-level errors for invalid edit multipart requests', async () => {
        const { editImage } = await loadAgentRoutes();
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        const response = await editImage(
            agentEditRequest('route-edit-validation-key', 'agent edit invalid', {}, 'url')
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.details.fields.response_mode, /path/);

        await upstream.close();
    });

    it('rejects Agent edit masks without transparent pixels before contacting upstream', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-mask-alpha-key',
                    'agent edit mask alpha',
                    {},
                    {
                        mask: Buffer.from(PNG_BASE64, 'base64')
                    }
                )
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.match(body.error.details.fields.mask, /mask 必须包含透明区域/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('rejects unsupported fields on Agent edit requests before calling upstream', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-generate-only-fields-key',
                    'agent edit invalid fields',
                    {},
                    {
                        imageBackend: 'responses-image-generation',
                        image_backend: 'responses-image-generation',
                        format: 'webp',
                        outputFormat: 'jpeg',
                        output_format: 'jpeg',
                        outputCompression: '80',
                        output_compression: '80',
                        responsesModel: 'gpt-4.1',
                        responses_model: 'gpt-4.1',
                        background: 'opaque',
                        moderation: 'auto'
                    }
                )
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.imageBackend, /不接受该字段/);
            assert.match(body.error.details.fields.image_backend, /不接受该字段/);
            assert.match(body.error.details.fields.format, /不接受该字段/);
            assert.match(body.error.details.fields.outputFormat, /不接受该字段/);
            assert.match(body.error.details.fields.output_format, /不接受该字段/);
            assert.match(body.error.details.fields.outputCompression, /不接受该字段/);
            assert.match(body.error.details.fields.output_compression, /不接受该字段/);
            assert.match(body.error.details.fields.responsesModel, /不接受该字段/);
            assert.match(body.error.details.fields.responses_model, /不接受该字段/);
            assert.match(body.error.details.fields.background, /不接受该字段/);
            assert.match(body.error.details.fields.moderation, /不接受该字段/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('rejects page-only streaming strategy fields on Agent edit requests before calling upstream', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-page-streaming-field-key',
                    'agent edit invalid page streaming field',
                    {},
                    {
                        image_streaming_strategy: 'force-sse',
                        imageStreamingStrategy: 'force-sse'
                    }
                )
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.image_streaming_strategy, /streaming_strategy/);
            assert.match(body.error.details.fields.imageStreamingStrategy, /streaming_strategy/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('rejects OpenAI-compatible Agent edit partial_images violations before calling upstream', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_PROFILE = 'openai-compatible';
        setPrimaryChannelRequestModes('images-sse');

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-profile-partial-key',
                    'agent edit invalid profile partial',
                    {},
                    {
                        stream_mode: 'stream',
                        streaming_strategy: 'force-sse',
                        partial_images: '0'
                    }
                )
            );

            assert.equal(response.status, 422);
            const body = await response.json();
            assert.equal(body.error.code, 'validation_error');
            assert.match(body.error.details.fields.partial_images, /1 到 3/);
            assert.equal(upstreamCalls, 0);
        } finally {
            await upstream.close();
        }
    });

    it('allows high-resolution Agent edit requests as an explicit fallback path', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_LANDSCAPE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await editImage(
                agentEditRequest('route-edit-high-resolution-key', 'high resolution edit', {}, { size: '3072x2048' })
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.images[0].output_format, 'webp');
            assert.equal(body.images[0].mime_type, 'image/webp');
            assert.equal(body.images[0].filename.endsWith('.webp'), true);
            assert.equal(upstreamCalls, 1);
        } finally {
            await upstream.close();
        }
    });

    it('allows Agent edit force_request to bypass local fixed-size profile limits', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.OPENAI_UPSTREAM_PROFILE = 'openai-compatible';

        try {
            const rejected = await editImage(
                agentEditRequest('route-edit-small-size-rejected-key', 'small edit', {}, { size: '512x512' })
            );
            assert.equal(rejected.status, 422);
            const rejectedBody = await rejected.json();
            assert.equal(rejectedBody.error.code, 'validation_error');
            assert.match(rejectedBody.error.details.fields.size, /总像素必须至少/);
            assert.equal(upstreamCalls, 0);

            const forced = await editImage(
                agentEditRequest(
                    'route-edit-small-size-forced-key',
                    'small edit',
                    {},
                    {
                        size: '512x512',
                        force_request: 'true'
                    }
                )
            );
            assert.equal(forced.status, 200);
            assert.equal(upstreamCalls, 1);
        } finally {
            await upstream.close();
        }
    });

    it('reports missing image files for high-resolution Agent edit before API credentials', async () => {
        const { editImage } = await loadAgentRoutes();
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_BASE_URL;

        const formData = new FormData();
        formData.append('prompt', 'high resolution edit without file');
        formData.append('model', 'gpt-image-2');
        formData.append('size', '3072x2048');
        formData.append('response_mode', 'path');

        const response = await editImage(
            new Request('http://localhost/api/agent/images/edit', {
                method: 'POST',
                headers: {
                    'Idempotency-Key': 'route-edit-high-resolution-no-file-key'
                },
                body: formData
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.match(body.error.message, /图片文件/);
        assert.doesNotMatch(body.error.message, /API Key/);
    });

    it('allows auto-size Agent edit when the uploaded source image is high resolution', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_LANDSCAPE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const response = await editImage(
                agentEditRequest(
                    'route-edit-auto-high-resolution-source-key',
                    'auto high resolution source',
                    {},
                    {
                        size: 'auto',
                        image_0: createPngWithDimensions(3072, 2048)
                    }
                )
            );

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.images[0].output_format, 'webp');
            assert.equal(body.images[0].mime_type, 'image/webp');
            assert.equal(body.images[0].filename.endsWith('.webp'), true);
            assert.equal(upstreamCalls, 1);
        } finally {
            await upstream.close();
        }
    });

    it('returns validation errors for non-multipart edit requests', async () => {
        const { editImage } = await loadAgentRoutes();

        const response = await editImage(
            new Request('http://localhost/api/agent/images/edit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'route-edit-non-multipart-key'
                },
                body: JSON.stringify({ prompt: 'not multipart' })
            })
        );

        assert.equal(response.status, 415);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.retryable, false);
    });

    it('returns validation errors for malformed edit multipart requests', async () => {
        const { editImage } = await loadAgentRoutes();

        const response = await editImage(
            new Request('http://localhost/api/agent/images/edit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'multipart/form-data; boundary=broken-boundary',
                    'Idempotency-Key': 'route-edit-malformed-multipart-key'
                },
                body: '--not-the-declared-boundary\r\n'
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.retryable, false);
    });

    it('returns sanitized upstream diagnostics for failed edit requests', async () => {
        const { editImage } = await loadAgentRoutes();
        let upstreamCalls = 0;
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            throw new Error('edit upstream failed');
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const idempotencyKey = 'route-edit-upstream-diagnostics-key';
            const response = await editImage(agentEditRequest(idempotencyKey, 'edit diagnostics'));
            assert.equal(response.status, 502);
            const body = await response.json();
            assert.equal(body.error.code, 'upstream_unavailable');
            assert.equal(body.error.upstream_status, 500);
            assert.equal(body.error.diagnostics.upstream_status, 500);
            assert.equal(body.error.diagnostics.selected_channel_id, 'default');
            assert.match(body.error.diagnostics.upstream_host, /^127\.0\.0\.1:\d+$/);
            assert.equal(body.error.diagnostics.channel_cooldown_scope, 'channel');
            assert.equal(typeof body.error.diagnostics.elapsed_ms, 'number');
            assert.equal(JSON.stringify(body).includes('test-key'), false);
            const upstreamCallsAfterFirstFailure = upstreamCalls;

            const replay = await editImage(agentEditRequest(idempotencyKey, 'edit diagnostics'));
            assert.equal(replay.status, 502);
            assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
            assert.equal(replay.headers.get('x-request-id'), body.error.request_id);
            const replayBody = await replay.json();
            assert.equal(replayBody.error.code, 'upstream_unavailable');
            assert.equal(replayBody.error.retryable, false);
            assert.equal(replayBody.error.request_id, body.error.request_id);
            assert.equal(upstreamCalls, upstreamCallsAfterFirstFailure);
        } finally {
            await upstream.close();
        }
    });

    it('does not mark a real upstream success as failed when edit state completion fails', async () => {
        const { editImage } = await loadAgentRoutes();
        const { setAgentStateStoreFactoryForTests } = await import('@/lib/agent-state-runtime');
        let upstreamCalls = 0;
        let failCalls = 0;
        let saveCalls = 0;
        const requestId = 'edit-completion-failure-request';
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_CONVERTIBLE_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setAgentStateStoreFactoryForTests(() => ({
            async init() {},
            async recoverExpiredRequests() {
                return 0;
            },
            async purgeExpiredRequests() {
                return 0;
            },
            async beginRequest() {
                return {
                    type: 'acquired',
                    record: {
                        requestId,
                        idempotencyKey: 'edit-completion-failure-key',
                        requestHash: 'hash',
                        mode: 'edit',
                        status: 'running',
                        requestJson: { fields: { prompt: 'state completion failure' } },
                        createdAt: '2026-05-12T00:00:00.000Z',
                        updatedAt: '2026-05-12T00:00:00.000Z',
                        expiresAt: '2026-05-13T00:00:00.000Z'
                    }
                };
            },
            async refreshRequestLease() {
                return false;
            },
            async saveArtifacts() {
                saveCalls += 1;
            },
            async completeRequest() {
                throw new Error('state completion failed');
            },
            async failRequest() {
                failCalls += 1;
            },
            async getRequest() {
                return undefined;
            },
            async getRequestByIdempotencyKey() {
                return undefined;
            },
            async getArtifact() {
                return undefined;
            },
            async listArtifactsForRequest() {
                return [];
            },
            async listArtifactFilepaths() {
                return [];
            },
            async deleteArtifact() {
                return false;
            }
        }));

        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await editImage(
                agentEditRequest('edit-completion-failure-key', 'state completion failure')
            );

            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.error.code, 'unexpected_error');
            assert.equal(body.error.retryable, true);
            assert.equal(body.error.request_id, requestId);
            assert.equal(upstreamCalls, 1);
            assert.equal(saveCalls, 1);
            assert.equal(failCalls, 0);
        } finally {
            console.error = originalConsoleError;
            await upstream.close();
        }
    });

    it('requires artifact content authorization and returns image bytes when authorized', async () => {
        const { generateImage, getArtifact, getArtifactContent, createArtifactShare, getShareContent, deleteArtifact } =
            await loadAgentRoutes();
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        process.env.AGENT_API_TOKEN = 'artifact-token';

        const generated = await generateImage(
            agentJsonRequest(
                'artifact-auth-key',
                { prompt: 'artifact auth' },
                { Authorization: 'Bearer artifact-token' }
            )
        );
        const body = await generated.json();
        const artifactId = body.images[0].id;

        const denied = await getArtifactContent(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}/content`),
            {
                params: Promise.resolve({ id: artifactId })
            }
        );
        assert.equal(denied.status, 401);
        assert.equal((await denied.json()).error.code, 'unauthorized');

        const allowed = await getArtifactContent(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}/content`, {
                headers: { Authorization: 'Bearer artifact-token' }
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('content-type'), 'image/png');
        assert.ok((await allowed.arrayBuffer()).byteLength > 0);

        const invalidContentTypeShare = await createArtifactShare(
            new Request(`http://internal.local/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token' },
                body: JSON.stringify({ access_code: '12345678' })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(invalidContentTypeShare.status, 400);
        assert.equal((await invalidContentTypeShare.json()).error.code, 'validation_error');

        const deniedShare = await createArtifactShare(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expires_in_minutes: 60 })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(deniedShare.status, 401);
        assert.equal((await deniedShare.json()).error.code, 'unauthorized');

        const relativeShare = await createArtifactShare(
            new Request(`http://spoofed.local/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ expires_in_minutes: 60 })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(relativeShare.status, 201);
        const relativeShareBody = await relativeShare.json();
        assert.equal(relativeShareBody.share_url, `/share/${relativeShareBody.token}`);
        assert.equal(relativeShareBody.direct_content_url, `/api/shares/${relativeShareBody.token}/content`);

        process.env.AGENT_PUBLIC_BASE_URL = 'https://public.example.test';
        const publicShare = await createArtifactShare(
            new Request(`http://internal.local/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ expires_in_minutes: 60 })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(publicShare.status, 201);
        const publicShareBody = await publicShare.json();
        assert.equal(publicShareBody.artifact_id, artifactId);
        assert.match(publicShareBody.token, /^[a-f0-9]{24}$/);
        assert.equal(publicShareBody.share_url, `https://public.example.test/share/${publicShareBody.token}`);
        assert.equal(
            publicShareBody.direct_content_url,
            `https://public.example.test/api/shares/${publicShareBody.token}/content`
        );
        assert.equal(publicShareBody.access_code_required, false);
        assert.equal(typeof publicShareBody.expires_at, 'string');

        process.env.AGENT_PUBLIC_BASE_URL = 'https://public.example.test/playground';
        const publicShareWithPath = await createArtifactShare(
            new Request(`http://internal.local/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ expires_in_minutes: 60 })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(publicShareWithPath.status, 201);
        const publicShareWithPathBody = await publicShareWithPath.json();
        assert.equal(
            publicShareWithPathBody.share_url,
            `https://public.example.test/playground/share/${publicShareWithPathBody.token}`
        );
        assert.equal(
            publicShareWithPathBody.direct_content_url,
            `https://public.example.test/playground/api/shares/${publicShareWithPathBody.token}/content`
        );

        const publicShareContent = await getShareContent(new Request(publicShareBody.direct_content_url), {
            params: Promise.resolve({ token: publicShareBody.token })
        });
        assert.equal(publicShareContent.status, 200);
        assert.equal(publicShareContent.headers.get('content-type'), 'image/png');
        assert.ok((await publicShareContent.arrayBuffer()).byteLength > 0);

        const protectedShare = await createArtifactShare(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_code: '12345678', expires_in_minutes: null })
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(protectedShare.status, 201);
        const protectedShareBody = await protectedShare.json();
        assert.equal(protectedShareBody.access_code_required, true);
        assert.equal(protectedShareBody.expires_at, null);
        const protectedGet = await getShareContent(new Request(protectedShareBody.direct_content_url), {
            params: Promise.resolve({ token: protectedShareBody.token })
        });
        assert.equal(protectedGet.status, 401);
        assert.equal((await protectedGet.json()).code, 'share_access_code_required');

        process.env.AGENT_ARTIFACT_SHARE_MAX_EXPIRES_MINUTES = '30';
        const defaultExpiryShare = await createArtifactShare(
            new Request(`http://internal.local/api/agent/artifacts/${artifactId}/share`, {
                method: 'POST',
                headers: { Authorization: 'Bearer artifact-token' }
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(defaultExpiryShare.status, 201);
        const defaultExpiryShareBody = await defaultExpiryShare.json();
        const defaultExpiryMs = new Date(defaultExpiryShareBody.expires_at).getTime() - Date.now();
        assert.ok(defaultExpiryMs > 0);
        assert.ok(defaultExpiryMs <= 30 * 60 * 1000);

        const metadata = await getArtifact(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}`, {
                headers: { Authorization: 'Bearer artifact-token' }
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(metadata.status, 200);
        const metadataBody = await metadata.json();
        assert.equal(metadataBody.artifact.id, artifactId);
        assert.equal(metadataBody.artifact.output_format, 'png');
        assert.equal(metadataBody.artifact.mime_type, 'image/png');
        assert.equal('filepath' in metadataBody.artifact, false);

        const deleted = await deleteArtifact(
            new Request(`http://localhost/api/agent/artifacts/${artifactId}`, {
                method: 'DELETE',
                headers: { Authorization: 'Bearer artifact-token' }
            }),
            { params: Promise.resolve({ id: artifactId }) }
        );
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json()).deleted, true);

        const replayAfterDelete = await generateImage(
            agentJsonRequest(
                'artifact-auth-key',
                { prompt: 'artifact auth' },
                { Authorization: 'Bearer artifact-token' }
            )
        );
        assert.equal(replayAfterDelete.status, 404);
        assert.equal((await replayAfterDelete.json()).error.code, 'artifact_not_found');

        await upstream.close();
    });

    it('returns not found when artifact metadata exists but content file is missing', async () => {
        const { generateImage, getArtifactContent } = await loadAgentRoutes();
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

        try {
            const generated = await generateImage(
                agentJsonRequest('artifact-missing-content-key', { prompt: 'missing content' })
            );
            const body = await generated.json();
            const image = body.images[0];
            await rm(readStoredArtifactFilepath(image.id), { force: true });

            const missing = await getArtifactContent(
                new Request(`http://localhost/api/agent/artifacts/${image.id}/content`),
                { params: Promise.resolve({ id: image.id }) }
            );

            assert.equal(missing.status, 404);
            assert.equal((await missing.json()).error.code, 'artifact_not_found');
        } finally {
            await upstream.close();
        }
    });

    it('persists page feedback and lets Agent clients read it by page request id', async () => {
        const { putFeedback, getPageRequestFeedback, getPageRequestFeedbackBatch } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-token';

        const saved = await putFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-agent-route', filename: 'feedback.png' }],
                    value: 'needs_revision',
                    note: 'text overlaps subject',
                    updatedAt: '2026-05-12T00:00:00.000Z'
                })
            })
        );
        assert.equal(saved.status, 200);
        const savedBody = await saved.json();
        assert.equal(savedBody.feedback.length, 1);

        const response = await getPageRequestFeedback(
            new Request('http://localhost/api/agent/page-requests/web-feedback-agent-route/feedback', {
                headers: { Authorization: 'Bearer feedback-token' }
            }),
            { params: Promise.resolve({ id: 'web-feedback-agent-route' }) }
        );

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.feedback, {
            target_type: 'page_request',
            target_id: 'web-feedback-agent-route',
            value: 'needs_revision',
            note: 'text overlaps subject',
            source: 'webui',
            updated_at: '2026-05-12T00:00:00.000Z'
        });

        const batchResponse = await getPageRequestFeedbackBatch(
            new Request('http://localhost/api/agent/page-requests/feedback', {
                method: 'POST',
                headers: { Authorization: 'Bearer feedback-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: ['web-feedback-agent-route', 'web-feedback-missing'] })
            })
        );
        assert.equal(batchResponse.status, 200);
        const batchBody = await batchResponse.json();
        assert.deepEqual(batchBody.targets, [
            { type: 'page_request', id: 'web-feedback-agent-route' },
            { type: 'page_request', id: 'web-feedback-missing' }
        ]);
        assert.deepEqual(batchBody.feedback, [body.feedback]);
    });

    it('returns validation errors for malformed page feedback batch JSON requests', async () => {
        const { getPageRequestFeedbackBatch } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-malformed-json-token';

        const response = await getPageRequestFeedbackBatch(
            new Request('http://localhost/api/agent/page-requests/feedback', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer feedback-malformed-json-token',
                    'Content-Type': 'application/json'
                },
                body: '{"ids":'
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.retryable, false);
    });

    it('returns validation errors for non-string page feedback batch ids', async () => {
        const { getPageRequestFeedbackBatch } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-invalid-ids-token';

        const response = await getPageRequestFeedbackBatch(
            new Request('http://localhost/api/agent/page-requests/feedback', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer feedback-invalid-ids-token',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ids: ['web-feedback-id', 123] })
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.message, 'ids 数组必须只包含字符串 ID。');
    });

    it('deduplicates page feedback batch ids before applying the max-id limit', async () => {
        const { getPageRequestFeedbackBatch } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-id-dedupe-token';

        const response = await getPageRequestFeedbackBatch(
            new Request('http://localhost/api/agent/page-requests/feedback', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer feedback-id-dedupe-token',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ids: Array.from({ length: 60 }, () => 'web-feedback-same-id') })
            })
        );

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.targets, [{ type: 'page_request', id: 'web-feedback-same-id' }]);
        assert.deepEqual(body.feedback, []);
    });

    it('deduplicates repeated page feedback targets before persisting them', async () => {
        const { putFeedback, getPageRequestFeedback } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-dedupe-token';

        const saved = await putFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [
                        { type: 'page_request', id: 'web-feedback-duplicate' },
                        { type: 'page_request', id: 'web-feedback-duplicate' }
                    ],
                    value: 'usable',
                    updatedAt: '2026-05-12T00:00:00.000Z'
                })
            })
        );

        assert.equal(saved.status, 200);
        const savedBody = await saved.json();
        assert.deepEqual(
            savedBody.feedback.map((item: { target_id: string }) => item.target_id),
            ['web-feedback-duplicate']
        );

        const response = await getPageRequestFeedback(
            new Request('http://localhost/api/agent/page-requests/web-feedback-duplicate/feedback', {
                headers: { Authorization: 'Bearer feedback-dedupe-token' }
            }),
            { params: Promise.resolve({ id: 'web-feedback-duplicate' }) }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).feedback.value, 'usable');
    });

    it('returns validation errors for non-serializable WebUI feedback timestamps', async () => {
        const { putFeedback, deleteFeedback } = await loadAgentRoutes();

        const invalidUpdatedAt = await putFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-invalid-updated-at' }],
                    value: 'usable',
                    updatedAt: 1e20
                })
            })
        );
        assert.equal(invalidUpdatedAt.status, 400);
        const invalidUpdatedAtBody = await invalidUpdatedAt.json();
        assert.equal(invalidUpdatedAtBody.code, 'invalid_feedback_request');
        assert.equal(invalidUpdatedAtBody.error, '反馈更新时间无效。');

        const invalidDeletedAt = await deleteFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-invalid-deleted-at' }],
                    deletedAt: 1e20
                })
            })
        );
        assert.equal(invalidDeletedAt.status, 400);
        const invalidDeletedAtBody = await invalidDeletedAt.json();
        assert.equal(invalidDeletedAtBody.code, 'invalid_feedback_delete_request');
        assert.equal(invalidDeletedAtBody.error, '反馈删除时间无效。');
    });

    it('deletes page feedback when the WebUI clears matching page request targets', async () => {
        const { putFeedback, deleteFeedback, getPageRequestFeedback } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-delete-token';

        const saved = await putFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-delete-route' }],
                    value: 'usable',
                    updatedAt: '2026-05-12T00:00:00.000Z'
                })
            })
        );
        assert.equal(saved.status, 200);

        const deleted = await deleteFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targets: [{ type: 'page_request', id: 'web-feedback-delete-route' }] })
            })
        );
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json()).deleted, 1);

        const response = await getPageRequestFeedback(
            new Request('http://localhost/api/agent/page-requests/web-feedback-delete-route/feedback', {
                headers: { Authorization: 'Bearer feedback-delete-token' }
            }),
            { params: Promise.resolve({ id: 'web-feedback-delete-route' }) }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).feedback, null);
    });

    it('does not let stale WebUI feedback deletes remove newer feedback', async () => {
        const { putFeedback, deleteFeedback, getPageRequestFeedback } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'feedback-delete-stale-token';

        const saved = await putFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-delete-stale-route' }],
                    value: 'needs_revision',
                    note: 'latest feedback',
                    updatedAt: '2026-05-12T00:02:00.000Z'
                })
            })
        );
        assert.equal(saved.status, 200);

        const staleDeleted = await deleteFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-delete-stale-route' }],
                    deletedAt: '2026-05-12T00:01:00.000Z'
                })
            })
        );
        assert.equal(staleDeleted.status, 200);
        assert.equal((await staleDeleted.json()).deleted, 0);

        const retained = await getPageRequestFeedback(
            new Request('http://localhost/api/agent/page-requests/web-feedback-delete-stale-route/feedback', {
                headers: { Authorization: 'Bearer feedback-delete-stale-token' }
            }),
            { params: Promise.resolve({ id: 'web-feedback-delete-stale-route' }) }
        );
        assert.equal(retained.status, 200);
        assert.equal((await retained.json()).feedback.note, 'latest feedback');

        const currentDeleted = await deleteFeedback(
            new Request('http://localhost/api/feedback', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targets: [{ type: 'page_request', id: 'web-feedback-delete-stale-route' }],
                    deletedAt: '2026-05-12T00:03:00.000Z'
                })
            })
        );
        assert.equal(currentDeleted.status, 200);
        assert.equal((await currentDeleted.json()).deleted, 1);

        const cleared = await getPageRequestFeedback(
            new Request('http://localhost/api/agent/page-requests/web-feedback-delete-stale-route/feedback', {
                headers: { Authorization: 'Bearer feedback-delete-stale-token' }
            }),
            { params: Promise.resolve({ id: 'web-feedback-delete-stale-route' }) }
        );
        assert.equal(cleared.status, 200);
        assert.equal((await cleared.json()).feedback, null);
    });

    it('returns machine-readable Agent diagnostics for page request logs', async () => {
        const { getPageRequestDiagnostics, getPageRequestDiagnosticsBatch } = await loadAgentRoutes();
        const { appLogger, clearAppLogEntriesForTest } = await import('@/lib/app-logger');
        process.env.AGENT_API_TOKEN = 'diagnostics-token';
        clearAppLogEntriesForTest();
        appLogger.info('流式生成完成。', {
            clientRequestId: 'web-diagnostics-request',
            filenames: ['diagnostic.png'],
            providerDialect: 'sdk_parsed_fallback',
            normalizedEventCount: 1,
            reason: 'json_final_fallback',
            image_backend: 'images-api',
            operation: 'generate'
        });
        appLogger.warn('流式生成回退。', {
            clientRequestId: 'web-diagnostics-request-2',
            filenames: ['diagnostic-2.png'],
            reason: 'json_final_fallback',
            image_backend: 'images-api',
            operation: 'generate'
        });

        const response = await getPageRequestDiagnostics(
            new Request('http://localhost/api/agent/diagnostics/page-requests/web-diagnostics-request', {
                headers: { Authorization: 'Bearer diagnostics-token' }
            }),
            { params: Promise.resolve({ id: 'web-diagnostics-request' }) }
        );

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.scope.request_ids[0], 'web-diagnostics-request');
        assert.equal(body.matched_log_count, 1);
        assert.equal(body.events[0].client_request_id, 'web-diagnostics-request');
        assert.equal(body.events[0].diagnostics.providerDialect, 'sdk_parsed_fallback');
        assert.equal(body.events[0].diagnostics.normalizedEventCount, 1);
        assert.equal(body.events[0].diagnostics.reason, 'json_final_fallback');
        assert.equal(body.diagnostics_retention.storage, 'bounded_local_jsonl');
        assert.equal(body.diagnostics_retention.configured_by, 'APP_LOG_MAX_ENTRIES');

        const missingResponse = await getPageRequestDiagnostics(
            new Request('http://localhost/api/agent/diagnostics/page-requests/web-diagnostics-missing', {
                headers: { Authorization: 'Bearer diagnostics-token' }
            }),
            { params: Promise.resolve({ id: 'web-diagnostics-missing' }) }
        );
        assert.equal(missingResponse.status, 200);
        const missingBody = await missingResponse.json();
        assert.equal(missingBody.matched_log_count, 0);
        assert.equal(missingBody.diagnostics_note.code, 'no_matching_logs_in_retention_window');
        assert.equal(missingBody.diagnostics_note.retention.max_entries, missingBody.diagnostics_retention.max_entries);

        const batchResponse = await getPageRequestDiagnosticsBatch(
            new Request('http://localhost/api/agent/diagnostics/page-requests', {
                method: 'POST',
                headers: { Authorization: 'Bearer diagnostics-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ids: ['web-diagnostics-request', 'web-diagnostics-request-2'],
                    filenames: ['diagnostic-2.png']
                })
            })
        );
        assert.equal(batchResponse.status, 200);
        const batchBody = await batchResponse.json();
        assert.deepEqual(batchBody.targets, [
            { type: 'page_request', id: 'web-diagnostics-request' },
            { type: 'page_request', id: 'web-diagnostics-request-2' }
        ]);
        assert.deepEqual(
            batchBody.diagnostics.map((item: { client_request_id: string }) => item.client_request_id),
            ['web-diagnostics-request', 'web-diagnostics-request-2']
        );
        assert.equal(batchBody.diagnostics[0].matched_log_count, 2);
        assert.deepEqual(batchBody.diagnostics[0].scope.filename_matched_request_ids, ['web-diagnostics-request-2']);
        assert.equal(batchBody.diagnostics[1].matched_log_count, 1);
        assert.equal(batchBody.diagnostics_retention.storage, 'bounded_local_jsonl');
        assert.equal(
            batchBody.diagnostics[0].diagnostics_retention.max_entries,
            batchBody.diagnostics_retention.max_entries
        );
    });

    it('returns validation errors for malformed page diagnostics batch JSON requests', async () => {
        const { getPageRequestDiagnosticsBatch } = await loadAgentRoutes();
        process.env.AGENT_API_TOKEN = 'diagnostics-malformed-json-token';

        const response = await getPageRequestDiagnosticsBatch(
            new Request('http://localhost/api/agent/diagnostics/page-requests', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer diagnostics-malformed-json-token',
                    'Content-Type': 'application/json'
                },
                body: '{"ids":'
            })
        );

        assert.equal(response.status, 422);
        const body = await response.json();
        assert.equal(body.error.code, 'validation_error');
        assert.equal(body.error.retryable, false);
    });

    it('does not mark a real upstream success as failed when state completion fails', async () => {
        const { generateImage } = await loadAgentRoutes();
        const { setAgentStateStoreFactoryForTests } = await import('@/lib/agent-state-runtime');
        let upstreamCalls = 0;
        let failCalls = 0;
        let saveCalls = 0;
        const requestId = 'completion-failure-request';
        const upstream = await startImageUpstream(() => {
            upstreamCalls += 1;
            return { data: [{ b64_json: PNG_BASE64 }] };
        });
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setAgentStateStoreFactoryForTests(() => ({
            async init() {},
            async recoverExpiredRequests() {
                return 0;
            },
            async purgeExpiredRequests() {
                return 0;
            },
            async beginRequest() {
                return {
                    type: 'acquired',
                    record: {
                        requestId,
                        idempotencyKey: 'completion-failure-key',
                        requestHash: 'hash',
                        mode: 'generate',
                        status: 'running',
                        requestJson: { prompt: 'state completion failure' },
                        createdAt: '2026-05-12T00:00:00.000Z',
                        updatedAt: '2026-05-12T00:00:00.000Z',
                        expiresAt: '2026-05-13T00:00:00.000Z'
                    }
                };
            },
            async refreshRequestLease() {
                return false;
            },
            async saveArtifacts() {
                saveCalls += 1;
            },
            async completeRequest() {
                throw new Error('state completion failed');
            },
            async failRequest() {
                failCalls += 1;
            },
            async getRequest() {
                return undefined;
            },
            async getRequestByIdempotencyKey() {
                return undefined;
            },
            async getArtifact() {
                return undefined;
            },
            async listArtifactsForRequest() {
                return [];
            },
            async listArtifactFilepaths() {
                return [];
            },
            async deleteArtifact() {
                return false;
            }
        }));

        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await generateImage(
                agentJsonRequest('completion-failure-key', { prompt: 'state completion failure' })
            );

            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.error.code, 'unexpected_error');
            assert.equal(body.error.retryable, true);
            assert.equal(body.error.request_id, requestId);
            assert.equal(upstreamCalls, 1);
            assert.equal(saveCalls, 1);
            assert.equal(failCalls, 0);
        } finally {
            console.error = originalConsoleError;
        }

        await upstream.close();
    });

    it('does not return artifact URLs when artifact metadata persistence fails', async () => {
        const { generateImage } = await loadAgentRoutes();
        const { setAgentStateStoreFactoryForTests } = await import('@/lib/agent-state-runtime');
        const requestId = 'artifact-save-failure-request';
        const upstream = await startImageUpstream(() => ({ data: [{ b64_json: PNG_BASE64 }] }));
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_API_BASE_URL = upstream.baseUrl;
        setAgentStateStoreFactoryForTests(() => ({
            async init() {},
            async recoverExpiredRequests() {
                return 0;
            },
            async purgeExpiredRequests() {
                return 0;
            },
            async beginRequest() {
                return {
                    type: 'acquired',
                    record: {
                        requestId,
                        idempotencyKey: 'artifact-save-failure-key',
                        requestHash: 'hash',
                        mode: 'generate',
                        status: 'running',
                        requestJson: { prompt: 'artifact save failure' },
                        createdAt: '2026-05-12T00:00:00.000Z',
                        updatedAt: '2026-05-12T00:00:00.000Z',
                        expiresAt: '2026-05-13T00:00:00.000Z'
                    }
                };
            },
            async refreshRequestLease() {
                return false;
            },
            async saveArtifacts() {
                throw new Error('artifact metadata save failed');
            },
            async completeRequest() {},
            async failRequest(input: { requestId: string; error: { error: { retryable: boolean } } }) {
                assert.equal(input.requestId, requestId);
                assert.equal(input.error.error.retryable, true);
            },
            async getRequest() {
                return undefined;
            },
            async getRequestByIdempotencyKey() {
                return undefined;
            },
            async getArtifact() {
                return undefined;
            },
            async listArtifactsForRequest() {
                return [];
            },
            async listArtifactFilepaths() {
                return [];
            },
            async deleteArtifact() {
                return false;
            }
        }));

        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await generateImage(
                agentJsonRequest('artifact-save-failure-key', { prompt: 'artifact save failure' })
            );

            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.error.code, 'unexpected_error');
            assert.equal(body.error.retryable, true);
            assert.equal(body.error.request_id, requestId);
            assert.deepEqual(await listGeneratedImageFiles(), []);
        } finally {
            console.error = originalConsoleError;
            await upstream.close();
        }
    });
});

const livePostgresUrl = process.env.AGENT_POSTGRES_TEST_DATABASE_URL;

describe(
    'Agent route PostgreSQL integration',
    { skip: livePostgresUrl ? false : 'AGENT_POSTGRES_TEST_DATABASE_URL is not set' },
    () => {
        it('allows only one upstream winner for concurrent identical idempotency requests', async () => {
            assert.ok(livePostgresUrl);
            const { generateImage } = await loadAgentRoutes();
            const schemaName = `agent_route_${Date.now().toString(36)}`;
            const pool = new Pool({ connectionString: livePostgresUrl });
            process.env.AGENT_STATE_BACKEND = 'postgres';
            process.env.AGENT_DATABASE_URL = `${livePostgresUrl}${livePostgresUrl.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schemaName}`;
            process.env.AGENT_REQUEST_LEASE_MS = '60000';
            const admin = await pool.connect();
            let releaseUpstream: (() => void) | undefined;
            let upstreamCalls = 0;
            const upstream = await startImageUpstream(async () => {
                upstreamCalls += 1;
                await new Promise<void>((resolve) => {
                    releaseUpstream = resolve;
                });
                return { data: [{ b64_json: PNG_BASE64 }] };
            });
            process.env.OPENAI_API_KEY = 'test-key';
            process.env.OPENAI_API_BASE_URL = upstream.baseUrl;

            try {
                await admin.query(`CREATE SCHEMA "${schemaName}"`);
                const firstRequest = generateImage(
                    agentJsonRequest('pg-route-concurrent-key', { prompt: 'pg concurrent' })
                );
                await waitFor(() => upstreamCalls === 1);

                const second = await generateImage(
                    agentJsonRequest('pg-route-concurrent-key', { prompt: 'pg concurrent' })
                );
                assert.equal(second.status, 409);
                const secondBody = await second.json();
                assert.equal(secondBody.error.code, 'request_in_progress');
                assert.equal(secondBody.error.retryable, true);
                assert.equal(second.headers.has('retry-after'), true);

                releaseUpstream?.();
                const first = await firstRequest;
                assert.equal(first.status, 200);

                const replay = await generateImage(
                    agentJsonRequest('pg-route-concurrent-key', { prompt: 'pg concurrent' })
                );
                assert.equal(replay.status, 200);
                assert.equal((await replay.json()).cached, true);
                assert.equal(upstreamCalls, 1);
            } finally {
                releaseUpstream?.();
                await upstream.close();
                await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
                admin.release();
                await pool.end();
            }
        });
    }
);

async function loadAgentRoutes() {
    const { resetAgentStateStoreForTests } = await import('@/lib/agent-state-runtime');
    const { resetServerChannelStateForTests } = await import('@/lib/server-channel-router');
    await resetAgentStateStoreForTests();
    resetServerChannelStateForTests();
    const generateRoute = await import('./images/generate/route');
    const editRoute = await import('./images/edit/route');
    const artifactRoute = await import('./artifacts/[id]/route');
    const artifactContentRoute = await import('./artifacts/[id]/content/route');
    const artifactShareRoute = await import('./artifacts/[id]/share/route');
    const capabilitiesRoute = await import('./capabilities/route');
    const imageRequestRoute = await import('./image-requests/route');
    const createGenerateJobRoute = await import('./jobs/images/generate/route');
    const jobRoute = await import('./jobs/[id]/route');
    const jobResultRoute = await import('./jobs/[id]/result/route');
    const feedbackRoute = await import('../feedback/route');
    const pageRequestFeedbackBatchRoute = await import('./page-requests/feedback/route');
    const pageRequestFeedbackRoute = await import('./page-requests/[id]/feedback/route');
    const agentRequestDiagnosticsLookupRoute = await import('./diagnostics/requests/route');
    const agentRequestDiagnosticsRoute = await import('./diagnostics/requests/[id]/route');
    const pageRequestDiagnosticsBatchRoute = await import('./diagnostics/page-requests/route');
    const pageRequestDiagnosticsRoute = await import('./diagnostics/page-requests/[id]/route');
    const shareContentRoute = await import('../shares/[token]/content/route');
    return {
        getCapabilities: () => capabilitiesRoute.GET(),
        generateImage: (request: Request) => generateRoute.POST(asNextRequest(request)),
        editImage: (request: Request) => editRoute.POST(asNextRequest(request)),
        createImageRequest: (request: Request) => imageRequestRoute.POST(asNextRequest(request)),
        createGenerateJob: (request: Request) => createGenerateJobRoute.POST(asNextRequest(request)),
        getJob: (request: Request, context: AgentRouteContext) => jobRoute.GET(asNextRequest(request), context),
        getJobResult: (request: Request, context: AgentRouteContext) =>
            jobResultRoute.GET(asNextRequest(request), context),
        getArtifact: (request: Request, context: AgentRouteContext) =>
            artifactRoute.GET(asNextRequest(request), context),
        deleteArtifact: (request: Request, context: AgentRouteContext) =>
            artifactRoute.DELETE(asNextRequest(request), context),
        getArtifactContent: (request: Request, context: AgentRouteContext) =>
            artifactContentRoute.GET(asNextRequest(request), context),
        createArtifactShare: (request: Request, context: AgentRouteContext) =>
            artifactShareRoute.POST(asNextRequest(request), context),
        getShareContent: (request: Request, context: { params: Promise<{ token: string }> }) =>
            shareContentRoute.GET(asNextRequest(request), context),
        putFeedback: (request: Request) => feedbackRoute.PUT(asNextRequest(request)),
        deleteFeedback: (request: Request) => feedbackRoute.DELETE(asNextRequest(request)),
        getPageRequestFeedbackBatch: (request: Request) => pageRequestFeedbackBatchRoute.POST(asNextRequest(request)),
        getPageRequestFeedback: (request: Request, context: AgentRouteContext) =>
            pageRequestFeedbackRoute.GET(asNextRequest(request), context),
        lookupAgentRequestDiagnostics: (request: Request) =>
            agentRequestDiagnosticsLookupRoute.GET(asNextRequest(request)),
        getAgentRequestDiagnostics: (request: Request, context: AgentRouteContext) =>
            agentRequestDiagnosticsRoute.GET(asNextRequest(request), context),
        getPageRequestDiagnosticsBatch: (request: Request) =>
            pageRequestDiagnosticsBatchRoute.POST(asNextRequest(request)),
        getPageRequestDiagnostics: (request: Request, context: AgentRouteContext) =>
            pageRequestDiagnosticsRoute.GET(asNextRequest(request), context)
    };
}

type AgentRouteContext = { params: Promise<{ id: string }> };

function asNextRequest(request: Request): NextRequest {
    return request as unknown as NextRequest;
}

function agentJsonRequest(idempotencyKey: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const requestBody = buildAgentGenerateRequestBody(body);
    return new Request('http://localhost/api/agent/images/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            ...headers
        },
        body: JSON.stringify(requestBody)
    });
}

function agentJobJsonRequest(
    idempotencyKey: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
) {
    const requestBody = buildAgentGenerateRequestBody(body);
    return new Request('http://localhost/api/agent/jobs/images/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            ...headers
        },
        body: JSON.stringify(requestBody)
    });
}

function agentImageRequest(
    idempotencyKey: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
) {
    const requestBody = buildAgentGenerateRequestBody(body);
    return new Request('http://localhost/api/agent/image-requests', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            ...headers
        },
        body: JSON.stringify(requestBody)
    });
}

function buildAgentGenerateRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return {
        ...body,
        ...('stream_mode' in body || 'streaming_strategy' in body ? {} : { stream_mode: 'non_stream' }),
        ...('output_format' in body ? {} : { output_format: 'png' })
    };
}

type AgentEditRequestFields = {
    image_0?: Buffer;
    mask?: Buffer;
    [field: string]: string | Buffer | undefined;
};

function agentEditRequest(
    idempotencyKey: string,
    prompt: string,
    headers: Record<string, string> = {},
    responseModeOrFields: string | AgentEditRequestFields = 'path',
    options: { signal?: AbortSignal } = {}
) {
    const fields: AgentEditRequestFields =
        typeof responseModeOrFields === 'string'
            ? { response_mode: responseModeOrFields }
            : { response_mode: 'path', ...responseModeOrFields };
    if (!('stream_mode' in fields) && !('streaming_strategy' in fields)) {
        fields.stream_mode = 'non_stream';
    }
    const imageBuffer = fields.image_0 ?? Buffer.from(PNG_BASE64, 'base64');
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('model', 'gpt-image-2');
    for (const [key, value] of Object.entries(fields)) {
        if (key === 'image_0' || key === 'mask') continue;
        if (typeof value !== 'string') {
            throw new TypeError(`Agent edit test field ${key} must be a string.`);
        }
        formData.append(key, value);
    }
    formData.append('image_0', new File([imageBuffer], 'input.png', { type: 'image/png' }));
    if (fields.mask) {
        formData.append('mask', new File([fields.mask], 'mask.png', { type: 'image/png' }));
    }
    return new Request('http://localhost/api/agent/images/edit', {
        method: 'POST',
        headers: {
            'Idempotency-Key': idempotencyKey,
            ...headers
        },
        body: formData,
        signal: options.signal
    });
}

function createPngWithDimensions(width: number, height: number, grayscale = 0x7f): Buffer {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new RangeError('PNG fixture dimensions must be positive safe integers.');
    }
    if (!Number.isInteger(grayscale) || grayscale < 0 || grayscale > 0xff) {
        throw new RangeError('PNG fixture grayscale must be an 8-bit integer.');
    }

    const raw = Buffer.alloc((width + 1) * height, grayscale);
    for (let row = 0; row < height; row += 1) {
        raw[row * (width + 1)] = 0;
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
        createPngChunk('IHDR', ihdr),
        createPngChunk('IDAT', deflateSync(raw)),
        createPngChunk('IEND', Buffer.alloc(0))
    ]);
}

function createPngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBytes, data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, checksum]);
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function startImageUpstream(
    handler: (
        body: string,
        url: string,
        request: http.IncomingMessage,
        response: http.ServerResponse
    ) => unknown | Promise<unknown>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer(async (request, response) => {
        if (
            request.method !== 'POST' ||
            (!request.url?.endsWith('/images/generations') && !request.url?.endsWith('/images/edits'))
        ) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve) => request.on('end', resolve));
        try {
            const body = await handler(Buffer.concat(chunks).toString('utf8'), request.url || '', request, response);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
        } catch (error) {
            response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : '上游失败' } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    return {
        baseUrl,
        close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    };
}

async function startHangingImageEditUpstream(): Promise<{
    baseUrl: string;
    readonly requests: number;
    close: () => Promise<void>;
}> {
    let requests = 0;
    const sockets = new Set<Socket>();
    const server = http.createServer(async (request, response) => {
        if (request.method === 'POST' && request.url?.endsWith('/images/edits')) {
            requests += 1;
            request.resume();
            return;
        }
        request.resume();
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        get requests() {
            return requests;
        },
        close: () =>
            new Promise((resolve, reject) => {
                for (const socket of sockets) socket.destroy();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
}

async function startStreamingImageUpstream(
    handler: (
        body: string
    ) => Array<{ event?: string; data: unknown }> | Promise<Array<{ event?: string; data: unknown }>>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const sockets = new Set<Socket>();
    const server = http.createServer(async (request, response) => {
        const isImageStreamPath =
            request.url?.endsWith('/images/generations') || request.url?.endsWith('/images/edits');
        if (request.method !== 'POST' || !isImageStreamPath) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve) => request.on('end', resolve));
        const events = await handler(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of events) {
            if (event.event) {
                response.write(`event: ${event.event}\n`);
            }
            response.write(`data: ${JSON.stringify(event.data)}\n\n`);
        }
        response.write('data: [DONE]\n\n');
        response.end();
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
            new Promise((resolve, reject) => {
                for (const socket of sockets) socket.destroy();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
}

async function startStreamingResponsesImageUpstream(
    handler: (
        body: string
    ) => Array<{ event?: string; data: unknown }> | Promise<Array<{ event?: string; data: unknown }>>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const sockets = new Set<Socket>();
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve) => request.on('end', resolve));
        const events = await handler(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of events) {
            if (event.event) {
                response.write(`event: ${event.event}\n`);
            }
            response.write(`data: ${JSON.stringify(event.data)}\n\n`);
        }
        response.write('data: [DONE]\n\n');
        response.end();
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
            new Promise((resolve, reject) => {
                for (const socket of sockets) socket.destroy();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
}

async function startResponsesImageJsonUpstream(
    status: number,
    body: unknown,
    onRequestBody?: (body: string) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        if (onRequestBody) {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            await new Promise<void>((resolve) => request.on('end', resolve));
            onRequestBody(Buffer.concat(chunks).toString('utf8'));
        } else {
            request.resume();
        }
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    };
}

function readStoredResponseJson(idempotencyKey: string): string {
    const db = new Database(path.join(tempDir, 'agent.sqlite'), { readonly: true });
    try {
        const row = db
            .prepare('SELECT response_json FROM agent_requests WHERE idempotency_key = ?')
            .get(idempotencyKey) as { response_json: string } | undefined;
        assert.ok(row);
        return row.response_json;
    } finally {
        db.close();
    }
}

function readStoredArtifactFilepath(id: string): string {
    const db = new Database(path.join(tempDir, 'agent.sqlite'), { readonly: true });
    try {
        const row = db.prepare('SELECT filepath FROM agent_artifacts WHERE id = ?').get(id) as
            { filepath: string } | undefined;
        assert.ok(row);
        return row.filepath;
    } finally {
        db.close();
    }
}

async function listGeneratedImageFiles(): Promise<string[]> {
    try {
        return (await readdir(path.join(tempDir, 'generated-images'))).filter((entry) =>
            /\.(png|jpe?g|webp)$/i.test(entry)
        );
    } catch {
        return [];
    }
}

async function listAgentStateFiles(): Promise<string[]> {
    try {
        return await readdir(path.join(tempDir, 'generated-images', '.agent-state'));
    } catch {
        return [];
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待条件超时');
}

async function waitForJobResult(
    getJobResult: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
    id: string
): Promise<Response> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await getJobResult(new Request(`http://localhost/api/agent/jobs/${id}/result`), {
            params: Promise.resolve({ id })
        });
        if (response.status !== 409) {
            return response;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待 job result 超时');
}
