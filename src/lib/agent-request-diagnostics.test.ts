import { buildAgentRequestDiagnostics, buildPageRequestDiagnostics } from './agent-request-diagnostics';
import type { AppLogEntry } from './app-logger';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('buildPageRequestDiagnostics', () => {
    it('exposes only typed diagnostic context fields', () => {
        const logs: AppLogEntry[] = [
            {
                id: 1,
                at: '2026-06-11T00:00:00.000Z',
                level: 'info',
                message: 'stream diagnostics',
                clientRequestId: 'request-a',
                filenames: ['image-a.png'],
                context: JSON.stringify({
                    providerDialect: 'sdk_parsed_fallback',
                    normalizedEventCount: 1,
                    reason: 123,
                    image_backend: 'images-api',
                    partialImages: '2',
                    partial_images: 2,
                    upstream_status: 200,
                    transport_error: true,
                    apiKey: 'sk-secret'
                })
            }
        ];

        const diagnostics = buildPageRequestDiagnostics({
            logs,
            clientRequestId: 'request-a'
        });

        assert.deepEqual(diagnostics.events[0]?.diagnostics, {
            providerDialect: 'sdk_parsed_fallback',
            normalizedEventCount: 1,
            image_backend: 'images-api',
            partial_images: 2,
            upstream_status: 200,
            transport_error: true
        });
    });
});

describe('buildAgentRequestDiagnostics', () => {
    it('summarizes Agent state without exposing raw request JSON or image payloads', () => {
        const diagnostics = buildAgentRequestDiagnostics({
            env: {
                AGENT_STATE_BACKEND: 'memory',
                AGENT_REQUEST_TTL_SECONDS: '120'
            },
            record: {
                requestId: 'request-1',
                idempotencyKey: 'idem-1',
                requestHash: 'hash-1',
                mode: 'generate',
                status: 'succeeded',
                requestJson: {
                    prompt: 'secret prompt text',
                    api_key: 'sk-secret'
                },
                responseJson: {
                    request_id: 'request-1',
                    idempotency_key: 'idem-1',
                    cached: false,
                    images: [
                        {
                            id: 'artifact-1',
                            filename: 'image.png',
                            content_url: '/api/agent/artifacts/artifact-1/content',
                            metadata_url: '/api/agent/artifacts/artifact-1',
                            output_format: 'png',
                            mime_type: 'image/png',
                            size_bytes: 67,
                            width: 1,
                            height: 1,
                            b64_json: 'raw-image-base64'
                        }
                    ],
                    created_at: '2026-06-11T00:00:05.000Z',
                    timing: {
                        started_at: '2026-06-11T00:00:00.000Z',
                        completed_at: '2026-06-11T00:00:05.000Z',
                        elapsed_ms: 5000,
                        server_elapsed_ms: 5000
                    },
                    execution: {
                        transport: 'agent_json',
                        endpoint: '/api/agent/images/generate',
                        route_mode: 'agent',
                        operation: 'generate',
                        image_backend: 'images-api',
                        stream_mode: 'non_stream',
                        streaming_strategy: 'auto',
                        selected_channel_id: 'default',
                        upstream_host: 'example.test',
                        request_headers: {
                            user_agent_effective: 'visual-journal/2.4.0',
                            has_extra_headers: false,
                            allowed_header_names: ['user-agent'],
                            configured_header_names: []
                        }
                    }
                },
                createdAt: '2026-06-11T00:00:00.000Z',
                updatedAt: '2026-06-11T00:00:05.000Z',
                expiresAt: '2026-06-11T00:02:00.000Z'
            },
            artifacts: [
                {
                    id: 'artifact-1',
                    requestId: 'request-1',
                    filename: 'image.png',
                    filepath: '/private/generated-images/image.png',
                    contentUrl: '/api/agent/artifacts/artifact-1/content',
                    metadataUrl: '/api/agent/artifacts/artifact-1',
                    outputFormat: 'png',
                    mimeType: 'image/png',
                    sizeBytes: 67,
                    width: 1,
                    height: 1,
                    model: 'gpt-image-2',
                    promptHash: 'prompt-hash',
                    createdAt: '2026-06-11T00:00:05.000Z'
                }
            ]
        });

        assert.equal(diagnostics.request.request_id, 'request-1');
        assert.equal(diagnostics.request.status, 'succeeded');
        assert.equal(diagnostics.response?.image_count, 1);
        assert.deepEqual(diagnostics.response?.artifact_ids, ['artifact-1']);
        assert.equal(diagnostics.state_backend, 'memory');
        assert.equal(diagnostics.diagnostics_retention.ttl_seconds, 120);
        assert.equal(diagnostics.diagnostics_boundary.raw_request_json_redacted, true);
        const serialized = JSON.stringify(diagnostics);
        assert.equal(serialized.includes('secret prompt text'), false);
        assert.equal(serialized.includes('sk-secret'), false);
        assert.equal(serialized.includes('raw-image-base64'), false);
        assert.equal(serialized.includes('/private/generated-images/image.png'), false);
    });
});
