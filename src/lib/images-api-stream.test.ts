import { createImagesApiGenerateStream } from './images-api-stream';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});
describe('createImagesApiGenerateStream', () => {
    it('keeps fixed protocol and authorization headers ahead of upstream extras', async () => {
        let observedAuthorization: string | null = null;
        let observedAccept: string | null = null;
        let observedContentType: string | null = null;
        let observedUserAgent: string | null = null;
        let observedAppId: string | null = null;
        let observedIdempotencyKey: string | null = null;
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            observedAuthorization = headers.get('authorization');
            observedAccept = headers.get('accept');
            observedContentType = headers.get('content-type');
            observedUserAgent = headers.get('user-agent');
            observedAppId = headers.get('x-app-id');
            observedIdempotencyKey = headers.get('idempotency-key');
            return new Response(JSON.stringify({ data: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };

        await createImagesApiGenerateStream({
            apiBaseUrl: 'https://api.example.test/v1',
            apiKey: 'test-key',
            params: {
                model: 'gpt-image-1',
                prompt: 'prompt',
                stream: true,
                partial_images: 2
            },
            idempotencyKey: 'stream-idempotency-key',
            upstreamHeaders: {
                Authorization: 'Bearer wrong-key',
                Accept: 'application/json',
                'Content-Type': 'text/plain',
                'Idempotency-Key': 'wrong-key',
                'X-App-ID': 'app-id'
            }
        });

        assert.equal(observedAuthorization, 'Bearer test-key');
        assert.equal(observedAccept, 'text/event-stream, application/json');
        assert.equal(observedContentType, 'application/json');
        assert.equal(observedUserAgent, 'visual-journal/2.4.0');
        assert.equal(observedAppId, 'app-id');
        assert.equal(observedIdempotencyKey, 'stream-idempotency-key');
    });

    it('aborts hanging stream setup using the configured upstream timeout', async () => {
        globalThis.fetch = async (_url, init) => {
            await new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                    once: true
                });
            });
            throw new Error('unreachable');
        };

        await assert.rejects(
            () =>
                createImagesApiGenerateStream({
                    apiBaseUrl: 'https://api.example.test/v1',
                    apiKey: 'test-key',
                    timeoutMs: 1,
                    params: {
                        model: 'gpt-image-1',
                        prompt: 'prompt',
                        stream: true,
                        partial_images: 2
                    }
                }),
            /aborted|AbortError/
        );
    });

    it('keeps timeout active while consuming the stream body', async () => {
        globalThis.fetch = async (_url, init) => {
            const stream = new ReadableStream({
                start(controller) {
                    init?.signal?.addEventListener(
                        'abort',
                        () => controller.error(new DOMException('aborted', 'AbortError')),
                        { once: true }
                    );
                }
            });
            return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            });
        };

        const stream = await createImagesApiGenerateStream({
            apiBaseUrl: 'https://api.example.test/v1',
            apiKey: 'test-key',
            timeoutMs: 1,
            params: {
                model: 'gpt-image-1',
                prompt: 'prompt',
                stream: true,
                partial_images: 2
            }
        });

        await assert.rejects(async () => {
            for await (const event of stream) {
                assert.fail(`unexpected stream event: ${JSON.stringify(event)}`);
            }
        }, /aborted|AbortError/);
    });
});
