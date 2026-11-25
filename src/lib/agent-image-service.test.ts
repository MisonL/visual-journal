import {
    buildEditRequestHash,
    completeAgentExecutionState,
    hydrateAgentReplayResponse,
    prepareAgentEdit,
    parseAgentGenerateRequest,
    readIdempotencyKey
} from './agent-image-service';
import type { AgentArtifactRecord, AgentStateStore } from './agent-state-store';
import { RequestValidationError } from './image-request-utils';
import { resetServerChannelStateForTests } from './server-channel-router';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

describe('buildEditRequestHash', () => {
    it('includes uploaded file bytes so same metadata with different content conflicts', async () => {
        const first = await buildEditRequestHash(makeEditForm([1, 2, 3, 4]));
        const second = await buildEditRequestHash(makeEditForm([9, 8, 7, 6]));

        assert.notEqual(first, second);
    });

    it('keeps the hash stable for identical edit form content', async () => {
        const first = await buildEditRequestHash(makeEditForm([1, 2, 3, 4]));
        const second = await buildEditRequestHash(makeEditForm([1, 2, 3, 4]));

        assert.equal(first, second);
    });
});

describe('readIdempotencyKey', () => {
    it('rejects control characters before forwarding the value upstream', () => {
        const headers = new Headers({ 'Idempotency-Key': `agent${String.fromCharCode(31)}key` });

        assert.throws(
            () => readIdempotencyKey(headers),
            (error) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /控制字符/);
                return true;
            }
        );
    });
});

describe('prepareAgentEdit model routing validation', () => {
    it('does not validate edit input against a credential that excludes the requested model', async () => {
        const originalEnv = { ...process.env };
        try {
            Object.assign(process.env, {
                NODE_ENV: 'test',
                OPENAI_CHANNEL_1_ID: 'ineligible-matsca',
                OPENAI_CHANNEL_1_BASE_URL: 'https://matsca.example.com/v1',
                OPENAI_CHANNEL_1_API_KEYS: 'matsca-key',
                OPENAI_CHANNEL_1_MODELS: 'gpt-image-2-1k',
                OPENAI_CHANNEL_1_UPSTREAM_PROFILE: 'matsca',
                OPENAI_CHANNEL_2_ID: 'eligible-openai',
                OPENAI_CHANNEL_2_BASE_URL: 'https://openai.example.com/v1',
                OPENAI_CHANNEL_2_API_KEYS: 'openai-key',
                OPENAI_CHANNEL_2_MODELS: 'gpt-image-2',
                OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED: 'false'
            });
            for (const key of Object.keys(process.env)) {
                if (
                    key.startsWith('OPENAI_CHANNEL_') &&
                    !key.startsWith('OPENAI_CHANNEL_1_') &&
                    !key.startsWith('OPENAI_CHANNEL_2_') &&
                    key !== 'OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED'
                ) {
                    delete process.env[key];
                }
            }
            resetServerChannelStateForTests();

            const formData = new FormData();
            formData.set('prompt', 'validate the model-compatible profile');
            formData.set('model', 'gpt-image-2');
            formData.set('size', '3840x3840');
            formData.set('image_0', new File([Buffer.from(PNG_BASE64, 'base64')], 'input.png', { type: 'image/png' }));

            await assert.rejects(
                () => prepareAgentEdit(formData, new Headers()),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.equal(error.status, 400);
                    assert.match(error.message, /size/);
                    return true;
                }
            );
        } finally {
            resetServerChannelStateForTests();
            restoreProcessEnv(originalEnv);
        }
    });
});

describe('prepareAgentGenerate upstream model family constraints', () => {
    const baseEnv = {
        NODE_ENV: 'test',
        OPENAI_CHANNEL_1_ID: 'family-channel',
        OPENAI_CHANNEL_1_BASE_URL: 'https://family.example.com/v1',
        OPENAI_CHANNEL_1_API_KEYS: 'family-key',
        OPENAI_CHANNEL_1_MODELS: 'gpt-image-2.5-flare,gpt-image-2.5-sunburst,gemini-3.1-flash-image,dall-e-3',
        OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED: 'false'
    };

    async function prepareGenerate(body: Record<string, unknown>) {
        const request = new Request('http://localhost/api/agent/image-requests', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `family-${Math.random().toString(36).slice(2)}`
            },
            body: JSON.stringify(body)
        });
        return parseAgentGenerateRequest(request);
    }

    function withEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
        const originalEnv = { ...process.env };
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('OPENAI_CHANNEL_')) delete process.env[key];
        }
        Object.assign(process.env, baseEnv, overrides);
        resetServerChannelStateForTests();
        return run().finally(() => {
            resetServerChannelStateForTests();
            restoreProcessEnv(originalEnv);
        });
    }

    it('keeps the extended 2.5 quality tiers for the gpt-image-2.5 family', async () => {
        await withEnv({}, async () => {
            const request = await prepareGenerate({
                model: 'gpt-image-2.5-flare',
                prompt: 'a wide landscape',
                quality: 'xhigh',
                size: '1536x1024'
            });
            assert.equal(request.model, 'gpt-image-2.5-flare');
            assert.equal(request.quality, 'xhigh');
            assert.equal(request.size, '1536x1024');
        });
    });

    it('rejects the extended quality tiers for models outside the 2.5 family', async () => {
        await withEnv({}, async () => {
            await assert.rejects(
                () => prepareGenerate({ model: 'gemini-3.1-flash-image', prompt: 'x', quality: 'max' }),
                (error) => {
                    assert.ok(error instanceof RequestValidationError);
                    assert.match(error.message, /quality/);
                    return true;
                }
            );
        });
    });
});
describe('hydrateAgentReplayResponse', () => {
    it('rejects base64 replay when stored artifact filepath escapes the image directory', async () => {
        const store = createReplayStore([
            {
                id: 'artifact-escape',
                requestId: 'request-escape',
                filename: 'escape.png',
                filepath: '/etc/passwd',
                contentUrl: '/api/agent/artifacts/artifact-escape/content',
                metadataUrl: '/api/agent/artifacts/artifact-escape',
                outputFormat: 'png',
                mimeType: 'image/png',
                sizeBytes: 1,
                width: 1,
                height: 1,
                model: 'gpt-image-2',
                promptHash: 'hash',
                createdAt: '2026-05-12T00:00:00.000Z'
            }
        ]);

        await assert.rejects(
            () =>
                hydrateAgentReplayResponse(
                    store,
                    { requestId: 'request-escape', requestJson: { response_mode: 'base64' } },
                    {
                        request_id: 'request-escape',
                        idempotency_key: 'idem-escape',
                        cached: false,
                        images: [
                            {
                                id: 'artifact-escape',
                                filename: 'escape.png',
                                content_url: '/api/agent/artifacts/artifact-escape/content',
                                metadata_url: '/api/agent/artifacts/artifact-escape',
                                output_format: 'png',
                                mime_type: 'image/png',
                                size_bytes: 1,
                                width: 1,
                                height: 1
                            }
                        ],
                        created_at: '2026-05-12T00:00:00.000Z'
                    }
                ),
            /目录之外/
        );
    });
});

describe('completeAgentExecutionState', () => {
    it('does not ask the state store to upsert artifacts a second time', async () => {
        let completedArtifacts: AgentArtifactRecord[] | undefined;
        const artifact: AgentArtifactRecord = {
            id: 'artifact-complete-no-upsert',
            requestId: 'request-complete-no-upsert',
            filename: 'artifact-complete-no-upsert.png',
            filepath: '/tmp/artifact-complete-no-upsert.png',
            contentUrl: '/api/agent/artifacts/artifact-complete-no-upsert/content',
            metadataUrl: '/api/agent/artifacts/artifact-complete-no-upsert',
            outputFormat: 'png',
            mimeType: 'image/png',
            sizeBytes: 1,
            width: 1,
            height: 1,
            model: 'gpt-image-2',
            promptHash: 'hash',
            createdAt: '2026-05-12T00:00:00.000Z'
        };
        const store: AgentStateStore = {
            ...createReplayStore([]),
            async completeRequest(input) {
                completedArtifacts = input.artifacts;
            }
        };

        await completeAgentExecutionState(store, {
            response: {
                request_id: 'request-complete-no-upsert',
                idempotency_key: 'idem-complete-no-upsert',
                cached: false,
                images: [],
                created_at: '2026-05-12T00:00:00.000Z'
            },
            stateResponse: {
                request_id: 'request-complete-no-upsert',
                idempotency_key: 'idem-complete-no-upsert',
                cached: false,
                images: [],
                created_at: '2026-05-12T00:00:00.000Z'
            },
            artifacts: [artifact]
        });

        assert.deepEqual(completedArtifacts, []);
    });
});

function makeEditForm(bytes: number[]): FormData {
    const formData = new FormData();
    formData.append('prompt', 'same prompt');
    formData.append('model', 'gpt-image-2');
    formData.append('response_mode', 'path');
    formData.append('image_0', new File([Buffer.from(bytes)], 'input.png', { type: 'image/png' }));
    return formData;
}

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
        process.env[key] = value;
    }
}

function createReplayStore(artifacts: AgentArtifactRecord[]): AgentStateStore {
    return {
        async init() {},
        async recoverExpiredRequests() {
            return 0;
        },
        async purgeExpiredRequests() {
            return 0;
        },
        async beginRequest() {
            throw new Error('not implemented');
        },
        async refreshRequestLease() {
            return false;
        },
        async saveArtifacts() {},
        async completeRequest() {},
        async failRequest() {},
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
            return artifacts;
        },
        async listArtifactFilepaths() {
            return artifacts.map((artifact) => artifact.filepath);
        },
        async deleteArtifact() {
            return false;
        }
    };
}
