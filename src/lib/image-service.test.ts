import { readImageDimensions } from './agent-file-utils';
import {
    AcceptedImageTaskResponseError,
    assertOpenAiImagesResponse,
    MissingOpenAiImageDataError,
    persistOpenAiImages,
    ImageDimensionMismatchError,
    normalizeImageBuffer,
    readRequestedImageDimensions,
    readAcceptedImageTaskDetails,
    readRetryAfterSecondsHeader,
    resolveAcceptedImageTaskResponse
} from './image-service';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';

const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('readAcceptedImageTaskDetails', () => {
    it('extracts task metadata from async upstream image payloads', () => {
        assert.deepEqual(
            readAcceptedImageTaskDetails({
                object: 'image.task',
                status: 'pending',
                task_id: '  sync-gen-task  ',
                poll_url: '  /api/image-tasks?ids=sync-gen-task  '
            }),
            {
                taskId: 'sync-gen-task',
                pollUrl: '/api/image-tasks?ids=sync-gen-task'
            }
        );
    });

    it('ignores regular image responses', () => {
        assert.equal(readAcceptedImageTaskDetails({ data: [{ b64_json: 'abc' }] }), undefined);
    });

    it('requires accepted task object and pending status', () => {
        assert.equal(readAcceptedImageTaskDetails(null), undefined);
        assert.equal(readAcceptedImageTaskDetails([]), undefined);
        assert.equal(readAcceptedImageTaskDetails({ object: 'image.task', status: 'completed' }), undefined);
        assert.equal(readAcceptedImageTaskDetails({ object: 'image.job', status: 'pending' }), undefined);
        assert.deepEqual(readAcceptedImageTaskDetails({ object: 'image.task', status: 'pending' }), {});
        assert.deepEqual(readAcceptedImageTaskDetails({ object: ' image.task ', status: ' pending ' }), {});
    });
});

describe('assertOpenAiImagesResponse', () => {
    it('rejects async task payloads that are not final OpenAI Images results', () => {
        assert.throws(() =>
            assertOpenAiImagesResponse({
                object: 'image.task',
                status: 'pending',
                task_id: 'sync-gen-task'
            })
        );
    });
});

describe('persistOpenAiImages', () => {
    it('normalizes upstream image bytes to the requested output format before returning base64', async () => {
        const [image] = await persistOpenAiImages({
            result: { data: [{ b64_json: PNG_BASE64 }] } as OpenAI.Images.ImagesResponse,
            outputFormat: 'webp',
            storageMode: 'indexeddb',
            includeBase64: true,
            normalizeOutputFormat: true
        });

        assert.equal(image.outputFormat, 'webp');
        assert.equal(image.mimeType, 'image/webp');
        assert.equal(image.filename.endsWith('.webp'), true);
        assert.equal(image.width, 1);
        assert.equal(image.height, 1);
        assert.equal(Buffer.from(image.b64Json, 'base64').toString('ascii', 8, 12), 'WEBP');
        assert.equal(Buffer.from(image.responseJson ?? '', 'base64').toString('ascii', 8, 12), 'WEBP');
    });

    it('preserves the upstream response on missing image data errors', async () => {
        const result = {
            data: [{ status: 'done' }]
        } as unknown as OpenAI.Images.ImagesResponse;

        await assert.rejects(
            () =>
                persistOpenAiImages({
                    result,
                    outputFormat: 'webp',
                    storageMode: 'indexeddb',
                    includeBase64: true
                }),
            (error) => {
                assert.ok(error instanceof MissingOpenAiImageDataError);
                assert.equal(error.index, 0);
                assert.equal(error.result, result);
                return true;
            }
        );
    });
});

describe('fixed image dimensions', () => {
    it('parses fixed WxH sizes and ignores auto or invalid values', () => {
        assert.deepEqual(readRequestedImageDimensions('1024x1536'), { width: 1024, height: 1536 });
        assert.equal(readRequestedImageDimensions('auto'), undefined);
        assert.equal(readRequestedImageDimensions('1024'), undefined);
        assert.equal(readRequestedImageDimensions(null), undefined);
        assert.throws(() => readRequestedImageDimensions('100000x100000'), /请求尺寸无效.*单边最大值/);
    });

    it('resizes a same-aspect image to the requested dimensions without changing its aspect ratio', async () => {
        const normalized = await normalizeImageBuffer(Buffer.from(PNG_BASE64, 'base64'), 'webp', {
            width: 2,
            height: 2
        });

        assert.deepEqual(readImageDimensions(normalized), { width: 2, height: 2 });
    });

    it('accepts small upstream rounding drift and pads without stretching', async () => {
        const { default: sharp } = await import('sharp');
        const source = await sharp({
            create: {
                width: 1027,
                height: 1531,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        })
            .png()
            .toBuffer();

        const normalized = await normalizeImageBuffer(source, 'webp', {
            width: 1536,
            height: 2288
        });

        assert.deepEqual(readImageDimensions(normalized), { width: 1536, height: 2288 });
    });

    it('accepts a provider portrait preset rounded to 1024x1536 for the 1536x2288 contract', async () => {
        const { default: sharp } = await import('sharp');
        const source = await sharp({
            create: {
                width: 1024,
                height: 1536,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        })
            .png()
            .toBuffer();

        const normalized = await normalizeImageBuffer(source, 'webp', {
            width: 1536,
            height: 2288
        });

        assert.deepEqual(readImageDimensions(normalized), { width: 1536, height: 2288 });
    });

    it('rejects a large portrait ratio drift beyond the one-percent guardrail', async () => {
        const { default: sharp } = await import('sharp');
        const source = await sharp({
            create: {
                width: 1024,
                height: 1500,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        })
            .png()
            .toBuffer();

        await assert.rejects(
            () => normalizeImageBuffer(source, 'webp', { width: 1536, height: 2288 }),
            (error) => error instanceof ImageDimensionMismatchError
        );
    });

    it('rejects a returned image with a different aspect ratio instead of stretching it', async () => {
        await assert.rejects(
            () =>
                normalizeImageBuffer(Buffer.from(PNG_BASE64, 'base64'), 'webp', {
                    width: 2,
                    height: 1
                }),
            (error) => {
                assert.ok(error instanceof ImageDimensionMismatchError);
                assert.deepEqual(error.expected, { width: 2, height: 1 });
                assert.deepEqual(error.actual, { width: 1, height: 1 });
                return true;
            }
        );
    });

    it('rejects oversized normalization targets before invoking sharp', async () => {
        await assert.rejects(
            () =>
                normalizeImageBuffer(Buffer.from(PNG_BASE64, 'base64'), 'webp', {
                    width: 100000,
                    height: 100000
                }),
            /请求尺寸无效.*单边最大值/
        );
    });
});

describe('resolveAcceptedImageTaskResponse', () => {
    it('retries accepted task payloads until the final image result arrives', async () => {
        const calls: number[] = [];
        const sleeps: number[] = [];
        const result = await resolveAcceptedImageTaskResponse(
            async () => {
                calls.push(Date.now());
                if (calls.length === 1) {
                    return {
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'sync-gen-task',
                            poll_url: '/api/image-tasks?ids=sync-gen-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('', { headers: { 'retry-after': '1' } })
                    };
                }
                return {
                    data: {
                        data: [{ b64_json: 'final-base64' }],
                        created: 123
                    } as OpenAI.Images.ImagesResponse,
                    response: new Response('', { headers: { 'retry-after': '1' } })
                };
            },
            {
                sleep: async (ms) => {
                    sleeps.push(ms);
                }
            }
        );

        assert.equal(calls.length, 2);
        assert.deepEqual(sleeps, [1000]);
        assert.equal(result.data?.[0]?.b64_json, 'final-base64');
    });

    it('throws a structured error after exhausting accepted-task retries', async () => {
        await assert.rejects(
            () =>
                resolveAcceptedImageTaskResponse(
                    async () => ({
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'sync-gen-task',
                            poll_url: '/api/image-tasks?ids=sync-gen-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('', { headers: { 'retry-after': '1' } })
                    }),
                    { maxAttempts: 1 }
                ),
            (error) => {
                assert.ok(error instanceof AcceptedImageTaskResponseError);
                assert.equal(error.taskId, 'sync-gen-task');
                assert.equal(error.pollUrl, '/api/image-tasks?ids=sync-gen-task');
                assert.equal(error.retryAfterSeconds, 1);
                return true;
            }
        );
    });

    it('uses the default retry delay for fractional Retry-After values', async () => {
        const sleeps: number[] = [];
        const result = await resolveAcceptedImageTaskResponse(
            async () => {
                if (sleeps.length === 0) {
                    return {
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'fractional-retry-after-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('', { headers: { 'retry-after': '0.5' } })
                    };
                }
                return {
                    data: {
                        data: [{ b64_json: 'final-base64' }],
                        created: 123
                    } as OpenAI.Images.ImagesResponse,
                    response: new Response('')
                };
            },
            {
                retryDelayMs: 2500,
                sleep: async (ms) => {
                    sleeps.push(ms);
                }
            }
        );

        assert.deepEqual(sleeps, [2500]);
        assert.equal(result.data?.[0]?.b64_json, 'final-base64');
    });

    it('caps fallback retry delays for accepted task responses', async () => {
        const sleeps: number[] = [];
        const result = await resolveAcceptedImageTaskResponse(
            async () => {
                if (sleeps.length === 0) {
                    return {
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'large-fallback-delay-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('')
                    };
                }
                return {
                    data: {
                        data: [{ b64_json: 'final-base64' }],
                        created: 123
                    } as OpenAI.Images.ImagesResponse,
                    response: new Response('')
                };
            },
            {
                retryDelayMs: 60_000,
                sleep: async (ms) => {
                    sleeps.push(ms);
                }
            }
        );

        assert.deepEqual(sleeps, [15_000]);
        assert.equal(result.data?.[0]?.b64_json, 'final-base64');
    });

    it('respects whole-second Retry-After values above the fallback cap', async () => {
        const sleeps: number[] = [];
        const result = await resolveAcceptedImageTaskResponse(
            async () => {
                if (sleeps.length === 0) {
                    return {
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'long-retry-after-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('', { headers: { 'retry-after': '30' } })
                    };
                }
                return {
                    data: {
                        data: [{ b64_json: 'final-base64' }],
                        created: 123
                    } as OpenAI.Images.ImagesResponse,
                    response: new Response('')
                };
            },
            {
                sleep: async (ms) => {
                    sleeps.push(ms);
                }
            }
        );

        assert.deepEqual(sleeps, [30_000]);
        assert.equal(result.data?.[0]?.b64_json, 'final-base64');
    });

    it('caps excessive Retry-After values for accepted task responses', async () => {
        const sleeps: number[] = [];
        const result = await resolveAcceptedImageTaskResponse(
            async () => {
                if (sleeps.length === 0) {
                    return {
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'excessive-retry-after-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('', { headers: { 'retry-after': '999' } })
                    };
                }
                return {
                    data: {
                        data: [{ b64_json: 'final-base64' }],
                        created: 123
                    } as OpenAI.Images.ImagesResponse,
                    response: new Response('')
                };
            },
            {
                sleep: async (ms) => {
                    sleeps.push(ms);
                }
            }
        );

        assert.deepEqual(sleeps, [300_000]);
        assert.equal(result.data?.[0]?.b64_json, 'final-base64');
    });

    it('stops accepted-task backoff when the caller aborts', async () => {
        const controller = new AbortController();
        let sleepSawSignal = false;

        await assert.rejects(
            () =>
                resolveAcceptedImageTaskResponse(
                    async () => ({
                        data: {
                            object: 'image.task',
                            status: 'pending',
                            task_id: 'abortable-task'
                        } as unknown as OpenAI.Images.ImagesResponse,
                        response: new Response('')
                    }),
                    {
                        abortSignal: controller.signal,
                        sleep: async (_ms, abortSignal) => {
                            sleepSawSignal = abortSignal === controller.signal;
                            controller.abort(new Error('caller aborted'));
                            if (abortSignal?.aborted) {
                                throw abortSignal.reason;
                            }
                        }
                    }
                ),
            /caller aborted/
        );

        assert.equal(sleepSawSignal, true);
    });

    it('preserves string abort reasons before retrying accepted tasks', async () => {
        const controller = new AbortController();
        let operationCalled = false;
        controller.abort('caller stopped');

        await assert.rejects(
            () =>
                resolveAcceptedImageTaskResponse(
                    async () => {
                        operationCalled = true;
                        return {
                            data: {
                                object: 'image.task',
                                status: 'pending',
                                task_id: 'abort-string-reason-task'
                            } as unknown as OpenAI.Images.ImagesResponse,
                            response: new Response('')
                        };
                    },
                    { abortSignal: controller.signal }
                ),
            /caller stopped/
        );
        assert.equal(operationCalled, false);
    });
});

describe('readRetryAfterSecondsHeader', () => {
    it('accepts positive whole seconds only', () => {
        assert.equal(readRetryAfterSecondsHeader('1'), 1);
        assert.equal(readRetryAfterSecondsHeader(' 3 '), 3);
        assert.equal(readRetryAfterSecondsHeader('15'), 15);
        assert.equal(readRetryAfterSecondsHeader('0'), undefined);
        assert.equal(readRetryAfterSecondsHeader('0.5'), undefined);
        assert.equal(readRetryAfterSecondsHeader('2.4'), undefined);
        assert.equal(readRetryAfterSecondsHeader('abc'), undefined);
        assert.equal(readRetryAfterSecondsHeader('999999999999999999999'), undefined);
        assert.equal(readRetryAfterSecondsHeader('Wed, 21 Oct 2015 07:28:00 GMT'), undefined);
        assert.equal(readRetryAfterSecondsHeader(3), undefined);
    });
});
