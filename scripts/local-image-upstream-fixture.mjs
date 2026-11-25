#!/usr/bin/env node

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_IMAGE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const FIXTURE_IMAGE_PATH = '/api/storage/generations/fixture.png';

class PayloadTooLargeError extends Error {
    constructor() {
        super('Request body too large');
        this.name = 'PayloadTooLargeError';
        this.status = 413;
    }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let raw = '';
        let byteLength = 0;
        let tooLarge = false;
        let settled = false;
        const cleanup = () => {
            request.off('data', onData);
            request.off('end', onEnd);
            request.off('error', onError);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const onData = (chunk) => {
            byteLength += Buffer.byteLength(chunk, 'utf8');
            if (byteLength > MAX_JSON_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            if (tooLarge) return;
            raw += chunk;
        };
        const onEnd = () => {
            if (tooLarge) {
                fail(new PayloadTooLargeError());
                return;
            }
            if (!raw.trim()) {
                finish({});
                return;
            }
            try {
                finish(JSON.parse(raw));
            } catch (error) {
                fail(error);
            }
        };
        const onError = (error) => fail(error);
        request.setEncoding('utf8');
        request.on('data', onData);
        request.on('end', onEnd);
        request.on('error', onError);
    });
}

function sendJson(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}

function sendFixtureImage(response) {
    const buffer = Buffer.from(FIXTURE_IMAGE_BASE64, 'base64');
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(buffer.byteLength) });
    response.end(buffer);
}

function writeSse(response, event, payload) {
    if (event) response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendImagesStream(response) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    response.write(': keepalive\n\n');
    writeSse(response, 'image_generation.partial_image', {
        type: 'image_generation.partial_image',
        partial_image_index: 0,
        b64_json: FIXTURE_IMAGE_BASE64
    });
    writeSse(response, 'image_generation.completed', {
        type: 'image_generation.completed',
        b64_json: FIXTURE_IMAGE_BASE64,
        output_format: 'png',
        size: '1024x1024',
        quality: 'low'
    });
    response.end('data: [DONE]\n\n');
}

function sendResponsesStream(response) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    writeSse(response, 'response.image_generation_call.partial_image', {
        type: 'response.image_generation_call.partial_image',
        partial_image_b64: FIXTURE_IMAGE_BASE64,
        partial_image_index: 0
    });
    writeSse(response, 'response.output_item.done', {
        type: 'response.output_item.done',
        item: {
            id: 'ig_fixture',
            type: 'image_generation_call',
            status: 'completed',
            result: FIXTURE_IMAGE_PATH
        }
    });
    writeSse(response, 'response.completed', {
        type: 'response.completed',
        response: {
            output: [
                {
                    id: 'ig_fixture',
                    type: 'image_generation_call',
                    status: 'completed',
                    result: FIXTURE_IMAGE_PATH
                }
            ]
        }
    });
    response.end('data: [DONE]\n\n');
}

function imagesResponse(body) {
    const created = Math.floor(Date.now() / 1000);
    return {
        created,
        data: [{ b64_json: FIXTURE_IMAGE_BASE64 }],
        usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2
        },
        fixture_request: {
            model: typeof body.model === 'string' ? body.model : undefined,
            stream: body.stream === true,
            size: typeof body.size === 'string' ? body.size : undefined,
            quality: typeof body.quality === 'string' ? body.quality : undefined,
            background: typeof body.background === 'string' ? body.background : undefined
        }
    };
}

function responsesJsonResponse(body) {
    return {
        id: 'resp_fixture',
        object: 'response',
        model: typeof body.model === 'string' ? body.model : 'gpt-5.4',
        output: [{ id: 'ig_fixture', type: 'image_generation_call', status: 'completed', result: FIXTURE_IMAGE_PATH }],
        usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2
        }
    };
}

function modelsResponse() {
    return {
        object: 'list',
        data: [
            { id: 'gpt-image-2', object: 'model', owned_by: 'fixture' },
            { id: 'gpt-image-2.5', object: 'model', owned_by: 'fixture' },
            { id: 'gpt-image-2.5-flare', object: 'model', owned_by: 'fixture' },
            { id: 'gpt-image-2.5-sunburst', object: 'model', owned_by: 'fixture' },
            { id: 'gemini-3.1-flash-image', object: 'model', owned_by: 'fixture' },
            { id: 'gpt-5.4', object: 'model', owned_by: 'fixture' }
        ]
    };
}

async function handleRequest(request, response) {
    const url = new URL(request.url || '/', 'http://fixture.local');
    if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(response, 200, modelsResponse());
        return;
    }
    if (request.method === 'GET' && url.pathname === FIXTURE_IMAGE_PATH) {
        sendFixtureImage(response);
        return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
        const body = await readJsonBody(request);
        if (body.stream === true) {
            sendImagesStream(response);
            return;
        }
        sendJson(response, 200, imagesResponse(body));
        return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJsonBody(request);
        if (body.stream === true) {
            sendResponsesStream(response);
            return;
        }
        sendJson(response, 200, responsesJsonResponse(body));
        return;
    }
    sendJson(response, 404, { error: { message: `No fixture route for ${request.method} ${url.pathname}` } });
}

export function createFixtureServer() {
    return http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
            const status = error instanceof PayloadTooLargeError ? error.status : 500;
            sendJson(response, status, { error: { message: error instanceof Error ? error.message : String(error) } });
        });
    });
}

export function startFixtureServer(port = Number(process.env.PORT || 19080), host = process.env.HOST || '127.0.0.1') {
    const server = createFixtureServer();
    server.listen(port, host, () => {
        const address = server.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : port;
        console.log(`local image upstream fixture listening on http://${host}:${resolvedPort}`);
    });
    return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    startFixtureServer();
}
