import {
    buildChannelEnvConfig,
    buildRedactedChannelEnvPreview
} from '../skills/visual-journal-image-agent/scripts/lib/channel-capability-matrix.mjs';
import { FIXTURE_IMAGE_BASE64, createFixtureServer } from './local-image-upstream-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const matrixScript = join(repoRoot, 'skills/visual-journal-image-agent/scripts/channel-capability-matrix.mjs');
const testApiKey = 'test-upstream-token';
const testResponsesModel = 'gpt-5.4';

describe('channel capability matrix Skill script', () => {
    it('writes a private directly usable channel configuration after all modes pass', async () => {
        const fixture = await startServer(createFixtureServer());
        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-'));
        const outputPath = join(tempRoot, 'channel.env');
        try {
            const result = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-id',
                    'fixture-upstream',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            assert.doesNotMatch(result.stdout, new RegExp(testApiKey));
            const report = JSON.parse(result.stdout);
            assert.equal(report.ok, true);
            assert.deepEqual(report.matrix.passed, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.matrix.failed, []);
            assert.equal(report.configuration.ready, true);
            assert.deepEqual(report.configuration.tested_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.configuration.enabled_request_modes, ['images-non-stream']);
            assert.deepEqual(report.onboarding.test_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.onboarding.tested_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.onboarding.enabled_request_modes, ['images-non-stream']);
            assert.equal(report.configuration.request_mode_selection, 'default');
            assert.equal(report.write.written, true);
            assert.deepEqual(report.configuration.env_preview, [
                'OPENAI_CHANNEL_1_ID=fixture-upstream',
                `OPENAI_CHANNEL_1_BASE_URL=${fixture.baseUrl}/v1`,
                'OPENAI_CHANNEL_1_API_KEYS=[redacted]',
                'OPENAI_CHANNEL_1_REQUEST_MODES=images-non-stream',
                'OPENAI_CHANNEL_1_REQUEST_MODE_PRIORITY=images-non-stream',
                'IMAGE_GENERATION_BACKEND=images-api',
                'IMAGE_STREAMING_STRATEGY=auto'
            ]);

            const content = readFileSync(outputPath, 'utf8');
            assert.match(content, /OPENAI_CHANNEL_1_ID=fixture-upstream/);
            assert.match(content, new RegExp(`OPENAI_CHANNEL_1_BASE_URL=${escapeRegExp(`${fixture.baseUrl}/v1`)}`));
            assert.match(content, new RegExp(`OPENAI_CHANNEL_1_API_KEYS=${testApiKey}`));
            assert.match(content, /OPENAI_CHANNEL_1_REQUEST_MODES=images-non-stream/);
            assert.match(content, /OPENAI_CHANNEL_1_REQUEST_MODE_PRIORITY=images-non-stream/);
            assert.match(content, /IMAGE_GENERATION_BACKEND=images-api/);
            assert.match(content, /IMAGE_STREAMING_STRATEGY=auto/);
            assert.doesNotMatch(content, /ENABLE_RESPONSES_IMAGE_BACKEND/);
            assert.doesNotMatch(content, /OPENAI_RESPONSES_API_MODEL/);
            assert.equal(statSync(outputPath).mode & 0o777, 0o600);

            const resolvedConfig = await resolveGeneratedConfig(outputPath);
            assert.equal(resolvedConfig.status, 0);
            assert.equal(resolvedConfig.stderr.trim(), '');
            assert.deepEqual(resolvedConfig.value, {
                channel: {
                    id: 'fixture-upstream',
                    base_url: `${fixture.baseUrl}/v1`,
                    request_modes: ['images-non-stream'],
                    request_mode_priority: ['images-non-stream']
                },
                image_backend: 'images-api',
                streaming_strategy: 'auto'
            });

            const refused = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-id',
                    'fixture-upstream',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );
            assert.equal(refused.status, 2);
            assert.match(refused.stderr, /已存在/);
            assert.equal(refused.stdout.trim(), '');

            const overwritten = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-id',
                    'fixture-upstream',
                    '--timeout-ms',
                    '5000',
                    '--overwrite'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );
            assert.equal(overwritten.status, 0);
            assert.equal(JSON.parse(overwritten.stdout).write.written, true);
            assert.equal(statSync(outputPath).mode & 0o777, 0o600);
        } finally {
            await fixture.close();
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('writes only the verified Images API mode and preserves fixed probe order', async () => {
        const calls = [];
        const fixture = await startServer(
            createServer(async (request, response) => {
                const url = new URL(request.url || '/', 'http://fixture.local');
                if (request.method === 'GET' && url.pathname === '/v1/models') {
                    calls.push({ method: request.method, path: url.pathname });
                    sendJson(response, 200, { data: [{ id: 'gpt-image-2' }, { id: testResponsesModel }] });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
                    const body = await readJsonBody(request);
                    calls.push({ method: request.method, path: url.pathname, stream: body.stream === true });
                    if (body.stream === true) {
                        sendJson(response, 502, { error: { message: 'images sse unavailable' } });
                        return;
                    }
                    sendJson(response, 200, { data: [{ b64_json: FIXTURE_IMAGE_BASE64 }] });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/responses') {
                    const body = await readJsonBody(request);
                    calls.push({ method: request.method, path: url.pathname, stream: body.stream === true });
                    sendJson(response, 503, { error: { message: 'responses unavailable' } });
                    return;
                }
                sendJson(response, 404, { error: { message: 'unknown route' } });
            })
        );
        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-partial-'));
        const outputPath = join(tempRoot, 'partial.env');
        try {
            const result = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-index',
                    '2',
                    '--channel-id',
                    'images-only',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );

            assert.equal(result.status, 0);
            const report = JSON.parse(result.stdout);
            assert.deepEqual(report.matrix.passed, ['images-non-stream']);
            assert.deepEqual(report.matrix.failed, ['images-sse', 'responses-non-stream', 'responses-sse']);
            assert.equal(report.matrix.coverage_complete, true);
            assert.equal(report.configuration.ready, true);
            assert.deepEqual(report.onboarding.test_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.onboarding.tested_request_modes, ['images-non-stream']);
            assert.deepEqual(report.onboarding.enabled_request_modes, ['images-non-stream']);
            assert.equal(report.write.written, true);
            assert.deepEqual(calls, [
                { method: 'GET', path: '/v1/models' },
                { method: 'POST', path: '/v1/images/generations', stream: false },
                { method: 'POST', path: '/v1/images/generations', stream: true },
                { method: 'POST', path: '/v1/responses', stream: false },
                { method: 'POST', path: '/v1/responses', stream: true }
            ]);

            const content = readFileSync(outputPath, 'utf8');
            assert.match(content, /OPENAI_CHANNEL_2_REQUEST_MODES=images-non-stream/);
            assert.match(content, /OPENAI_CHANNEL_2_REQUEST_MODE_PRIORITY=images-non-stream/);
            assert.match(content, /IMAGE_GENERATION_BACKEND=images-api/);
            assert.match(content, /IMAGE_STREAMING_STRATEGY=auto/);
            assert.doesNotMatch(content, /ENABLE_RESPONSES_IMAGE_BACKEND/);
            assert.doesNotMatch(content, /OPENAI_RESPONSES_API_MODEL/);
        } finally {
            await fixture.close();
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('selects the Responses backend when no Images API request mode is usable', async () => {
        const calls = [];
        const fixture = await startServer(
            createServer(async (request, response) => {
                const url = new URL(request.url || '/', 'http://fixture.local');
                if (request.method === 'GET' && url.pathname === '/v1/models') {
                    calls.push({ method: request.method, path: url.pathname });
                    sendJson(response, 200, { data: [{ id: 'gpt-image-2' }, { id: testResponsesModel }] });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
                    const body = await readJsonBody(request);
                    calls.push({ method: request.method, path: url.pathname, stream: body.stream === true });
                    sendJson(response, 503, { error: { message: 'images unavailable' } });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/responses') {
                    const body = await readJsonBody(request);
                    calls.push({ method: request.method, path: url.pathname, stream: body.stream === true });
                    if (body.stream === true) {
                        sendJson(response, 503, { error: { message: 'responses sse unavailable' } });
                        return;
                    }
                    sendJson(response, 200, {
                        output: [
                            {
                                type: 'image_generation_call',
                                status: 'completed',
                                result: `data:image/png;base64,${FIXTURE_IMAGE_BASE64}`
                            }
                        ]
                    });
                    return;
                }
                sendJson(response, 404, { error: { message: 'unknown route' } });
            })
        );
        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-responses-only-'));
        const outputPath = join(tempRoot, 'responses-only.env');
        try {
            const defaultResult = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-index',
                    '3',
                    '--channel-id',
                    'responses-only',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );
            assert.equal(defaultResult.status, 1);
            const defaultReport = JSON.parse(defaultResult.stdout);
            assert.equal(defaultReport.configuration.request_mode_selection, 'default');
            assert.deepEqual(defaultReport.configuration.enabled_request_modes, ['images-non-stream']);
            assert.deepEqual(defaultReport.onboarding.test_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(defaultReport.onboarding.tested_request_modes, ['responses-non-stream']);
            assert.deepEqual(defaultReport.onboarding.enabled_request_modes, ['images-non-stream']);
            assert.ok(defaultReport.configuration.blocking_reasons.includes('enabled_request_modes_not_passed'));
            assert.equal(defaultReport.write.written, false);
            assert.equal(existsSync(outputPath), false);
            calls.length = 0;

            const result = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--enable-request-modes',
                    'responses-non-stream',
                    '--write-env-file',
                    outputPath,
                    '--channel-index',
                    '3',
                    '--channel-id',
                    'responses-only',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );

            assert.equal(result.status, 0);
            const report = JSON.parse(result.stdout);
            assert.deepEqual(report.matrix.passed, ['responses-non-stream']);
            assert.deepEqual(report.matrix.failed, ['images-non-stream', 'images-sse', 'responses-sse']);
            assert.equal(report.configuration.ready, true);
            assert.deepEqual(report.onboarding.test_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.onboarding.tested_request_modes, ['responses-non-stream']);
            assert.deepEqual(report.onboarding.enabled_request_modes, ['responses-non-stream']);
            assert.equal(report.configuration.image_backend, 'responses-image-generation');
            assert.equal(report.configuration.streaming_strategy, 'auto');
            assert.equal(report.write.written, true);
            assert.deepEqual(calls, [
                { method: 'GET', path: '/v1/models' },
                { method: 'POST', path: '/v1/images/generations', stream: false },
                { method: 'POST', path: '/v1/images/generations', stream: true },
                { method: 'POST', path: '/v1/responses', stream: false },
                { method: 'POST', path: '/v1/responses', stream: true }
            ]);

            const content = readFileSync(outputPath, 'utf8');
            assert.match(content, /OPENAI_CHANNEL_3_REQUEST_MODES=responses-non-stream/);
            assert.match(content, /OPENAI_CHANNEL_3_REQUEST_MODE_PRIORITY=responses-non-stream/);
            assert.match(content, /IMAGE_GENERATION_BACKEND=responses-image-generation/);
            assert.match(content, /IMAGE_STREAMING_STRATEGY=auto/);
            assert.match(content, /ENABLE_RESPONSES_IMAGE_BACKEND=true/);
            assert.match(content, new RegExp(`OPENAI_RESPONSES_API_MODEL=${testResponsesModel}`));

            const resolvedConfig = await resolveGeneratedConfig(outputPath);
            assert.equal(resolvedConfig.status, 0);
            assert.equal(resolvedConfig.stderr.trim(), '');
            assert.equal(resolvedConfig.value.channel.id, 'responses-only');
            assert.deepEqual(resolvedConfig.value.channel.request_modes, ['responses-non-stream']);
            assert.equal(resolvedConfig.value.image_backend, 'responses-image-generation');
            assert.equal(resolvedConfig.value.streaming_strategy, 'auto');
        } finally {
            await fixture.close();
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('refuses a remote URL-only result and leaves the target absent', async () => {
        const fixture = await startServer(
            createServer(async (request, response) => {
                const url = new URL(request.url || '/', 'http://fixture.local');
                if (request.method === 'GET' && url.pathname === '/v1/models') {
                    sendJson(response, 200, { data: [{ id: 'gpt-image-2' }, { id: testResponsesModel }] });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
                    await readJsonBody(request);
                    sendJson(response, 200, { data: [{ url: 'https://cdn.example.test/generated.png' }] });
                    return;
                }
                if (request.method === 'POST' && url.pathname === '/v1/responses') {
                    await readJsonBody(request);
                    sendJson(response, 503, { error: { message: 'responses unavailable' } });
                    return;
                }
                sendJson(response, 404, { error: { message: 'unknown route' } });
            })
        );
        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-remote-url-'));
        const outputPath = join(tempRoot, 'remote-url.env');
        try {
            const result = await runMatrix(
                [
                    '--base-url',
                    `${fixture.baseUrl}/v1`,
                    '--responses-model',
                    testResponsesModel,
                    '--allow-billable',
                    '--confirm-billable',
                    '--write-env-file',
                    outputPath,
                    '--channel-id',
                    'remote-url-only',
                    '--timeout-ms',
                    '5000'
                ],
                { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
            );

            assert.equal(result.status, 1);
            assert.doesNotMatch(result.stdout, new RegExp(testApiKey));
            const report = JSON.parse(result.stdout);
            assert.deepEqual(report.matrix.passed, []);
            assert.equal(report.matrix.modes['images-non-stream'].has_remote_url_result, true);
            assert.equal(report.configuration.ready, false);
            assert.deepEqual(report.onboarding.test_request_modes, [
                'images-non-stream',
                'images-sse',
                'responses-non-stream',
                'responses-sse'
            ]);
            assert.deepEqual(report.onboarding.tested_request_modes, []);
            assert.deepEqual(report.onboarding.enabled_request_modes, ['images-non-stream']);
            assert.deepEqual(report.configuration.blocking_reasons, [
                'no_consumable_image_mode',
                'enabled_request_modes_not_passed'
            ]);
            assert.equal(report.write.written, false);
            assert.equal(report.write.reason, 'configuration_not_ready');
            assert.equal(existsSync(outputPath), false);
        } finally {
            await fixture.close();
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('requires explicit billable permission before it accepts a private output target', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-non-billable-'));
        const outputPath = join(tempRoot, 'unverified.env');
        try {
            const result = await runMatrix(['--base-url', 'http://127.0.0.1:9/v1', '--write-env-file', outputPath], {
                GPT_IMAGE_UPSTREAM_API_KEY: testApiKey
            });

            assert.equal(result.status, 2);
            assert.match(result.stderr, /--allow-billable/);
            assert.equal(result.stdout.trim(), '');
            assert.equal(existsSync(outputPath), false);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('requires a separate confirmation flag before a billable capability matrix can run', async () => {
        const result = await runMatrix(['--base-url', 'http://127.0.0.1:9/v1', '--allow-billable'], {
            GPT_IMAGE_UPSTREAM_API_KEY: testApiKey
        });

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--confirm-billable/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects a billable matrix without an API key before contacting the upstream', async () => {
        const calls = [];
        const fixture = await startServer(
            createServer((request, response) => {
                calls.push(request.url);
                sendJson(response, 500, { error: { message: 'unexpected probe' } });
            })
        );
        try {
            const result = await runMatrix(
                ['--base-url', `${fixture.baseUrl}/v1`, '--allow-billable', '--confirm-billable'],
                {}
            );

            assert.equal(result.status, 2);
            assert.match(result.stderr, /需要有效的 GPT_IMAGE_UPSTREAM_API_KEY/);
            assert.match(result.stderr, /未发送计费探针/);
            assert.equal(result.stdout.trim(), '');
            assert.deepEqual(calls, []);
        } finally {
            await fixture.close();
        }
    });

    it('rejects remote plain HTTP before starting any upstream probe', async () => {
        const result = await runMatrix(
            ['--base-url', 'http://images.internal.example.test/v1', '--allow-billable', '--confirm-billable'],
            { GPT_IMAGE_UPSTREAM_API_KEY: testApiKey }
        );

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--allow-plain-http/);
        assert.equal(result.stdout.trim(), '');
    });

    it('requires explicit confirmation before adding a remote plain HTTP allowlist', async () => {
        const baseUrl = 'http://images.internal.example.test/v1';
        assert.throws(
            () =>
                buildChannelEnvConfig({
                    channelIndex: 4,
                    channelId: 'invalid channel',
                    baseUrl,
                    apiKey: testApiKey,
                    requestModes: ['images-non-stream'],
                    allowPlainHttp: true
                }),
            /channel_id/
        );
        assert.throws(
            () =>
                buildChannelEnvConfig({
                    channelIndex: 4,
                    channelId: 'plain-http',
                    baseUrl: 'https://user:secret@example.test/v1',
                    apiKey: testApiKey,
                    requestModes: ['images-non-stream'],
                    allowPlainHttp: true
                }),
            /不能包含凭据/
        );
        assert.throws(
            () =>
                buildChannelEnvConfig({
                    channelIndex: 4,
                    channelId: 'plain-http',
                    baseUrl,
                    apiKey: 'key,with-comma',
                    requestModes: ['images-non-stream'],
                    allowPlainHttp: true
                }),
            /api_key_contains_comma/
        );
        assert.throws(
            () =>
                buildChannelEnvConfig({
                    channelIndex: 4,
                    channelId: 'plain-http',
                    baseUrl,
                    apiKey: testApiKey,
                    requestModes: ['images-non-stream'],
                    requestModePriority: ['images-sse'],
                    allowPlainHttp: true
                }),
            /request_mode_priority/
        );
        assert.throws(
            () =>
                buildChannelEnvConfig({
                    channelIndex: 4,
                    channelId: 'plain-http',
                    baseUrl,
                    apiKey: testApiKey,
                    requestModes: ['images-non-stream']
                }),
            /--allow-plain-http/
        );
        assert.throws(
            () =>
                buildRedactedChannelEnvPreview({
                    channelIndex: 4,
                    channelId: 'plain-http',
                    baseUrl,
                    requestModes: ['images-non-stream']
                }),
            /--allow-plain-http/
        );
        const config = buildChannelEnvConfig({
            channelIndex: 4,
            channelId: 'plain-http',
            baseUrl,
            apiKey: testApiKey,
            requestModes: ['images-non-stream'],
            allowPlainHttp: true
        });
        const preview = buildRedactedChannelEnvPreview({
            channelIndex: 4,
            channelId: 'plain-http',
            baseUrl,
            requestModes: ['images-non-stream'],
            allowPlainHttp: true
        });

        assert.match(config, new RegExp(`OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS=${escapeRegExp(baseUrl)}`));
        assert.ok(preview.includes(`OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS=${baseUrl}`));
        assert.doesNotMatch(config, /OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS=http:\/\/127\.0\.0\.1/);

        const tempRoot = mkdtempSync(join(tmpdir(), 'channel-capability-matrix-plain-http-'));
        const outputPath = join(tempRoot, 'plain-http.env');
        try {
            writeFileSync(outputPath, config, { mode: 0o600 });
            const resolvedConfig = await resolveGeneratedConfig(outputPath);
            assert.equal(resolvedConfig.status, 0);
            assert.equal(resolvedConfig.stderr.trim(), '');
            assert.equal(resolvedConfig.value.channel.base_url, baseUrl);
            assert.deepEqual(resolvedConfig.value.channel.request_modes, ['images-non-stream']);
            assert.equal(resolvedConfig.value.image_backend, 'images-api');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

async function startServer(server) {
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

function runMatrix(args, env) {
    return new Promise((resolveResult) => {
        const child = spawn(process.execPath, [matrixScript, ...args], {
            cwd: repoRoot,
            env: {
                ...buildIsolatedEnvironment(),
                ...env
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.once('error', () => {
            resolveResult({ status: undefined, stdout, stderr });
        });
        child.once('close', (status) => {
            resolveResult({ status: status ?? undefined, stdout, stderr });
        });
    });
}

function resolveGeneratedConfig(envFilePath) {
    const script = [
        "import { parseChannelPoolConfig } from './src/lib/channel-router.ts';",
        "import { readImageGenerationBackend, readImageStreamingStrategy } from './src/lib/image-upstream-strategy.ts';",
        'const formData = new FormData();',
        'const config = parseChannelPoolConfig(process.env);',
        'const credential = config.credentials[0];',
        'console.log(JSON.stringify({',
        '  channel: {',
        '    id: credential.channelId,',
        '    base_url: credential.baseUrl,',
        '    request_modes: credential.requestModes,',
        '    request_mode_priority: credential.requestModePriority',
        '  },',
        '  image_backend: readImageGenerationBackend(formData),',
        '  streaming_strategy: readImageStreamingStrategy(formData)',
        '}));'
    ].join('\n');
    return new Promise((resolveResult) => {
        const child = spawn(
            process.execPath,
            ['--env-file', envFilePath, '--import', 'tsx', '--input-type=module', '--eval', script],
            {
                cwd: repoRoot,
                env: buildIsolatedEnvironment(),
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.once('error', () => {
            resolveResult({ status: undefined, stderr, value: undefined });
        });
        child.once('close', (status) => {
            let value;
            try {
                value = JSON.parse(stdout);
            } catch {}
            resolveResult({ status: status ?? undefined, stderr, value });
        });
    });
}

function buildIsolatedEnvironment() {
    const keepNames = ['HOME', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE'];
    const environment = { GPT_IMAGE_AGENT_LOAD_ENV_FILE: '0' };
    for (const name of keepNames) {
        if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
}

async function readJsonBody(request) {
    let text = '';
    request.setEncoding('utf8');
    for await (const chunk of request) text += chunk;
    return text ? JSON.parse(text) : {};
}

function sendJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
