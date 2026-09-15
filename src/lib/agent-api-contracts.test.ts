import {
    AGENT_PAGE_REQUEST_DIAGNOSTICS_NO_MATCH_HINT,
    AGENT_PAGE_SSE_AGENT_USAGE,
    AGENT_SCHEMA_VERSION,
    PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH,
    buildAgentAuthCapabilities,
    buildAgentCapabilities,
    buildPageRequestDiagnosticsCapabilities,
    readAgentLeaseMs,
    readAgentPublicBaseUrl,
    readAgentRecoveryIntervalMs,
    readAgentRequestTtlSeconds,
    validateAgentGenerateRequest
} from './agent-api-contracts';
import { AGENT_ENDPOINTS, AGENT_JOB_ENDPOINTS } from './agent-api-paths.mjs';
import { buildAgentOpenApiDocument } from './agent-openapi';
import { RequestValidationError } from './image-request-utils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
        process.env[key] = value;
    }
}

describe('validateAgentGenerateRequest', () => {
    it('accepts a minimal JSON generate request and applies Agent defaults', () => {
        assert.deepEqual(validateAgentGenerateRequest({ prompt: 'draw a stable test image' }), {
            model: 'gpt-image-2',
            prompt: 'draw a stable test image',
            n: 1,
            size: '1024x1024',
            quality: 'high',
            output_format: 'webp',
            output_compression: 100,
            background: 'auto',
            moderation: 'auto',
            response_mode: 'path',
            image_backend: 'images-api',
            stream_mode: 'auto',
            streaming_strategy: 'auto',
            partial_images: 2
        });
    });

    it('accepts explicit Agent upstream streaming strategy fields', () => {
        assert.deepEqual(
            validateAgentGenerateRequest({
                prompt: 'draw a stable streaming image',
                image_backend: 'images',
                streaming_strategy: 'newapi-keepalive-sse',
                partial_images: 3
            }),
            {
                model: 'gpt-image-2',
                prompt: 'draw a stable streaming image',
                n: 1,
                size: '1024x1024',
                quality: 'high',
                output_format: 'webp',
                output_compression: 100,
                background: 'auto',
                moderation: 'auto',
                response_mode: 'path',
                image_backend: 'images-api',
                stream_mode: 'auto',
                streaming_strategy: 'newapi-keepalive-sse',
                partial_images: 3
            }
        );
    });

    it('accepts Agent generate response controls as service-owned intent fields', () => {
        assert.deepEqual(
            validateAgentGenerateRequest({
                prompt: 'draw a stable generate request',
                image_backend: 'responses-image-generation',
                responsesModel: 'gpt-5.4-mini',
                thinking: 'medium',
                promptOptimization: false
            }),
            {
                model: 'gpt-image-2',
                prompt: 'draw a stable generate request',
                n: 1,
                size: '1024x1024',
                quality: 'high',
                output_format: 'webp',
                output_compression: 100,
                background: 'auto',
                moderation: 'auto',
                response_mode: 'path',
                image_backend: 'responses-image-generation',
                stream_mode: 'auto',
                streaming_strategy: 'auto',
                partial_images: 2,
                responsesModel: 'gpt-5.4-mini',
                thinking: 'medium',
                promptOptimization: false
            }
        );
    });

    it('rejects Responses streaming partial image counts outside the backend contract', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'draw a responses image',
                    image_backend: 'responses-image-generation',
                    stream_mode: 'stream',
                    streaming_strategy: 'responses-sse',
                    partial_images: 0
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.partial_images, /1 到 3/);
                return true;
            }
        );
    });

    it('rejects Responses backend output counts outside the backend contract', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'draw more than one responses image',
                    image_backend: 'responses-image-generation',
                    n: 2
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.n, /1 到 1/);
                return true;
            }
        );
    });

    it('uses deployed upstream profile limits when validating Agent partial image counts', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'matsca';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://img.matsca.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
            process.env.OPENAI_CHANNEL_1_MATSCA_APP_ID = 'configured';
            process.env.OPENAI_CHANNEL_1_MATSCA_APP_SECRET = 'configured';

            const imagesRequest = validateAgentGenerateRequest({
                prompt: 'draw through matsca images api',
                image_backend: 'images-api',
                partial_images: 4
            });
            assert.equal(imagesRequest.partial_images, 4);
            assert.throws(
                () =>
                    validateAgentGenerateRequest({
                        prompt: 'draw through matsca responses',
                        image_backend: 'responses-image-generation',
                        stream_mode: 'stream',
                        streaming_strategy: 'responses-sse',
                        partial_images: 4
                    }),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.equal(error.status, 422);
                    const details = JSON.parse(error.message) as { fields: Record<string, string> };
                    assert.match(details.fields.partial_images, /1 到 3/);
                    return true;
                }
            );
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('accepts ignored Responses partial image counts for explicit non-stream requests', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'responses-non-stream';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://responses.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'responses-non-stream';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'responses-non-stream-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { partial_images: { min: 0, max: 0 } }
            });

            const request = validateAgentGenerateRequest({
                prompt: 'draw through responses non-stream',
                image_backend: 'responses-image-generation',
                stream_mode: 'non_stream',
                streaming_strategy: 'off',
                partial_images: 0
            });

            assert.equal(request.partial_images, 0);
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('validates Responses partial image counts for automatic requests without a non-stream channel', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'responses-sse-only';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://responses.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'responses-sse';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'responses-sse-only-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { partial_images: { min: 0, max: 0 } }
            });

            assert.throws(
                () =>
                    validateAgentGenerateRequest({
                        prompt: 'draw through responses sse only',
                        image_backend: 'responses-image-generation',
                        stream_mode: 'auto',
                        streaming_strategy: 'auto',
                        partial_images: 0
                    }),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.equal(error.status, 422);
                    const details = JSON.parse(error.message) as { fields: Record<string, string> };
                    assert.match(details.fields.partial_images, /1 到 3/);
                    return true;
                }
            );
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('chooses an n-compatible SSE preview default for automatic mixed-channel requests', () => {
        const originalEnv = { ...process.env };
        try {
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
            process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://sse.example.com/v1';
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

            const request = validateAgentGenerateRequest({
                prompt: 'automatic mixed-channel preview default',
                n: 1,
                stream_mode: 'auto',
                streaming_strategy: 'auto'
            });

            assert.equal(request.partial_images, 3);
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('chooses an SSE preview default from the channel that accepts the requested background', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'openai-sse';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://openai.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'openai-key';
            process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-sse';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'openai-sse-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { partial_images: { min: 1, max: 1 } }
            });
            process.env.OPENAI_CHANNEL_2_ID = 'matsca-sse';
            process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://matsca.example.com/v1';
            process.env.OPENAI_CHANNEL_2_API_KEYS = 'matsca-key';
            process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
            process.env.OPENAI_CHANNEL_2_UPSTREAM_PROFILE = 'matsca';
            process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
                id: 'matsca-sse-provider',
                base_profile: 'matsca',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { partial_images: { min: 3, max: 3 } }
            });

            const request = validateAgentGenerateRequest({
                prompt: 'automatic background-aware preview default',
                n: 1,
                background: 'transparent',
                stream_mode: 'auto',
                streaming_strategy: 'auto'
            });

            assert.equal(request.partial_images, 3);
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('filters automatic preview candidates by the requested model allowlist', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'non-stream-other-model';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://non-stream.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'non-stream-key';
            process.env.OPENAI_CHANNEL_1_MODELS = 'gpt-image-2';
            process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'non-stream-other-model-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { partial_images: { min: 0, max: 0 } }
            });
            process.env.OPENAI_CHANNEL_2_ID = 'sse-requested-model';
            process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://sse.example.com/v1';
            process.env.OPENAI_CHANNEL_2_API_KEYS = 'sse-key';
            process.env.OPENAI_CHANNEL_2_MODELS = 'gpt-image-2-1k';
            process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
            process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
                id: 'sse-requested-model-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { partial_images: { min: 3, max: 3 } }
            });

            const request = validateAgentGenerateRequest({
                prompt: 'automatic model-aware preview default',
                model: 'gpt-image-2-1k',
                n: 1,
                stream_mode: 'auto',
                streaming_strategy: 'auto'
            });

            assert.equal(request.partial_images, 3);
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('chooses a healthy SSE preview default when the non-stream channel is cooling down', async () => {
        const originalEnv = { ...process.env };
        let resetServerChannelStateForTests: (() => void) | undefined;
        try {
            Object.assign(process.env, { NODE_ENV: 'test' });
            delete process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST;
            delete process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST;
            process.env.OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED = 'true';
            process.env.OPENAI_CHANNEL_FAILURE_COOLDOWN_MS = '60000';
            process.env.OPENAI_CHANNEL_1_ID = 'cooling-non-stream';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://non-stream.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'non-stream-key';
            process.env.OPENAI_CHANNEL_1_REQUEST_MODES = 'images-non-stream';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'cooling-non-stream-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } }
            });
            process.env.OPENAI_CHANNEL_2_ID = 'healthy-sse';
            process.env.OPENAI_CHANNEL_2_BASE_URL = 'https://sse.example.com/v1';
            process.env.OPENAI_CHANNEL_2_API_KEYS = 'sse-key';
            process.env.OPENAI_CHANNEL_2_REQUEST_MODES = 'images-sse';
            process.env.OPENAI_CHANNEL_2_PROVIDER_MANIFEST = JSON.stringify({
                id: 'healthy-sse-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { partial_images: { min: 3, max: 3 } }
            });

            const serverChannelRouter = await import('./server-channel-router');
            resetServerChannelStateForTests = serverChannelRouter.resetServerChannelStateForTests;
            const state = serverChannelRouter.getServerChannelState();
            const coolingCredential = state.config.credentials.find(
                (credential) => credential.channelId === 'cooling-non-stream'
            );
            assert.ok(coolingCredential);
            state.router?.reportFailure(coolingCredential, {
                scope: 'channel',
                requestMode: 'images-non-stream',
                reason: {
                    at: Date.now(),
                    scope: 'channel',
                    requestMode: 'images-non-stream',
                    status: 503
                }
            });

            const request = validateAgentGenerateRequest({
                prompt: 'automatic request with a cooling non-stream channel',
                n: 1,
                stream_mode: 'auto',
                streaming_strategy: 'auto'
            });

            assert.equal(request.partial_images, 3);
        } finally {
            resetServerChannelStateForTests?.();
            restoreEnv(originalEnv);
        }
    });

    it('rejects non-string Agent upstream strategy fields instead of defaulting them', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'bad upstream strategy fields',
                    image_backend: 123,
                    streaming_strategy: true
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.image_backend, /字符串/);
                assert.match(details.fields.streaming_strategy, /字符串/);
                return true;
            }
        );
    });

    it('returns field-level validation errors for agent-correctable inputs', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: '',
                    n: 99,
                    output_format: 'gif',
                    response_mode: 'url'
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.prompt, /必填/);
                assert.match(details.fields.n, /1 到 10/);
                assert.match(details.fields.output_format, /png/);
                assert.match(details.fields.response_mode, /path/);
                return true;
            }
        );
    });

    it('rejects incompatible Agent image backend and streaming strategy combinations', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'bad strategy',
                    image_backend: 'images-api',
                    streaming_strategy: 'responses-sse'
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.streaming_strategy, /Images API/);
                return true;
            }
        );
    });

    it('accepts Matsca-compatible gpt-image-2 fields before upstream execution', () => {
        const originalEnv = { ...process.env };
        try {
            delete process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST;
            process.env.OPENAI_CHANNEL_1_ID = 'matsca';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://img.matsca.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
            const request = validateAgentGenerateRequest({
                prompt: 'transparent object',
                model: 'gpt-image-2',
                size: '123x456',
                background: 'transparent',
                partial_images: 0
            });

            assert.equal(request.size, '123x456');
            assert.equal(request.background, 'transparent');
            assert.equal(request.partial_images, 0);
        } finally {
            restoreProcessEnv(originalEnv);
        }
    });

    it('applies the gpt-image-2 profile contract to the default 1K model alias', () => {
        const originalEnv = { ...process.env };
        try {
            delete process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST;
            process.env.OPENAI_CHANNEL_1_ID = 'matsca';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://img.matsca.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_UPSTREAM_PROFILE = 'matsca';
            const request = validateAgentGenerateRequest({
                prompt: 'transparent default alias',
                model: 'gpt-image-2-1k',
                size: '123x456',
                background: 'transparent',
                partial_images: 0
            });

            assert.equal(request.model, 'gpt-image-2-1k');
            assert.equal(request.size, '123x456');
            assert.equal(request.background, 'transparent');
        } finally {
            restoreProcessEnv(originalEnv);
        }
    });

    it('rejects OpenAI-compatible gpt-image-2 sizes that violate the active profile contract', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'invalid official size',
                    model: 'gpt-image-2',
                    size: '123x456'
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.size, /16/);
                return true;
            }
        );
    });

    it('accepts explicit force_request for locally unsupported gpt-image-2 sizes', () => {
        const request = validateAgentGenerateRequest({
            prompt: 'force a small upstream request',
            model: 'gpt-image-2',
            size: '512x512',
            force_request: true
        });

        assert.equal(request.size, '512x512');
        assert.equal(request.force_request, true);
    });

    it('rejects force_request sizes outside non gpt-image-2 model allowlists', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'force a legacy model size',
                    model: 'gpt-image-1',
                    size: '512x512',
                    force_request: true
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.size, /gpt-image-1.*1024x1024/);
                return true;
            }
        );
    });

    it('rejects malformed force_request sizes without returning the bad value', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'force a malformed upstream request',
                    model: 'gpt-image-2',
                    size: 'wide',
                    force_request: true
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.size, /WxH/);
                return true;
            }
        );
    });

    it('requires provider-defined custom models to use auto or positive WxH sizes', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'custom model size',
                    model: 'custom-image-model',
                    size: 'wide'
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.size, /auto 或 WxH/);
                return true;
            }
        );
        const request = validateAgentGenerateRequest({
            prompt: 'custom model size',
            model: 'custom-image-model',
            size: '2048x2048'
        });
        assert.equal(request.size, '2048x2048');
    });

    it('enforces the local resource budget for provider-defined sizes', () => {
        assert.throws(
            () =>
                validateAgentGenerateRequest({
                    prompt: 'oversized custom model request',
                    model: 'custom-image-model',
                    size: '100000x100000',
                    force_request: true
                }),
            (error) => {
                assert.ok(error instanceof RequestValidationError);
                assert.equal(error.status, 422);
                const details = JSON.parse(error.message) as { fields: Record<string, string> };
                assert.match(details.fields.size, /单边最大值/);
                return true;
            }
        );
    });

    it('rejects gpt-image-2 sizes that are not positive integer dimensions', () => {
        for (const { size, pattern } of [
            { size: '0x512', pattern: /正数/ },
            { size: 'abc', pattern: /WIDTH|WxH|auto/ }
        ]) {
            assert.throws(
                () =>
                    validateAgentGenerateRequest({
                        prompt: 'out of range image',
                        model: 'gpt-image-2',
                        size
                    }),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.equal(error.status, 422);
                    const details = JSON.parse(error.message) as { fields: Record<string, string> };
                    assert.match(details.fields.size, pattern);
                    return true;
                }
            );
        }
    });
});

describe('Agent numeric configuration', () => {
    it('uses defaults when optional numeric env values are absent', () => {
        assert.equal(readAgentRequestTtlSeconds({}), 86400);
        assert.equal(readAgentLeaseMs({}), 600000);
        assert.equal(readAgentRecoveryIntervalMs({}), 30000);
    });

    it('fails explicitly when numeric env values are invalid', () => {
        assert.throws(
            () => readAgentRequestTtlSeconds({ AGENT_REQUEST_TTL_SECONDS: 'abc' }),
            /AGENT_REQUEST_TTL_SECONDS/
        );
        assert.throws(() => readAgentLeaseMs({ AGENT_REQUEST_LEASE_MS: '0' }), /AGENT_REQUEST_LEASE_MS/);
        assert.throws(
            () => readAgentRecoveryIntervalMs({ AGENT_RECOVERY_INTERVAL_MS: '-1' }),
            /AGENT_RECOVERY_INTERVAL_MS/
        );
    });

    it('validates the public OpenAPI server URL', () => {
        assert.equal(readAgentPublicBaseUrl({}), '/');
        assert.equal(
            readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'https://images.example.test/' }),
            'https://images.example.test'
        );
        assert.equal(
            readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'http://localhost:4783' }),
            'http://localhost:4783'
        );
        assert.throws(() => readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'not a url' }), /AGENT_PUBLIC_BASE_URL/);
        assert.throws(
            () => readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'javascript:alert(1)' }),
            /AGENT_PUBLIC_BASE_URL/
        );
        assert.throws(
            () => readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'https://user:pass@images.example.test' }),
            /AGENT_PUBLIC_BASE_URL/
        );
        assert.throws(
            () => readAgentPublicBaseUrl({ AGENT_PUBLIC_BASE_URL: 'https://images.example.test?token=secret' }),
            /AGENT_PUBLIC_BASE_URL/
        );
    });
});

describe('buildAgentCapabilities', () => {
    it('exposes machine-readable defaults, limits, auth, and storage metadata', () => {
        const capabilities = buildAgentCapabilities({
            AGENT_STATE_BACKEND: 'postgres',
            AGENT_DATABASE_URL: 'postgres://example',
            AGENT_API_TOKEN: 'token',
            NEXT_PUBLIC_IMAGE_STORAGE_MODE: 'fs'
        });

        assert.equal(capabilities.defaults.state_backend, 'postgres');
        assert.equal(capabilities.defaults.model, 'gpt-image-2');
        assert.equal(capabilities.model_directory.default_model, 'gpt-image-2');
        assert.equal(capabilities.schema_version, AGENT_SCHEMA_VERSION);
        assert.deepEqual(capabilities.image_transport, {
            upstream_timeout_ms: 900_000,
            stream_data_interval_timeout_ms: 900_000,
            upstream_max_retries: 0,
            upstream_proxy: { configured: false },
            tun_mode: 'disabled'
        });
        assert.equal(capabilities.defaults.image_backend, 'images-api');
        assert.equal(capabilities.defaults.stream_mode, 'auto');
        assert.equal(capabilities.defaults.streaming_strategy, 'auto');
        assert.equal(capabilities.defaults.partial_images, 2);
        assert.equal(capabilities.upstream_profile.activeProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.serverProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.serverProfileMixed, false);
        assert.equal(capabilities.upstream_profile.requestProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.activeConstraints.id, 'openai-compatible');
        assert.deepEqual(capabilities.limits.partial_images, { min: 1, max: 3 });
        assert.deepEqual(capabilities.limits.partial_images_by_backend, {
            'images-api': { min: 1, max: 3 },
            'responses-image-generation': { min: 1, max: 3 }
        });
        assert.deepEqual(capabilities.limits.generate_images_by_backend, {
            'images-api': { min: 1, max: 10 },
            'responses-image-generation': { min: 1, max: 1 }
        });
        assert.deepEqual(capabilities.limits.edit_images_by_backend, {
            'images-api': { min: 1, max: 10 },
            'responses-image-generation': { min: 1, max: 1 }
        });
        assert.equal(capabilities.limits.max_images, 10);
        assert.deepEqual(capabilities.limits.generate_images, { min: 1, max: 10 });
        assert.deepEqual(capabilities.limits.edit_images, { min: 1, max: 10 });
        assert.equal(capabilities.limits.upload_images.max, 10);
        assert.equal(capabilities.limits.max_upload_mb, 25);
        assert.equal(capabilities.limits.upstream_profile, 'openai-compatible');
        assert.equal(capabilities.limits.upstream_profile_mixed, false);
        assert.equal(capabilities.auth.required, true);
        assert.deepEqual(capabilities.auth.schemes, ['bearer']);
        assert.equal(capabilities.storage.postgres_configured, true);
        assert.equal('sqlite_path' in capabilities.storage, false);
        assert.deepEqual(capabilities.page_request_diagnostics.endpoints, {
            single: AGENT_ENDPOINTS.page_request_diagnostics,
            batch: AGENT_ENDPOINTS.page_request_diagnostics_batch
        });
        assert.equal(capabilities.page_request_diagnostics.supported, true);
        assert.equal(capabilities.page_request_diagnostics.source, 'app_log');
        assert.equal(capabilities.page_request_diagnostics.retention.storage, 'bounded_local_jsonl');
        assert.equal(capabilities.page_request_diagnostics.retention.max_entries, 300);
        assert.equal(capabilities.page_request_diagnostics.retention.default_max_entries, 300);
        assert.equal(capabilities.page_request_diagnostics.retention.min_entries, 100);
        assert.equal(capabilities.page_request_diagnostics.retention.max_configured_entries, 5000);
        assert.equal(capabilities.page_request_diagnostics.retention.configured_by, 'APP_LOG_MAX_ENTRIES');
        assert.equal(capabilities.page_request_diagnostics.retention.persisted_across_process_restart, true);
        assert.equal(capabilities.page_request_diagnostics.retention.bounded, true);
        assert.equal(capabilities.page_request_diagnostics.retention.not_agent_state_backend, true);
        assert.deepEqual(capabilities.page_request_diagnostics.retention.loss_modes, [
            'entry_evicted_by_max_entries',
            'log_level_filter',
            'local_log_file_missing_or_cleared'
        ]);
        assert.equal(capabilities.page_request_diagnostics.no_match_hint, AGENT_PAGE_REQUEST_DIAGNOSTICS_NO_MATCH_HINT);
        assert.equal(capabilities.agent_request_diagnostics.supported, true);
        assert.equal(capabilities.agent_request_diagnostics.source, 'agent_state');
        assert.deepEqual(capabilities.agent_request_diagnostics.endpoints, {
            lookup: AGENT_ENDPOINTS.agent_request_diagnostics_lookup,
            single: AGENT_ENDPOINTS.agent_request_diagnostics
        });
        assert.deepEqual(capabilities.agent_request_diagnostics.lookup, {
            by_request_id: true,
            by_idempotency_key: true
        });
        assert.deepEqual(capabilities.agent_request_diagnostics.retention, {
            storage: 'agent_state',
            ttl_seconds: 86400,
            bounded: true,
            loss_modes: ['request_expired_by_ttl', 'artifact_deleted_or_purged', 'state_backend_reset']
        });
        assert.equal(capabilities.idempotency.header, 'Idempotency-Key');
        assert.ok(capabilities.supported.models.includes('gpt-image-2'));
        assert.equal(capabilities.model_limits['gpt-image-2'].max_edge, 3840);
        assert.equal(capabilities.model_limits['gpt-image-2'].edge_multiple, 16);
        assert.equal(capabilities.model_limits['gpt-image-2'].max_pixels, 8294400);
        assert.equal(capabilities.model_limits['gpt-image-2'].min_pixels, 655360);
        assert.equal(capabilities.model_limits['gpt-image-2'].max_aspect, 3);
        assert.equal(capabilities.model_limits['gpt-image-2'].size_policy, 'openai-compatible');
        assert.equal(capabilities.model_limits['gpt-image-2'].allow_transparent_background, false);
        assert.deepEqual(capabilities.model_limits.provider_defined, {
            max_edge: 8192,
            max_pixels: 67_108_864
        });
        assert.deepEqual(capabilities.force_request_controls, {
            field: 'force_request',
            cli_flag: '--force-request',
            default: false,
            effect: 'skip_local_upstream_profile_size_and_background_validation',
            still_enforced: [
                'authentication',
                'idempotency_key',
                'billable_confirmation',
                'api_base_url_safety',
                'channel_request_mode_whitelist',
                'image_count_limits',
                'partial_image_limits',
                'non_gpt_image2_size_allowlist',
                'positive_integer_size_syntax',
                'upload_file_size_and_type',
                'mask_integrity_checks'
            ],
            intended_for: [
                'upstream_compatibility_probe',
                'administrator_confirmed_provider_contract',
                'requests_where_real_upstream_should_decide'
            ]
        });
        assert.deepEqual(capabilities.model_limits['gpt-image-2'].large_image_risk.applies_to, [
            'max_edge>2048',
            'long_running_upstream'
        ]);
        assert.match(capabilities.model_limits['gpt-image-2'].large_image_risk.guidance, /大尺寸/);
        assert.equal(capabilities.agent_streaming.generate.supported, false);
        assert.equal(capabilities.agent_streaming.generate.mode, 'non_streaming_only');
        assert.equal(capabilities.agent_streaming.upstream_sse.supported, true);
        assert.equal(capabilities.agent_streaming.upstream_sse.mode, 'internal_upstream_sse');
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.request_fields, [
            'image_backend',
            'stream_mode',
            'streaming_strategy',
            'partial_images'
        ]);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.request_fields_by_mode, {
            generate: ['image_backend', 'stream_mode', 'streaming_strategy', 'partial_images'],
            edit: ['stream_mode', 'streaming_strategy', 'partial_images']
        });
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.image_backends, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.enabled_image_backends, ['images-api']);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.streaming_strategies, [
            'off',
            'auto',
            'openai-sse',
            'newapi-keepalive-sse',
            'responses-sse',
            'force-sse'
        ]);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.activation_strategies, [
            'auto',
            'openai-sse',
            'newapi-keepalive-sse',
            'responses-sse',
            'force-sse'
        ]);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.stream_modes, ['auto', 'stream', 'non_stream']);
        assert.equal(capabilities.agent_streaming.upstream_sse.final_response_contract, 'AgentImageResponse');
        assert.equal(capabilities.agent_streaming.page_sse.endpoint, '/api/images');
        assert.equal(capabilities.agent_streaming.page_sse.contract, 'page_ui_only');
        assert.equal(capabilities.agent_streaming.page_sse.transport_contract, 'page_form_data_sse');
        assert.deepEqual(capabilities.agent_streaming.page_sse.auth, {
            required: false,
            schemes: [],
            form_field: 'passwordHash'
        });
        assert.deepEqual(capabilities.agent_streaming.page_sse.client_request_id, {
            form_field: 'clientRequestId',
            source_header: 'Idempotency-Key',
            max_length: PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH
        });
        assert.equal(capabilities.agent_streaming.page_sse.agent_usage, AGENT_PAGE_SSE_AGENT_USAGE);
        assert.deepEqual(capabilities.upstream_request_headers.default, {
            user_agent_effective: 'visual-journal/2.3.0',
            has_extra_headers: false,
            allowed_header_names: ['user-agent', 'x-app-id', 'x-app-secret'],
            configured_header_names: []
        });
        assert.deepEqual(capabilities.upstream_request_headers.channels, []);
        assert.deepEqual(capabilities.routing_rules.high_resolution_edit.when, ['operation=edit', 'max_edge>2048']);
        assert.deepEqual(capabilities.routing_rules.high_resolution_edit.conditions, {
            operation: 'edit',
            max_edge: { operator: 'gt', value: 2048 }
        });
        assert.equal(capabilities.routing_rules.high_resolution_edit.endpoint, '/api/images');
        assert.equal(capabilities.routing_rules.high_resolution_edit.transport, 'page_sse');
        assert.equal(capabilities.routing_rules.high_resolution_edit.strength, 'default');
        assert.deepEqual(capabilities.routing_rules.high_resolution_edit.action, {
            endpoint: '/api/images',
            transport: 'page_sse',
            strength: 'default',
            fallback_endpoint: AGENT_ENDPOINTS.edit,
            fallback_mode: 'manual_after_diagnosis',
            requires_new_idempotency_key_on_retry: true,
            no_automatic_fallback: true
        });
        assert.equal(capabilities.routing_rules.complex_ui_batch.endpoint, '/api/images');
        assert.deepEqual(capabilities.routing_rules.complex_ui_batch.conditions, {
            operation: 'generate_or_edit',
            complex_ui: true,
            batch: true
        });
        assert.equal(capabilities.routing_rules.complex_ui_batch.strength, 'recommended');
        assert.equal(capabilities.routing_rules.long_image_recovery.endpoint, '/api/images');
        assert.equal(capabilities.routing_rules.long_image_recovery.transport, 'page_sse');
        assert.deepEqual(capabilities.routing_rules.long_image_recovery.conditions, {
            operation: 'generate_or_edit',
            long_image: true,
            resume_or_recover: true
        });
        assert.equal(capabilities.routing_rules.agent_generate_small_smoke.endpoint, AGENT_ENDPOINTS.generate);
        assert.equal(capabilities.routing_rules.agent_generate_small_smoke.strength, 'explicit');
        assert.deepEqual(capabilities.routing_rules.agent_generate_small_smoke.action, {
            endpoint: AGENT_ENDPOINTS.generate,
            transport: 'agent_json',
            strength: 'explicit',
            requires_new_idempotency_key_on_retry: true,
            no_automatic_fallback: true
        });
        assert.equal(capabilities.routing_rules.page_sse_generate_diagnostics.endpoint, '/api/images');
        assert.equal(capabilities.routing_rules.page_sse_generate_diagnostics.transport, 'page_sse');
        assert.equal(capabilities.routing_rules.page_sse_generate_diagnostics.strength, 'explicit');
        assert.equal(capabilities.routing_rules.page_sse_generate_diagnostics.action.strength, 'explicit');
        assert.equal(
            capabilities.routing_rules.page_sse_generate_diagnostics.action.fallback_endpoint,
            AGENT_ENDPOINTS.create_image_request
        );
        assert.deepEqual(capabilities.routing_rules.page_sse_generate_diagnostics.conditions, {
            operation: 'generate',
            explicit_page_sse: true,
            single_request: true
        });
        assert.equal(capabilities.routing_rules.retry_recovery.reuse_failed_idempotency_key, false);
        assert.match(capabilities.routing_rules.retry_recovery.new_attempt_guidance, /new Idempotency-Key/);
        assert.equal(capabilities.orchestration.supported, true);
        assert.equal(capabilities.orchestration.policy, 'server_orchestrated_generate_v1');
        assert.equal(capabilities.orchestration.endpoint, AGENT_ENDPOINTS.create_image_request);
        assert.equal(capabilities.orchestration.client_contract, 'intent_only');
        assert.equal(capabilities.orchestration.transport_selection, 'server_owned');
        assert.equal(capabilities.orchestration.result_mode, 'job_polling');
        assert.deepEqual(capabilities.orchestration.diagnostics, {
            job_result: AGENT_ENDPOINTS.job_result,
            request_lookup: AGENT_ENDPOINTS.agent_request_diagnostics_lookup
        });
        assert.match(capabilities.orchestration.current_guidance, /只提交生成意图/);
        assert.deepEqual(capabilities.supported.image_backends, ['images-api', 'responses-image-generation']);
        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api']);
        assert.deepEqual(capabilities.supported.image_backend_requirements['images-api'], {
            supported: true,
            enabled: true,
            required_env: [],
            missing_env: []
        });
        assert.deepEqual(capabilities.supported.image_backend_requirements['responses-image-generation'], {
            supported: true,
            enabled: false,
            required_env: ['ENABLE_RESPONSES_IMAGE_BACKEND', 'OPENAI_RESPONSES_API_MODEL'],
            missing_env: ['ENABLE_RESPONSES_IMAGE_BACKEND', 'OPENAI_RESPONSES_API_MODEL']
        });
        assert.deepEqual(capabilities.supported.request_modes, [
            'images-non-stream',
            'images-sse',
            'responses-non-stream',
            'responses-sse'
        ]);
        assert.deepEqual(capabilities.request_mode_controls, {
            source: 'admin_env_whitelist',
            global_env: 'OPENAI_UPSTREAM_REQUEST_MODES',
            channel_env_pattern: 'OPENAI_CHANNEL_N_REQUEST_MODES',
            global_priority_env: 'OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY',
            channel_priority_env_pattern: 'OPENAI_CHANNEL_N_REQUEST_MODE_PRIORITY',
            default_priority: ['images-non-stream', 'images-sse', 'responses-non-stream', 'responses-sse'],
            default_priority_policy: 'lowest_cost_first',
            mutable_at_runtime: false,
            agent_client_policy: 'diagnostics_only',
            final_gate_command:
                'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --require-independent-targets --allow-billable',
            smoke_gate_commands: {
                'images-non-stream': [
                    'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case original-images-json --allow-billable'
                ],
                'images-sse': [
                    'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case sub2api-images-sse --allow-billable'
                ],
                'responses-non-stream': [
                    'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case sub2api-responses-json --allow-billable'
                ],
                'responses-sse': [
                    'npm run smoke:image-upstream-real -- --env-file-if-exists .env.real-smoke.local --case gpt2image-responses-sse --allow-billable'
                ]
            }
        });
        assert.deepEqual(capabilities.supported.streaming_strategies, [
            'off',
            'auto',
            'openai-sse',
            'newapi-keepalive-sse',
            'responses-sse',
            'force-sse'
        ]);
        assert.deepEqual(capabilities.supported.stream_modes, ['auto', 'stream', 'non_stream']);
        assert.equal(capabilities.endpoints.create_generate_job, AGENT_ENDPOINTS.create_generate_job);
        assert.equal(capabilities.endpoints.create_image_request, AGENT_ENDPOINTS.create_image_request);
        assert.equal(capabilities.endpoints.page_request_feedback_batch, AGENT_ENDPOINTS.page_request_feedback_batch);
        assert.equal(capabilities.endpoints.page_request_feedback, AGENT_ENDPOINTS.page_request_feedback);
        assert.equal(
            capabilities.endpoints.page_request_diagnostics_batch,
            AGENT_ENDPOINTS.page_request_diagnostics_batch
        );
        assert.equal(capabilities.endpoints.page_request_diagnostics, AGENT_ENDPOINTS.page_request_diagnostics);
        assert.equal(
            capabilities.endpoints.agent_request_diagnostics_lookup,
            AGENT_ENDPOINTS.agent_request_diagnostics_lookup
        );
        assert.equal(capabilities.endpoints.agent_request_diagnostics, AGENT_ENDPOINTS.agent_request_diagnostics);
        assert.equal(capabilities.agent_jobs.supported, true);
        assert.equal(capabilities.agent_jobs.mode, 'job_polling');
        assert.deepEqual(capabilities.agent_jobs.intended_for, [
            'explicit_job_route',
            'manual_after_diagnosis',
            'long_running_upstream_when_page_sse_not_selected'
        ]);
        assert.equal(capabilities.agent_jobs.endpoints.create_generate_job, AGENT_JOB_ENDPOINTS.create_generate_job);
        assert.deepEqual(capabilities.agent_jobs.states, ['queued', 'running', 'succeeded', 'failed', 'expired']);
        assert.match(capabilities.agent_jobs.current_guidance, /orchestration\.endpoint/);
        assert.match(capabilities.agent_jobs.current_guidance, /job/);
    });

    it('uses the configured image model consistently in capabilities', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_IMAGE_MODEL: 'gpt-image-2-1k',
            OPENAI_CONFIGURED_MODELS: 'gpt-image-2-1k,custom-image-model'
        });

        assert.equal(capabilities.defaults.model, 'gpt-image-2-1k');
        assert.equal(capabilities.model_directory.default_model, 'gpt-image-2-1k');
        const originalModel = process.env.OPENAI_IMAGE_MODEL;
        process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2-1k';
        try {
            assert.equal(validateAgentGenerateRequest({ prompt: 'configured default' }).model, 'gpt-image-2-1k');
        } finally {
            if (originalModel === undefined) delete process.env.OPENAI_IMAGE_MODEL;
            else process.env.OPENAI_IMAGE_MODEL = originalModel;
        }
    });

    it('exposes the explicit TUN transport mode without exposing legacy flag values', () => {
        const capabilities = buildAgentCapabilities({ OPENAI_TUN_MODE: 'synthetic-dns' });
        assert.equal(capabilities.image_transport.tun_mode, 'synthetic-dns');
        assert.throws(() => buildAgentCapabilities({ OPENAI_TUN_MODE: 'invalid' }), /OPENAI_TUN_MODE/);
    });

    it('reports configured server-channel request modes in Agent capabilities', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'images',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'images-json,images-sse'
        });

        assert.deepEqual(capabilities.upstream_request_headers.channels, [
            {
                id: 'images',
                upstream_proxy: { configured: false },
                request_modes: ['images-non-stream', 'images-sse'],
                request_mode_priority: ['images-non-stream', 'images-sse'],
                request_headers: {
                    user_agent_effective: 'visual-journal/2.3.0',
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

    it('reports global and per-channel upstream proxy summaries without exposing endpoints', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_UPSTREAM_PROXY_URL: 'https://global-proxy.internal.example:9443',
            OPENAI_CHANNEL_1_ID: 'primary',
            OPENAI_CHANNEL_1_BASE_URL: 'https://primary.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_ID: 'backup',
            OPENAI_CHANNEL_2_BASE_URL: 'https://backup.example.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_PROXY_URL: 'http://channel-proxy.internal.example:8080'
        });

        assert.deepEqual(capabilities.image_transport.upstream_proxy, { configured: true, protocol: 'https' });
        assert.deepEqual(
            capabilities.upstream_request_headers.channels.map((channel) => ({
                id: channel.id,
                upstream_proxy: channel.upstream_proxy
            })),
            [
                { id: 'primary', upstream_proxy: { configured: true, protocol: 'https' } },
                { id: 'backup', upstream_proxy: { configured: true, protocol: 'http' } }
            ]
        );
        const serialized = JSON.stringify(capabilities);
        assert.equal(serialized.includes('global-proxy.internal.example'), false);
        assert.equal(serialized.includes('channel-proxy.internal.example'), false);
        assert.equal(serialized.includes('9443'), false);
        assert.equal(serialized.includes('8080'), false);
    });

    it('reports Matsca server-channel upload and image-count limits in Agent capabilities', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'matsca',
            OPENAI_CHANNEL_1_BASE_URL: 'https://img.matsca.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_UPSTREAM_PROFILE: 'matsca',
            OPENAI_CHANNEL_1_MATSCA_APP_ID: 'configured',
            OPENAI_CHANNEL_1_MATSCA_APP_SECRET: 'configured'
        });

        assert.equal(capabilities.upstream_profile.activeProfile, 'matsca');
        assert.equal(capabilities.upstream_profile.serverProfile, 'matsca');
        assert.equal(capabilities.upstream_profile.serverProfileMixed, false);
        assert.equal(capabilities.upstream_profile.requestProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.activeConstraints.id, 'matsca');
        assert.equal(capabilities.limits.max_images, 4);
        assert.deepEqual(capabilities.limits.generate_images, { min: 1, max: 4 });
        assert.deepEqual(capabilities.limits.edit_images, { min: 1, max: 4 });
        assert.equal(capabilities.limits.upload_images.max, 8);
        assert.equal(capabilities.limits.max_upload_mb, 10);
        assert.equal(capabilities.limits.max_total_upload_mb, 80);
        assert.deepEqual(capabilities.limits.partial_images, { min: 0, max: 4 });
        assert.deepEqual(capabilities.limits.partial_images_by_backend, {
            'images-api': { min: 0, max: 4 },
            'responses-image-generation': { min: 1, max: 3 }
        });
        assert.deepEqual(capabilities.limits.generate_images_by_backend, {
            'images-api': { min: 1, max: 4 },
            'responses-image-generation': { min: 1, max: 1 }
        });
        assert.deepEqual(capabilities.limits.edit_images_by_backend, {
            'images-api': { min: 1, max: 4 },
            'responses-image-generation': { min: 1, max: 1 }
        });
        assert.equal(capabilities.limits.upstream_profile, 'matsca');
        assert.equal(capabilities.limits.upstream_profile_mixed, false);
        assert.equal(capabilities.model_limits['gpt-image-2'].size_policy, 'positive-integer');
        assert.equal(capabilities.model_limits['gpt-image-2'].allow_transparent_background, true);
    });

    it('reports provider manifest constraints in Agent capabilities', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'custom',
            OPENAI_CHANNEL_1_BASE_URL: 'https://custom.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'custom_provider',
                base_profile: 'openai-compatible',
                base_url: 'https://provider.internal.example/v1',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: {
                    generate_count: { min: 1, max: 2 },
                    edit_count: { min: 1, max: 1 },
                    partial_images: { min: 1, max: 2 },
                    upload: { max_images: 3, max_single_bytes: 10485760 }
                }
            })
        });

        assert.equal(capabilities.upstream_profile.activeConstraints.providerManifest?.id, 'custom_provider');
        assert.equal(JSON.stringify(capabilities).includes('provider.internal.example'), false);
        assert.deepEqual(capabilities.limits.generate_images, { min: 1, max: 2 });
        assert.deepEqual(capabilities.limits.edit_images, { min: 1, max: 1 });
        assert.equal(capabilities.limits.max_images, 1);
        assert.equal(capabilities.limits.upload_images.max, 3);
        assert.equal(capabilities.limits.max_upload_mb, 10);
        assert.deepEqual(capabilities.limits.partial_images, { min: 1, max: 2 });
    });

    it('rejects Agent n=0 when a provider manifest tries to lower the count bound to zero', () => {
        const originalEnv = { ...process.env };
        try {
            process.env.OPENAI_CHANNEL_1_ID = 'zero-count';
            process.env.OPENAI_CHANNEL_1_BASE_URL = 'https://custom.example.com/v1';
            process.env.OPENAI_CHANNEL_1_API_KEYS = 'configured';
            process.env.OPENAI_CHANNEL_1_PROVIDER_MANIFEST = JSON.stringify({
                id: 'zero_count_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { generate_count: { min: 0, max: 2 } }
            });

            assert.throws(
                () => validateAgentGenerateRequest({ prompt: 'reject zero output count', n: 0 }),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.equal(error.status, 500);
                    assert.match(error.message, /constraints\.generate_count\.min 必须是正整数/);
                    return true;
                }
            );
        } finally {
            restoreEnv(originalEnv);
        }
    });

    it('disables Responses when its provider count range has no valid intersection', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-4.1',
            OPENAI_CHANNEL_1_ID: 'fixed-two',
            OPENAI_CHANNEL_1_BASE_URL: 'https://custom.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'fixed_two_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { generate_count: { min: 2, max: 2 } }
            })
        });

        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api']);
        assert.equal(capabilities.supported.image_backend_requirements['responses-image-generation'].enabled, false);
        assert.deepEqual(
            capabilities.supported.image_backend_requirements['responses-image-generation'].incompatible_constraints,
            ['request_modes']
        );
    });

    it('keeps Images-only capabilities valid when Responses is disabled', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'fixed-two',
            OPENAI_CHANNEL_1_BASE_URL: 'https://custom.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'fixed_two_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: {
                    generate_count: { min: 2, max: 2 },
                    partial_images: { min: 0, max: 0 }
                }
            })
        });

        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api']);
        assert.deepEqual(capabilities.limits.generate_images_by_backend, {
            'images-api': { min: 2, max: 2 },
            'responses-image-generation': { min: 1, max: 1 }
        });
        assert.deepEqual(capabilities.limits.partial_images_by_backend, {
            'images-api': { min: 0, max: 0 },
            'responses-image-generation': { min: 1, max: 3 }
        });
    });

    it('keeps Responses enabled for non-stream requests when only streaming partial images are incompatible', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-5.4',
            OPENAI_CHANNEL_1_ID: 'responses-non-stream',
            OPENAI_CHANNEL_1_BASE_URL: 'https://responses.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'responses-non-stream,responses-sse',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'responses-partial-zero-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { partial_images: { min: 0, max: 0 } }
            })
        });

        const requirement = capabilities.supported.image_backend_requirements['responses-image-generation'];
        assert.equal(requirement.enabled, true);
        assert.equal('incompatible_constraints' in requirement, false);
        assert.deepEqual(requirement.streaming_incompatible_constraints, ['partial_images']);
        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api', 'responses-image-generation']);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.enabled_image_backends, ['images-api']);
        assert.deepEqual(capabilities.limits.partial_images_by_backend['responses-image-generation'], {
            min: 1,
            max: 3
        });
    });

    it('does not advertise Responses streaming when no provider supports a preview count', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-5.4',
            OPENAI_CHANNEL_1_ID: 'no-previews',
            OPENAI_CHANNEL_1_BASE_URL: 'https://no-previews.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'responses-non-stream,responses-sse',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'no-previews-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { partial_images: { min: 0, max: 0 } }
            }),
            OPENAI_CHANNEL_2_ID: 'four-previews',
            OPENAI_CHANNEL_2_BASE_URL: 'https://four-previews.example.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_REQUEST_MODES: 'responses-non-stream,responses-sse',
            OPENAI_CHANNEL_2_PROVIDER_MANIFEST: JSON.stringify({
                id: 'four-previews-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { partial_images: { min: 4, max: 4 } }
            })
        });

        const requirement = capabilities.supported.image_backend_requirements['responses-image-generation'];
        assert.equal(requirement.enabled, true);
        assert.deepEqual(requirement.streaming_incompatible_constraints, ['partial_images']);
        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api', 'responses-image-generation']);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.enabled_image_backends, ['images-api']);
    });

    it('does not combine count and preview support from different Responses credentials', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-5.4',
            OPENAI_CHANNEL_1_ID: 'count-one-no-preview',
            OPENAI_CHANNEL_1_BASE_URL: 'https://count-one.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'responses-non-stream,responses-sse',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'count-one-no-preview-provider',
                base_profile: 'openai-compatible',
                modes: {
                    generate: { submit: { path: '/responses' } },
                    edit: { submit: { path: '/responses' } }
                },
                constraints: {
                    generate_count: { min: 1, max: 1 },
                    edit_count: { min: 1, max: 1 },
                    partial_images: { min: 0, max: 0 }
                }
            }),
            OPENAI_CHANNEL_2_ID: 'count-two-preview',
            OPENAI_CHANNEL_2_BASE_URL: 'https://count-two.example.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_REQUEST_MODES: 'responses-non-stream,responses-sse',
            OPENAI_CHANNEL_2_PROVIDER_MANIFEST: JSON.stringify({
                id: 'count-two-preview-provider',
                base_profile: 'openai-compatible',
                modes: {
                    generate: { submit: { path: '/responses' } },
                    edit: { submit: { path: '/responses' } }
                },
                constraints: {
                    generate_count: { min: 2, max: 2 },
                    edit_count: { min: 2, max: 2 },
                    partial_images: { min: 1, max: 1 }
                }
            })
        });

        const requirement = capabilities.supported.image_backend_requirements['responses-image-generation'];
        assert.equal(requirement.enabled, true);
        assert.deepEqual(requirement.streaming_incompatible_constraints, ['partial_images']);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.enabled_image_backends, ['images-api']);
    });

    it('reports mixed Agent limits when only one OpenAI-compatible channel has provider constraints', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'custom',
            OPENAI_CHANNEL_1_BASE_URL: 'https://custom.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'custom_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: {
                    generate_count: { min: 1, max: 2 },
                    upload: { max_images: 3, max_single_bytes: 10485760 }
                }
            }),
            OPENAI_CHANNEL_2_ID: 'official',
            OPENAI_CHANNEL_2_BASE_URL: 'https://api.openai.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_UPSTREAM_PROFILE: 'openai-compatible'
        });

        assert.equal(capabilities.upstream_profile.serverProfileMixed, true);
        assert.equal(capabilities.limits.upstream_profile_mixed, true);
        assert.deepEqual(capabilities.limits.generate_images, { min: 1, max: 2 });
        assert.equal(capabilities.limits.upload_images.max, 3);
        assert.equal(capabilities.limits.max_upload_mb, 10);
    });

    it('uses conservative Agent limits for mixed upstream profiles', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'matsca',
            OPENAI_CHANNEL_1_BASE_URL: 'https://img.matsca.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_UPSTREAM_PROFILE: 'matsca',
            OPENAI_CHANNEL_1_MATSCA_APP_ID: 'configured',
            OPENAI_CHANNEL_1_MATSCA_APP_SECRET: 'configured',
            OPENAI_CHANNEL_2_ID: 'official',
            OPENAI_CHANNEL_2_BASE_URL: 'https://api.openai.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_UPSTREAM_PROFILE: 'openai-compatible'
        });

        assert.equal(capabilities.upstream_profile.activeProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.serverProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.serverProfileMixed, true);
        assert.equal(capabilities.upstream_profile.requestProfile, 'openai-compatible');
        assert.equal(capabilities.upstream_profile.activeConstraints.generateCount.max, 4);
        assert.equal(capabilities.upstream_profile.activeConstraints.upload.maxImages, 8);
        assert.deepEqual(capabilities.limits.partial_images, { min: 1, max: 3 });
        assert.deepEqual(capabilities.limits.partial_images_by_backend, {
            'images-api': { min: 1, max: 3 },
            'responses-image-generation': { min: 1, max: 3 }
        });
        assert.equal(capabilities.limits.max_images, 4);
        assert.deepEqual(capabilities.limits.generate_images, { min: 1, max: 4 });
        assert.deepEqual(capabilities.limits.edit_images, { min: 1, max: 4 });
        assert.equal(capabilities.limits.upload_images.max, 8);
        assert.equal(capabilities.limits.max_upload_mb, 10);
        assert.equal(capabilities.limits.max_total_upload_mb, 80);
        assert.equal(capabilities.limits.upstream_profile_mixed, true);
        assert.equal(capabilities.model_limits['gpt-image-2'].allow_transparent_background, true);
        assert.equal(capabilities.model_limits['gpt-image-2'].size_policy, 'positive-integer');
        assert.deepEqual(capabilities.model_limits.provider_defined, {
            max_edge: 8192,
            max_pixels: 67_108_864
        });
    });

    it('keeps Agent capabilities valid when channel image count ranges do not intersect', () => {
        const capabilities = buildAgentCapabilities({
            OPENAI_CHANNEL_1_ID: 'fixed-one',
            OPENAI_CHANNEL_1_BASE_URL: 'https://one.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'fixed_one_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { generate_count: { min: 1, max: 1 } }
            }),
            OPENAI_CHANNEL_2_ID: 'fixed-two',
            OPENAI_CHANNEL_2_BASE_URL: 'https://two.example.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'configured',
            OPENAI_CHANNEL_2_PROVIDER_MANIFEST: JSON.stringify({
                id: 'fixed_two_provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/images/generations' } } },
                constraints: { generate_count: { min: 2, max: 2 } }
            })
        });

        assert.equal(capabilities.upstream_profile.serverConstraintsMixed, true);
        assert.deepEqual(
            capabilities.upstream_profile.serverConstraintsByProfile.map((profile) => profile.generateCount),
            [
                { min: 1, max: 1 },
                { min: 2, max: 2 }
            ]
        );
        assert.ok(
            capabilities.upstream_profile.activeConstraints.generateCount.min <=
                capabilities.upstream_profile.activeConstraints.generateCount.max
        );
    });

    it('derives Responses image counts from a compatible channel profile', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-5.4',
            OPENAI_CHANNEL_1_ID: 'fixed-two',
            OPENAI_CHANNEL_1_BASE_URL: 'https://two.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'two-key',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'responses-non-stream',
            OPENAI_CHANNEL_1_PROVIDER_MANIFEST: JSON.stringify({
                id: 'fixed-two-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { generate_count: { min: 2, max: 2 } }
            }),
            OPENAI_CHANNEL_2_ID: 'one-to-ten',
            OPENAI_CHANNEL_2_BASE_URL: 'https://one-to-ten.example.com/v1',
            OPENAI_CHANNEL_2_API_KEYS: 'one-to-ten-key',
            OPENAI_CHANNEL_2_REQUEST_MODES: 'responses-non-stream',
            OPENAI_CHANNEL_2_PROVIDER_MANIFEST: JSON.stringify({
                id: 'one-to-ten-provider',
                base_profile: 'openai-compatible',
                modes: { generate: { submit: { path: '/responses' } } },
                constraints: { generate_count: { min: 1, max: 10 } }
            })
        });

        assert.deepEqual(capabilities.limits.generate_images_by_backend['responses-image-generation'], {
            min: 1,
            max: 1
        });
    });

    it('exposes only the runtime-accepted bearer auth scheme when Agent token is configured', () => {
        assert.deepEqual(
            buildAgentAuthCapabilities({
                AGENT_API_TOKEN: 'token',
                APP_PASSWORD: 'page-access-code'
            }),
            { required: true, schemes: ['bearer'] }
        );
    });

    it('marks Responses image backend runtime-enabled only when its feature flag and model are configured', () => {
        const missingModel = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true'
        });
        assert.deepEqual(missingModel.supported.enabled_image_backends, ['images-api']);
        assert.deepEqual(missingModel.supported.image_backend_requirements['responses-image-generation'].missing_env, [
            'OPENAI_RESPONSES_API_MODEL'
        ]);

        const enabled = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-4.1'
        });
        assert.deepEqual(enabled.agent_streaming.upstream_sse.enabled_image_backends, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.deepEqual(enabled.supported.enabled_image_backends, ['images-api', 'responses-image-generation']);
        assert.deepEqual(enabled.supported.image_backend_requirements['responses-image-generation'], {
            supported: true,
            enabled: true,
            required_env: ['ENABLE_RESPONSES_IMAGE_BACKEND', 'OPENAI_RESPONSES_API_MODEL'],
            missing_env: []
        });
    });

    it('does not enable Responses when configured channels expose only Images request modes', () => {
        const capabilities = buildAgentCapabilities({
            ENABLE_RESPONSES_IMAGE_BACKEND: 'true',
            OPENAI_RESPONSES_API_MODEL: 'gpt-5.4',
            OPENAI_CHANNEL_1_ID: 'images-only',
            OPENAI_CHANNEL_1_BASE_URL: 'https://images.example.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_REQUEST_MODES: 'images-non-stream'
        });

        const requirement = capabilities.supported.image_backend_requirements['responses-image-generation'];
        assert.equal(requirement.enabled, false);
        assert.deepEqual(requirement.incompatible_constraints, ['request_modes']);
        assert.deepEqual(requirement.streaming_incompatible_constraints, ['streaming_request_modes']);
        assert.deepEqual(capabilities.supported.enabled_image_backends, ['images-api']);
        assert.deepEqual(capabilities.agent_streaming.upstream_sse.enabled_image_backends, ['images-api']);
    });

    it('exposes page SSE form password auth separately from Agent bearer auth', () => {
        const capabilities = buildAgentCapabilities({
            AGENT_API_TOKEN: 'token',
            APP_PASSWORD: 'page-access-code'
        });

        assert.deepEqual(capabilities.auth, { required: true, schemes: ['bearer'] });
        assert.deepEqual(capabilities.agent_streaming.page_sse.auth, {
            required: true,
            schemes: ['form-password-hash'],
            form_field: 'passwordHash'
        });
    });

    it('propagates the configured app log retention window into Agent diagnostics capabilities', () => {
        assert.deepEqual(buildPageRequestDiagnosticsCapabilities({ APP_LOG_MAX_ENTRIES: '450' }).retention, {
            storage: 'bounded_local_jsonl',
            max_entries: 450,
            default_max_entries: 300,
            min_entries: 100,
            max_configured_entries: 5000,
            configured_by: 'APP_LOG_MAX_ENTRIES',
            persisted_across_process_restart: true,
            loss_modes: ['entry_evicted_by_max_entries', 'log_level_filter', 'local_log_file_missing_or_cleared'],
            bounded: true,
            not_agent_state_backend: true
        });
    });

    it('exposes access-code hash auth only when no Agent token is configured', () => {
        assert.deepEqual(buildAgentAuthCapabilities({ APP_PASSWORD: 'page-access-code' }), {
            required: true,
            schemes: ['x-app-password-hash']
        });
    });

    it('marks Agent auth as optional when no auth env is configured', () => {
        assert.deepEqual(
            buildAgentAuthCapabilities({
                AGENT_API_TOKEN: '   ',
                APP_PASSWORD: '   '
            }),
            { required: false, schemes: [] }
        );
    });

    it('exposes memory state backend for ephemeral deployments', () => {
        const capabilities = buildAgentCapabilities({
            AGENT_STATE_BACKEND: 'memory',
            NEXT_PUBLIC_IMAGE_STORAGE_MODE: 'fs'
        });

        assert.equal(capabilities.defaults.state_backend, 'memory');
        assert.equal(capabilities.storage.postgres_configured, false);
    });

    it('generates an OpenAPI document with the Agent generate endpoint', () => {
        const document = buildAgentOpenApiDocument({ AGENT_PUBLIC_BASE_URL: 'https://images.example.test' });
        assert.equal(document.openapi, '3.1.0');
        assert.equal(document.info.title, 'Visual Journal Image Agent API');
        assert.deepEqual(document.servers, [{ url: 'https://images.example.test' }]);
        assert.ok(AGENT_ENDPOINTS.openapi in document.paths);
        assert.ok(AGENT_ENDPOINTS.create_image_request in document.paths);
        assert.ok(AGENT_ENDPOINTS.generate in document.paths);
        assert.ok(AGENT_ENDPOINTS.create_generate_job in document.paths);
        assert.ok(AGENT_ENDPOINTS.job in document.paths);
        assert.ok(AGENT_ENDPOINTS.job_result in document.paths);
        assert.ok(AGENT_ENDPOINTS.artifact_share in document.paths);
        assert.ok(AGENT_ENDPOINTS.page_request_feedback_batch in document.paths);
        assert.ok(AGENT_ENDPOINTS.page_request_feedback in document.paths);
        assert.ok(AGENT_ENDPOINTS.page_request_diagnostics_batch in document.paths);
        assert.ok(AGENT_ENDPOINTS.page_request_diagnostics in document.paths);
        assert.ok(AGENT_ENDPOINTS.agent_request_diagnostics_lookup in document.paths);
        assert.ok(AGENT_ENDPOINTS.agent_request_diagnostics in document.paths);
        assert.ok('AgentCapabilities' in document.components.schemas);
        assert.ok('AgentImageResponse' in document.components.schemas);
        assert.ok('AgentJobStatusResponse' in document.components.schemas);
        assert.ok('AgentArtifact' in document.components.schemas);
        assert.ok('CreateArtifactShareRequest' in document.components.schemas);
        assert.ok('ArtifactShareResponse' in document.components.schemas);
        assert.ok('ResultFeedback' in document.components.schemas);
        assert.ok('FeedbackTarget' in document.components.schemas);
        assert.ok('PageRequestFeedbackBatchRequest' in document.components.schemas);
        assert.ok('PageRequestFeedbackBatchResponse' in document.components.schemas);
        assert.ok('PageRequestFeedbackResponse' in document.components.schemas);
        assert.ok('PageRequestDiagnosticsBatchRequest' in document.components.schemas);
        assert.ok('PageRequestDiagnosticsBatchItem' in document.components.schemas);
        assert.ok('PageRequestDiagnosticsBatchResponse' in document.components.schemas);
        assert.ok('PageRequestDiagnosticsResponse' in document.components.schemas);
        assert.ok('PageRequestDiagnosticsNote' in document.components.schemas);
        assert.ok('PageRequestDiagnosticContext' in document.components.schemas);
        assert.ok('EditRequest' in document.components.schemas);
        assert.ok('AgentError' in document.components.schemas);
        assert.ok('AgentModelLimits' in document.components.schemas);
        assert.ok('ImageUpstreamProfile' in document.components.schemas);
        assert.ok('AgentStreamingCapabilities' in document.components.schemas);
        assert.ok('AgentPageRequestDiagnosticsCapabilities' in document.components.schemas);
        assert.ok('AppLogRetentionMetadata' in document.components.schemas);
        assert.ok('AgentJobCapabilities' in document.components.schemas);
        assert.ok('AgentOrchestrationCapabilities' in document.components.schemas);
        assert.ok('AgentRoutingRules' in document.components.schemas);
        assert.ok('AgentRoutingRule' in document.components.schemas);
        assert.ok('AgentErrorDiagnostics' in document.components.schemas);
        assert.ok('AgentImageResponseTiming' in document.components.schemas);
        assert.ok('AgentImageResponseExecution' in document.components.schemas);
        assert.ok('ChannelRequestModeDecision' in document.components.schemas);
        assert.ok('UpstreamProxySummary' in document.components.schemas);
        assert.deepEqual(document.components.schemas.AgentImageResponseExecution.properties.channel_request_mode.enum, [
            'images-non-stream',
            'images-sse',
            'responses-non-stream',
            'responses-sse'
        ]);
        assert.equal(
            document.components.schemas.AgentImageResponseExecution.properties.channel_request_mode_fallback_applied
                .type,
            'boolean'
        );
        assert.equal(
            document.components.schemas.AgentImageResponseExecution.properties.route_decision.$ref,
            '#/components/schemas/ChannelRequestModeDecision'
        );
        assert.equal(
            document.components.schemas.ChannelRequestModeDecision.properties.requested_backend.enum.includes(
                'images-api'
            ),
            true
        );
        assert.ok('UpstreamRequestHeaderSummary' in document.components.schemas);
        assert.ok('AgentRequestDiagnosticsCapabilities' in document.components.schemas);
        assert.ok('AgentRequestDiagnosticsRetention' in document.components.schemas);
        assert.ok('AgentRequestDiagnosticsLookupResponse' in document.components.schemas);
        assert.ok('AgentRequestDiagnostics' in document.components.schemas);
        const modelDirectorySchema = document.components.schemas.AgentCapabilities.properties.model_directory;
        assert.deepEqual(modelDirectorySchema.required, ['endpoint', 'probe_query', 'default_model', 'semantics']);
        assert.equal(modelDirectorySchema.properties.endpoint.const, '/api/agent/models');
        assert.equal(modelDirectorySchema.properties.probe_query.const, '?probe=true');
        assert.equal(modelDirectorySchema.properties.semantics.const, 'declared_models_only_until_explicit_probe');
        assert.equal(modelDirectorySchema.additionalProperties, false);
        assert.equal('model_directory' in document.components.schemas.ImageUpstreamProfile.properties, false);
        assert.deepEqual(document.components.schemas.CreateArtifactShareRequest.properties.access_code.anyOf, [
            { type: 'string', pattern: '^\\s*$' },
            { type: 'string', minLength: 8, maxLength: 128 }
        ]);
        assert.ok(document.paths[AGENT_ENDPOINTS.generate].post.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.generate].post.responses['403']);
        assert.ok(document.paths[AGENT_ENDPOINTS.generate].post.responses['429']);
        assert.ok(document.paths[AGENT_ENDPOINTS.generate].post.responses['422']);
        assert.ok(document.paths[AGENT_ENDPOINTS.create_image_request].post.responses['202']);
        assert.ok(document.paths[AGENT_ENDPOINTS.create_image_request].post.responses['409']);
        assert.ok(document.paths[AGENT_ENDPOINTS.create_generate_job].post.responses['202']);
        assert.ok(document.paths[AGENT_ENDPOINTS.job_result].get.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.job_result].get.responses['409']);
        assert.ok(document.paths[AGENT_ENDPOINTS.job_result].get.responses['422']);
        assert.ok(document.paths[AGENT_ENDPOINTS.job_result].get.responses['429']);
        assert.ok(document.paths[AGENT_ENDPOINTS.job_result].get.responses['502']);
        assert.ok(document.paths[AGENT_ENDPOINTS.artifact_share].post.responses['201']);
        assert.ok(document.paths[AGENT_ENDPOINTS.artifact_share].post.responses['400']);
        assert.ok(document.paths[AGENT_ENDPOINTS.page_request_feedback_batch].post.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.page_request_feedback].get.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.page_request_diagnostics_batch].post.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.page_request_diagnostics].get.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.agent_request_diagnostics_lookup].get.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.agent_request_diagnostics_lookup].get.responses['404']);
        assert.ok(document.paths[AGENT_ENDPOINTS.agent_request_diagnostics].get.responses['200']);
        assert.ok(document.paths[AGENT_ENDPOINTS.agent_request_diagnostics].get.responses['404']);
        const generateProperties = document.components.schemas.GenerateRequest.properties;
        assert.deepEqual(generateProperties.image_backend.enum, ['images-api', 'responses-image-generation']);
        assert.deepEqual(generateProperties.streaming_strategy.enum, [
            'off',
            'auto',
            'openai-sse',
            'newapi-keepalive-sse',
            'responses-sse',
            'force-sse'
        ]);
        assert.deepEqual(generateProperties.stream_mode.enum, ['auto', 'stream', 'non_stream']);
        assert.deepEqual(generateProperties.thinking.enum, ['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);
        assert.equal(generateProperties.responsesModel.maxLength, 200);
        assert.equal(generateProperties.promptOptimization.type, 'boolean');
        assert.equal(generateProperties.force_web.type, 'boolean');
        assert.equal(generateProperties.force_request.type, 'boolean');
        assert.deepEqual(generateProperties.n, { type: 'integer', minimum: 1, maximum: 10 });
        assert.deepEqual(generateProperties.partial_images, { type: 'integer', minimum: 0, maximum: 4, default: 2 });
        const responsesCondition = document.components.schemas.GenerateRequest.allOf[0];
        assert.ok(responsesCondition?.then && 'allOf' in responsesCondition.then);
        const responsesAllOf = responsesCondition.then.allOf;
        assert.ok(Array.isArray(responsesAllOf) && responsesAllOf[1]?.then);
        assert.deepEqual(responsesAllOf[0]?.then?.properties.partial_images, {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            default: 2
        });
        assert.deepEqual(responsesAllOf[1].then.properties.partial_images, {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            default: 2
        });
        assert.ok(responsesCondition.then && 'properties' in responsesCondition.then);
        assert.deepEqual(responsesCondition.then.properties.n, {
            type: 'integer',
            minimum: 1,
            maximum: 1,
            default: 1
        });
        assert.deepEqual(generateProperties.background.enum, ['transparent', 'opaque', 'auto']);
        assert.deepEqual(document.components.schemas.GenerateRequest.allOf[1], {
            if: {
                not: {
                    properties: {
                        force_request: { const: true }
                    },
                    required: ['force_request']
                }
            },
            then: {
                properties: {
                    background: { type: 'string', enum: ['opaque', 'auto'] }
                }
            }
        });
        const editProperties: Record<string, unknown> = document.components.schemas.EditRequest.properties;
        assert.equal('image_backend' in editProperties, false);
        assert.equal('output_format' in editProperties, false);
        assert.equal('output_compression' in editProperties, false);
        assert.equal('background' in editProperties, false);
        assert.equal('moderation' in editProperties, false);
        const forceRequestProperty = editProperties.force_request;
        assert.ok(forceRequestProperty && typeof forceRequestProperty === 'object' && 'type' in forceRequestProperty);
        assert.equal(forceRequestProperty.type, 'boolean');
        assert.deepEqual(editProperties.n, { type: 'integer', minimum: 1, maximum: 10 });
        assert.deepEqual(editProperties.partial_images, { type: 'integer', minimum: 0, maximum: 4, default: 2 });
        assert.deepEqual(document.components.schemas.EditRequest.required, ['prompt']);
        assert.match(document.components.schemas.EditRequest.description, /至少提供一个 image_0\.\.image_9/);
        assert.deepEqual(
            document.components.schemas.EditRequest.anyOf,
            Array.from({ length: 10 }, (_, index) => ({ required: [`image_${index}`] }))
        );
        for (let index = 0; index < 10; index += 1) {
            assert.deepEqual(editProperties[`image_${index}`], { type: 'string', format: 'binary' });
        }
        assert.deepEqual(document.components.schemas.AgentModelLimits.required, [
            'gpt-image-2',
            'gpt-image-2-1k',
            'provider_defined'
        ]);
        assert.deepEqual(document.components.schemas.AgentModelLimits.properties.provider_defined.required, [
            'max_edge',
            'max_pixels'
        ]);
        const capabilityProperties = document.components.schemas.AgentCapabilities.properties;
        assert.equal(capabilityProperties.routing_rules.$ref, '#/components/schemas/AgentRoutingRules');
        assert.equal(capabilityProperties.image_transport.$ref, '#/components/schemas/ImageTransportCapabilities');
        assert.equal(
            document.components.schemas.ImageTransportCapabilities.properties.upstream_timeout_ms.const,
            900000
        );
        assert.equal(
            document.components.schemas.ImageTransportCapabilities.properties.upstream_proxy.$ref,
            '#/components/schemas/UpstreamProxySummary'
        );
        assert.deepEqual(document.components.schemas.ImageTransportCapabilities.properties.tun_mode, {
            type: 'string',
            enum: ['disabled', 'synthetic-dns'],
            const: 'disabled'
        });
        assert.deepEqual(document.components.schemas.UpstreamProxySummary.required, ['configured']);
        assert.equal(
            capabilityProperties.upstream_request_headers.properties.default.$ref,
            '#/components/schemas/UpstreamRequestHeaderSummary'
        );
        assert.equal(capabilityProperties.upstream_profile.properties.serverProfile.const, 'openai-compatible');
        assert.equal(
            capabilityProperties.upstream_profile.properties.activeConstraints.$ref,
            '#/components/schemas/ImageUpstreamProfile'
        );
        assert.equal(capabilityProperties.limits.properties.partial_images.properties.min.const, 1);
        assert.equal(capabilityProperties.limits.properties.partial_images.properties.max.const, 3);
        assert.equal(
            capabilityProperties.limits.properties.partial_images_by_backend.properties['responses-image-generation']
                .properties.max.const,
            3
        );
        assert.equal(
            capabilityProperties.limits.properties.generate_images_by_backend.properties['responses-image-generation']
                .properties.max.const,
            1
        );
        assert.equal(
            capabilityProperties.limits.properties.edit_images_by_backend.properties['responses-image-generation']
                .properties.max.const,
            1
        );
        assert.equal(
            capabilityProperties.page_request_diagnostics.$ref,
            '#/components/schemas/AgentPageRequestDiagnosticsCapabilities'
        );
        assert.equal(
            document.components.schemas.AgentPageRequestDiagnosticsCapabilities.properties.retention.$ref,
            '#/components/schemas/AppLogRetentionMetadata'
        );
        assert.equal(
            document.components.schemas.AgentPageRequestDiagnosticsCapabilities.properties.endpoints.properties.single
                .const,
            AGENT_ENDPOINTS.page_request_diagnostics
        );
        assert.equal(
            document.components.schemas.AgentPageRequestDiagnosticsCapabilities.properties.endpoints.properties.batch
                .const,
            AGENT_ENDPOINTS.page_request_diagnostics_batch
        );
        assert.equal(document.components.schemas.AppLogRetentionMetadata.properties.max_entries.const, 300);
        assert.equal(
            document.components.schemas.AppLogRetentionMetadata.properties.configured_by.const,
            'APP_LOG_MAX_ENTRIES'
        );
        assert.deepEqual(document.components.schemas.AppLogRetentionMetadata.properties.loss_modes.const, [
            'entry_evicted_by_max_entries',
            'log_level_filter',
            'local_log_file_missing_or_cleared'
        ]);
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsResponse.required.includes('diagnostics_retention'),
            true
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsResponse.properties.diagnostics_retention.$ref,
            '#/components/schemas/AppLogRetentionMetadata'
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsResponse.properties.diagnostics_note.$ref,
            '#/components/schemas/PageRequestDiagnosticsNote'
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsBatchResponse.required.includes('diagnostics_retention'),
            true
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsBatchResponse.properties.diagnostics_retention.$ref,
            '#/components/schemas/AppLogRetentionMetadata'
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticsNote.properties.retention.$ref,
            '#/components/schemas/AppLogRetentionMetadata'
        );
        assert.equal(
            document.components.schemas.PageRequestDiagnosticEvent.properties.diagnostics.$ref,
            '#/components/schemas/PageRequestDiagnosticContext'
        );
        assert.equal(document.components.schemas.PageRequestDiagnosticContext.additionalProperties, false);
        assert.deepEqual(document.components.schemas.PageRequestDiagnosticContext.properties.transport_error, {
            type: 'boolean'
        });
        assert.deepEqual(document.components.schemas.PageRequestDiagnosticContext.properties.partial_images, {
            type: 'number'
        });
        const routingRuleProperties = document.components.schemas.AgentRoutingRule.properties;
        assert.equal(routingRuleProperties.conditions.$ref, '#/components/schemas/AgentRoutingCondition');
        assert.equal(routingRuleProperties.action.$ref, '#/components/schemas/AgentRoutingAction');
        assert.deepEqual(document.components.schemas.AgentRoutingCondition.properties.operation.enum, [
            'generate',
            'edit',
            'generate_or_edit'
        ]);
        assert.deepEqual(
            document.components.schemas.AgentRoutingCondition.properties.max_edge.properties.operator.enum,
            ['gt', 'lte']
        );
        assert.equal(document.components.schemas.AgentRoutingCondition.properties.explicit_page_sse.type, 'boolean');
        assert.equal(
            document.components.schemas.AgentRoutingAction.properties.requires_new_idempotency_key_on_retry.type,
            'boolean'
        );
        assert.equal(document.components.schemas.AgentRoutingAction.properties.no_automatic_fallback.type, 'boolean');
        assert.deepEqual(capabilityProperties.defaults.properties.image_backend.enum, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.deepEqual(capabilityProperties.supported.properties.image_backends.items.enum, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.deepEqual(capabilityProperties.supported.properties.enabled_image_backends.items.enum, [
            'images-api',
            'responses-image-generation'
        ]);
        assert.ok(capabilityProperties.supported.properties.image_backend_requirements);
        assert.deepEqual(capabilityProperties.supported.properties.request_modes.items.enum, [
            'images-non-stream',
            'images-sse',
            'responses-non-stream',
            'responses-sse'
        ]);
        assert.equal(
            document.components.schemas.AgentRequestModeControls.properties.agent_client_policy.const,
            'diagnostics_only'
        );
        assert.equal(
            document.components.schemas.AgentRequestModeControls.properties.channel_env_pattern.type,
            'string'
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties.request_fields
                .const,
            ['image_backend', 'stream_mode', 'streaming_strategy', 'partial_images']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties
                .request_fields_by_mode.properties.generate.const,
            ['image_backend', 'stream_mode', 'streaming_strategy', 'partial_images']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties
                .request_fields_by_mode.properties.edit.const,
            ['stream_mode', 'streaming_strategy', 'partial_images']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties
                .enabled_image_backends.items.enum,
            ['images-api', 'responses-image-generation']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties
                .streaming_strategies.items.enum,
            ['off', 'auto', 'openai-sse', 'newapi-keepalive-sse', 'responses-sse', 'force-sse']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties
                .activation_strategies.items.enum,
            ['auto', 'openai-sse', 'newapi-keepalive-sse', 'responses-sse', 'force-sse']
        );
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.upstream_sse.properties.stream_modes.items
                .enum,
            ['auto', 'stream', 'non_stream']
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.contract.enum[0],
            'page_ui_only'
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.transport_contract
                .enum[0],
            'page_form_data_sse'
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.auth.properties
                .form_field.const,
            'passwordHash'
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.client_request_id
                .properties.max_length.const,
            PAGE_SSE_CLIENT_REQUEST_ID_MAX_LENGTH
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.client_request_id
                .properties.source_header.const,
            'Idempotency-Key'
        );
        assert.equal(document.components.schemas.AgentRoutingRules.required.includes('high_resolution_edit'), true);
        assert.equal(document.components.schemas.AgentRoutingRules.required.includes('long_image_recovery'), true);
        assert.match(document.components.schemas.EditRequest.description, /\/api\/images/);
        assert.ok('upstream_event_type' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.deepEqual(document.components.schemas.AgentErrorDiagnostics.properties.channel_request_mode.enum, [
            'images-non-stream',
            'images-sse',
            'responses-non-stream',
            'responses-sse'
        ]);
        assert.equal(
            document.components.schemas.AgentErrorDiagnostics.properties.channel_request_mode_fallback_applied.type,
            'boolean'
        );
        assert.equal(
            document.components.schemas.AgentErrorDiagnostics.properties.route_decision.$ref,
            '#/components/schemas/ChannelRequestModeDecision'
        );
        assert.ok('partial_image_count' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.ok('transport_error_kind' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.ok('retry_after_ms' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.ok('cooldown_until' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.ok('cooldown_target' in document.components.schemas.AgentErrorDiagnostics.properties);
        assert.deepEqual(
            document.components.schemas.AgentErrorDiagnostics.properties.cooldown_target.properties.request_mode.enum,
            ['images-non-stream', 'images-sse', 'responses-non-stream', 'responses-sse']
        );
        assert.equal(document.components.schemas.ResultFeedback.properties.note.maxLength, 500);
    });

    it('describes Matsca server-channel limits in OpenAPI request schemas', () => {
        const document = buildAgentOpenApiDocument({
            OPENAI_CHANNEL_1_ID: 'matsca',
            OPENAI_CHANNEL_1_BASE_URL: 'https://img.matsca.com/v1',
            OPENAI_CHANNEL_1_API_KEYS: 'configured',
            OPENAI_CHANNEL_1_UPSTREAM_PROFILE: 'matsca',
            OPENAI_CHANNEL_1_MATSCA_APP_ID: 'configured',
            OPENAI_CHANNEL_1_MATSCA_APP_SECRET: 'configured'
        });

        assert.equal(document.components.schemas.GenerateRequest.properties.n.maximum, 4);
        assert.equal(document.components.schemas.EditRequest.properties.n.maximum, 4);
        assert.equal(document.components.schemas.GenerateRequest.properties.partial_images.minimum, 0);
        assert.equal(document.components.schemas.GenerateRequest.properties.partial_images.maximum, 4);
        const matscaResponsesCondition = document.components.schemas.GenerateRequest.allOf[0];
        assert.ok(matscaResponsesCondition?.then && 'allOf' in matscaResponsesCondition.then);
        const matscaResponsesAllOf = matscaResponsesCondition.then.allOf;
        assert.ok(
            Array.isArray(matscaResponsesAllOf) && matscaResponsesAllOf[0]?.then && matscaResponsesAllOf[1]?.then
        );
        assert.deepEqual(matscaResponsesAllOf[0].then.properties.partial_images, {
            type: 'integer',
            minimum: 0,
            maximum: 4,
            default: 2
        });
        assert.deepEqual(matscaResponsesAllOf[1].then.properties.partial_images, {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            default: 2
        });
        assert.ok(matscaResponsesCondition.then && 'properties' in matscaResponsesCondition.then);
        assert.deepEqual(matscaResponsesCondition.then.properties.n, {
            type: 'integer',
            minimum: 1,
            maximum: 1,
            default: 1
        });
        assert.equal(document.components.schemas.EditRequest.properties.partial_images.minimum, 0);
        assert.equal(document.components.schemas.EditRequest.properties.partial_images.maximum, 4);
        assert.match(document.components.schemas.EditRequest.description, /image_0\.\.image_7/);
        assert.deepEqual(
            document.components.schemas.EditRequest.anyOf,
            Array.from({ length: 8 }, (_, index) => ({ required: [`image_${index}`] }))
        );
        assert.equal('image_8' in document.components.schemas.EditRequest.properties, false);
    });

    it('describes public capabilities without server-local SQLite paths', () => {
        const document = buildAgentOpenApiDocument({});
        const storageSchema = document.components.schemas.AgentCapabilities.properties.storage;

        assert.ok(storageSchema.properties.image_storage_mode);
        assert.ok(storageSchema.properties.postgres_configured);
        assert.equal('sqlite_path' in storageSchema.properties, false);
    });

    it('describes bearer authentication and common runtime failures in OpenAPI', () => {
        const document = buildAgentOpenApiDocument({
            AGENT_API_TOKEN: 'token',
            APP_PASSWORD: 'page-access-code'
        });

        assert.ok(document.components.securitySchemes.BearerAuth);
        assert.equal('AppPasswordHash' in document.components.securitySchemes, false);
        assert.deepEqual(document.components.schemas.AgentCapabilities.properties.auth.properties.schemes.const, [
            'bearer'
        ]);
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.auth.properties
                .schemes.const,
            ['form-password-hash']
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.auth.properties
                .required.const,
            true
        );
        assert.deepEqual(document.paths['/api/agent/models'].get.security, [{ BearerAuth: [] }, {}]);
        assert.ok(document.paths['/api/agent/models'].get.responses['401']);
        assert.deepEqual(document.paths['/api/agent/images/generate'].post.security, [{ BearerAuth: [] }]);
        assert.ok(document.paths['/api/agent/images/generate'].post.responses['401']);
        assert.ok(document.paths['/api/agent/images/generate'].post.responses['415']);
        assert.ok(document.paths['/api/agent/images/generate'].post.responses['502']);
        assert.ok(document.paths['/api/agent/images/edit'].post.responses['401']);
        assert.ok(document.paths['/api/agent/images/edit'].post.responses['409'].headers['Retry-After']);
        assert.ok(document.paths['/api/agent/images/edit'].post.responses['415']);
        assert.ok(document.paths['/api/agent/images/edit'].post.responses['502']);
    });

    it('describes access-code hash authentication in OpenAPI when no Agent token is configured', () => {
        const document = buildAgentOpenApiDocument({ APP_PASSWORD: 'page-access-code' });

        assert.equal('BearerAuth' in document.components.securitySchemes, false);
        assert.ok(document.components.securitySchemes.AppPasswordHash);
        assert.deepEqual(document.components.schemas.AgentCapabilities.properties.auth.properties.schemes.const, [
            'x-app-password-hash'
        ]);
        assert.deepEqual(document.paths['/api/agent/models'].get.security, [{ AppPasswordHash: [] }, {}]);
        assert.deepEqual(document.paths['/api/agent/images/generate'].post.security, [{ AppPasswordHash: [] }]);
    });

    it('does not require Agent authentication in OpenAPI when no auth env is configured', () => {
        const document = buildAgentOpenApiDocument({});

        assert.deepEqual(document.components.securitySchemes, {});
        assert.deepEqual(document.components.schemas.AgentCapabilities.properties.auth.properties.schemes.const, []);
        assert.deepEqual(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.auth.properties
                .schemes.const,
            []
        );
        assert.equal(
            document.components.schemas.AgentStreamingCapabilities.properties.page_sse.properties.auth.properties
                .required.const,
            false
        );
        assert.deepEqual(document.paths['/api/agent/models'].get.security, []);
        assert.deepEqual(document.paths['/api/agent/images/generate'].post.security, []);
    });

    it('marks artifact routes as authenticated in OpenAPI', () => {
        const document = buildAgentOpenApiDocument({ AGENT_API_TOKEN: 'token' });
        const expectedSecurity = [{ BearerAuth: [] }];

        assert.deepEqual(document.paths['/api/agent/artifacts/{id}'].get.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/artifacts/{id}'].delete.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/artifacts/{id}/content'].get.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/artifacts/{id}/share'].post.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/page-requests/{id}/feedback'].get.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/diagnostics/requests'].get.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/diagnostics/requests/{id}'].get.security, expectedSecurity);
        assert.deepEqual(document.paths['/api/agent/diagnostics/page-requests/{id}'].get.security, expectedSecurity);
    });

    it('describes artifact metadata responses without server file paths', () => {
        const document = buildAgentOpenApiDocument({});
        const responseSchema = document.components.schemas.ArtifactMetadataResponse;
        const schema = document.components.schemas.AgentArtifact;

        assert.equal(responseSchema.properties.artifact.$ref, '#/components/schemas/AgentArtifact');
        assert.equal('AgentArtifactRecord' in document.components.schemas, false);
        assert.equal('filepath' in schema.properties, false);
        assert.ok('content_url' in schema.properties);
        assert.ok('metadata_url' in schema.properties);
        assert.ok('output_format' in schema.properties);
        assert.ok('mime_type' in schema.properties);
        assert.ok('size_bytes' in schema.properties);
    });
});

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(snapshot)) {
        process.env[key] = value;
    }
}
