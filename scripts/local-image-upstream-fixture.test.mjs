import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    FIXTURE_IMAGE_BASE64,
    FIXTURE_IMAGE_PATH,
    MAX_JSON_BODY_BYTES,
    createFixtureServer
} from './local-image-upstream-fixture.mjs';

describe('local image upstream fixture', () => {
    it('serves Images API JSON responses', async () => {
        const fixture = await startFixture();
        try {
            const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-image-2', prompt: 'fixture json smoke', stream: false })
            });

            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') || '', /^application\/json\b/);
            const body = await response.json();
            assert.equal(body.data[0].b64_json, FIXTURE_IMAGE_BASE64);
            assert.equal(body.fixture_request.model, 'gpt-image-2');
            assert.equal(body.fixture_request.stream, false);
            assert.equal(body.fixture_request.size, undefined);
            assert.equal(body.fixture_request.quality, undefined);
        } finally {
            await fixture.close();
        }
    });

    it('serves Images API SSE responses', async () => {
        const fixture = await startFixture();
        try {
            const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-image-2', prompt: 'fixture sse smoke', stream: true })
            });

            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
            const events = readSseEvents(await response.text());
            assert.equal(events[0].comment, 'keepalive');
            assert.deepEqual(
                events.filter((event) => event.event).map((event) => event.event),
                ['image_generation.partial_image', 'image_generation.completed']
            );
            assert.equal(events[1].data.type, 'image_generation.partial_image');
            assert.equal(events[1].data.b64_json, FIXTURE_IMAGE_BASE64);
            assert.equal(events[2].data.type, 'image_generation.completed');
            assert.equal(events[2].data.b64_json, FIXTURE_IMAGE_BASE64);
            assert.equal(events[3].done, true);
        } finally {
            await fixture.close();
        }
    });

    it('serves Responses API JSON image outputs', async () => {
        const fixture = await startFixture();
        try {
            const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-5.4',
                    input: 'fixture responses json smoke',
                    stream: false,
                    tools: [{ type: 'image_generation' }],
                    tool_choice: { type: 'image_generation' }
                })
            });

            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') || '', /^application\/json\b/);
            const body = await response.json();
            assert.equal(body.id, 'resp_fixture');
            assert.equal(body.output[0].type, 'image_generation_call');
            assert.equal(body.output[0].result, FIXTURE_IMAGE_PATH);
            const imageResponse = await fetch(`${fixture.baseUrl}${FIXTURE_IMAGE_PATH}`);
            assert.equal(imageResponse.status, 200);
            assert.match(imageResponse.headers.get('content-type') || '', /^image\/png\b/);
            assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString('base64'), FIXTURE_IMAGE_BASE64);
        } finally {
            await fixture.close();
        }
    });

    it('serves Responses API SSE image events', async () => {
        const fixture = await startFixture();
        try {
            const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-5.4',
                    input: 'fixture responses sse smoke',
                    stream: true,
                    tools: [{ type: 'image_generation' }],
                    tool_choice: { type: 'image_generation' }
                })
            });

            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/);
            const events = readSseEvents(await response.text());
            assert.deepEqual(
                events.filter((event) => event.event).map((event) => event.event),
                [
                    'response.image_generation_call.partial_image',
                    'response.output_item.done',
                    'response.completed'
                ]
            );
            assert.equal(events[0].data.partial_image_b64, FIXTURE_IMAGE_BASE64);
            assert.equal(events[1].data.item.type, 'image_generation_call');
            assert.equal(events[1].data.item.result, FIXTURE_IMAGE_PATH);
            assert.equal(events[2].data.response.output[0].result, FIXTURE_IMAGE_PATH);
            assert.equal(events[3].done, true);
        } finally {
            await fixture.close();
        }
    });

    it('serves model discovery and health checks', async () => {
        const fixture = await startFixture();
        try {
            const healthResponse = await fetch(`${fixture.baseUrl}/health`);
            const modelsResponse = await fetch(`${fixture.baseUrl}/v1/models`);

            assert.equal(healthResponse.status, 200);
            assert.deepEqual(await healthResponse.json(), { ok: true });
            assert.equal(modelsResponse.status, 200);
            const models = await modelsResponse.json();
            assert.deepEqual(
                models.data.map((model) => model.id),
                [
                    'gpt-image-2',
                    'gpt-image-2.5',
                    'gpt-image-2.5-flare',
                    'gpt-image-2.5-sunburst',
                    'gemini-3.1-flash-image',
                    'gpt-5.4'
                ]
            );
        } finally {
            await fixture.close();
        }
    });

    it('rejects oversized JSON request bodies', async () => {
        const fixture = await startFixture();
        try {
            const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-image-2',
                    prompt: 'x'.repeat(MAX_JSON_BODY_BYTES)
                })
            });

            assert.equal(response.status, 413);
            const body = await response.json();
            assert.match(body.error.message, /too large/);
        } finally {
            await fixture.close();
        }
    });
});

async function startFixture() {
    const server = createFixtureServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server)
    };
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function readSseEvents(raw) {
    return raw
        .trim()
        .split(/\n\n+/)
        .map((chunk) => readSseEvent(chunk))
        .filter(Boolean);
}

function readSseEvent(chunk) {
    const lines = chunk.split(/\n/);
    const comment = lines.find((line) => line.startsWith(': '));
    const event = lines.find((line) => line.startsWith('event: '));
    const data = lines.find((line) => line.startsWith('data: '));
    if (comment) return { comment: comment.slice(2) };
    if (!data) return undefined;
    if (data === 'data: [DONE]') return { done: true };
    return {
        event: event ? event.slice('event: '.length) : undefined,
        data: JSON.parse(data.slice('data: '.length))
    };
}
