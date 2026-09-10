import { AGENT_ENDPOINTS } from '../skills/visual-journal-image-agent/scripts/lib/agent-api-paths.mjs';
import { enrichFailureWithAgentDiagnostics } from '../skills/visual-journal-image-agent/scripts/lib/agent-diagnostics-summary.mjs';
import {
    parseRetryAfterValue,
    readCapabilitiesImageTransportTimeoutMs,
    resolveAgentToken,
    resolveSameOriginUrl,
    validateAgentEditRequestAgainstCapabilities,
    validateAgentGenerateRequestAgainstCapabilities
} from '../skills/visual-journal-image-agent/scripts/lib/script-utils.mjs';
import { AGENT_ENDPOINTS as SERVER_AGENT_ENDPOINTS } from '../src/lib/agent-api-paths.mjs';
import { FIXTURE_IMAGE_BASE64 } from './local-image-upstream-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const skillRoot = join(repoRoot, 'skills/visual-journal-image-agent');
const skillScriptsRoot = join(repoRoot, 'skills/visual-journal-image-agent/scripts');
const localUpstreamProbeTimeoutMs = '5000';

function agentGenerateCapabilities(extra = {}) {
    return {
        orchestration: {
            supported: true,
            transport_selection: 'server_owned',
            endpoint: '/api/agent/image-requests'
        },
        agent_jobs: { supported: true, mode: 'job_polling' },
        limits: {
            generate_images: { min: 1, max: 4 },
            edit_images: { min: 1, max: 4 },
            generate_images_by_backend: {
                'images-api': { min: 1, max: 4 },
                'responses-image-generation': { min: 1, max: 1 }
            },
            edit_images_by_backend: {
                'images-api': { min: 1, max: 4 },
                'responses-image-generation': { min: 1, max: 1 }
            },
            partial_images: { min: 0, max: 4 },
            partial_images_by_backend: {
                'images-api': { min: 0, max: 4 },
                'responses-image-generation': { min: 1, max: 3 }
            },
            upload_images: { max: 8 }
        },
        defaults: { partial_images: 2 },
        ...extra
    };
}

describe('Agent skill script argument validation', () => {
    it('resolves the client token from either supported environment variable', () => {
        assert.equal(resolveAgentToken({ GPT_IMAGE_AGENT_TOKEN: 'legacy', AGENT_API_TOKEN: 'server' }), 'legacy');
        assert.equal(resolveAgentToken({ AGENT_API_TOKEN: 'server' }), 'server');
        assert.equal(resolveAgentToken({}), '');
    });

    it('lists declared models with JSON output and the configured Agent token', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.url, '/api/agent/models');
                assert.equal(request.headers.authorization, 'Bearer list-models-token');
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ok: true,
                        default_model: 'custom-default',
                        known_models: [{ id: 'custom-default' }],
                        channels: [{ id: 'images', models: ['custom-default'], probe_status: 'not_probed' }]
                    })
                );
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('list-models.mjs', ['--json', '--base-url', baseUrl], {
                    GPT_IMAGE_AGENT_TOKEN: 'list-models-token'
                });
                assert.equal(result.status, 0);
                assert.equal(result.stderr, '');
                assert.equal(JSON.parse(result.stdout).default_model, 'custom-default');
            }
        );
    });

    it('accepts the server-side AGENT_API_TOKEN name for Agent requests', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.headers.authorization, 'Bearer server-token');
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({ ok: true, default_model: 'gpt-image-2', known_models: [], channels: [] })
                );
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('list-models.mjs', ['--json', '--base-url', baseUrl], {
                    AGENT_API_TOKEN: 'server-token'
                });
                assert.equal(result.status, 0);
                assert.equal(result.stderr, '');
            }
        );
    });

    it('preserves a deployment path when listing models', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.url, '/playground/api/agent/models');
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ok: true,
                        default_model: 'gpt-image-2',
                        known_models: [],
                        channels: []
                    })
                );
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'list-models.mjs',
                    ['--json', '--base-url', `${baseUrl}/playground`],
                    { GPT_IMAGE_AGENT_TOKEN: 'path-token' }
                );
                assert.equal(result.status, 0);
                assert.equal(result.stderr, '');
            }
        );
    });

    it('rejects cross-origin model-directory redirects without forwarding credentials', async () => {
        const received = [];
        await withServer(
            (request, response) => {
                received.push({ url: request.url, authorization: request.headers.authorization });
                response.writeHead(302, { location: 'https://attacker.example/api/agent/models' });
                response.end();
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'list-models.mjs',
                    ['--json', '--base-url', baseUrl],
                    { GPT_IMAGE_AGENT_TOKEN: 'redirect-secret' }
                );
                assert.equal(result.status, 1);
                assert.match(result.stderr, /拒绝跨源重定向/);
                assert.deepEqual(received, [{ url: '/api/agent/models', authorization: 'Bearer redirect-secret' }]);
            }
        );
    });

    it('rejects invalid list-models arguments before making a request', () => {
        const missingValue = runSkillScript('list-models.mjs', ['--base-url']);
        assert.equal(missingValue.status, 2);
        assert.match(missingValue.stderr, /--base-url 需要参数值/);

        const unknown = runSkillScript('list-models.mjs', ['--unknown']);
        assert.equal(unknown.status, 2);
        assert.match(unknown.stderr, /未知参数：--unknown/);
    });

    it('classifies list-models timeout and malformed responses explicitly', async () => {
        await withServer(
            (_request, response) => {
                setTimeout(() => {
                    response.writeHead(200, { 'content-type': 'text/plain' });
                    response.end('not-json');
                }, 100);
            },
            async (baseUrl) => {
                const timeoutResult = await runSkillScriptAsync(
                    'list-models.mjs',
                    ['--base-url', baseUrl, '--timeout-ms', '20'],
                    {},
                    { timeoutMs: 2000 }
                );
                assert.equal(timeoutResult.status, 1);
                assert.match(timeoutResult.stderr, /模型目录请求超时/);
            }
        );

        await withServer(
            (_request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: true, known_models: [] }));
            },
            async (baseUrl) => {
                const malformedResult = await runSkillScriptAsync(
                    'list-models.mjs',
                    ['--base-url', baseUrl],
                    {},
                    { timeoutMs: 2000 }
                );
                assert.equal(malformedResult.status, 1);
                assert.match(malformedResult.stderr, /模型目录请求失败/);
            }
        );
    });

    it('prioritizes backend-specific output limits and falls back for older capabilities', () => {
        const capabilities = agentGenerateCapabilities();

        assert.doesNotThrow(() =>
            validateAgentGenerateRequestAgainstCapabilities({ n: 4, image_backend: 'images-api' }, capabilities)
        );
        assert.throws(
            () =>
                validateAgentGenerateRequestAgainstCapabilities(
                    { n: 2, image_backend: 'responses-image-generation' },
                    capabilities
                ),
            /n 必须在当前 capabilities 允许的 1 到 1 之间/
        );
        assert.throws(
            () =>
                validateAgentEditRequestAgainstCapabilities(
                    { n: 2, image_backend: 'responses-image-generation' },
                    capabilities
                ),
            /n 必须在当前 capabilities 允许的 1 到 1 之间/
        );

        const legacyCapabilities = {
            limits: {
                generate_images: { min: 1, max: 4 },
                edit_images: { min: 1, max: 4 }
            }
        };
        assert.doesNotThrow(() =>
            validateAgentGenerateRequestAgainstCapabilities(
                { n: 4, image_backend: 'responses-image-generation' },
                legacyCapabilities
            )
        );
        assert.doesNotThrow(() =>
            validateAgentEditRequestAgainstCapabilities(
                { n: 4, image_backend: 'responses-image-generation' },
                legacyCapabilities
            )
        );
    });

    it('enforces one-sided capability ranges when a legacy service omits one bound', () => {
        const capabilities = {
            limits: {
                generate_images: { min: 2 },
                edit_images: { max: 3 }
            }
        };

        assert.throws(
            () => validateAgentGenerateRequestAgainstCapabilities({ n: 1 }, capabilities),
            /不能小于当前 capabilities 允许的最小值 2/
        );
        assert.doesNotThrow(() => validateAgentGenerateRequestAgainstCapabilities({ n: 2 }, capabilities));
        assert.throws(
            () => validateAgentEditRequestAgainstCapabilities({ n: 4 }, capabilities),
            /不能大于当前 capabilities 允许的最大值 3/
        );
        assert.doesNotThrow(() => validateAgentEditRequestAgainstCapabilities({ n: 3 }, capabilities));
    });

    it('uses the public partial image range for requests that resolve to non-stream mode', () => {
        const capabilities = agentGenerateCapabilities({
            upstream_request_headers: {
                channels: [{ request_modes: ['images-non-stream'] }]
            },
            limits: {
                ...agentGenerateCapabilities().limits,
                partial_images_by_backend: {
                    'images-api': { min: 1, max: 3 },
                    'responses-image-generation': { min: 1, max: 3 }
                }
            }
        });

        assert.doesNotThrow(() =>
            validateAgentGenerateRequestAgainstCapabilities(
                { n: 1, partial_images: 0, image_backend: 'images-api', stream_mode: 'non_stream' },
                capabilities
            )
        );
        assert.doesNotThrow(() =>
            validateAgentEditRequestAgainstCapabilities(
                {
                    n: 1,
                    partial_images: 4,
                    image_backend: 'images-api',
                    stream_mode: 'auto',
                    streaming_strategy: 'off'
                },
                capabilities
            )
        );
        assert.throws(
            () =>
                validateAgentGenerateRequestAgainstCapabilities(
                    { n: 1, partial_images: 4, image_backend: 'images-api', stream_mode: 'auto' },
                    { ...capabilities, upstream_request_headers: { channels: [{ request_modes: ['images-sse'] }] } }
                ),
            /partial_images 必须在当前 capabilities 允许的 1 到 3 之间/
        );
    });

    it('rejects invalid generate numeric options before dry-run output', () => {
        const result = runSkillScript('generate-image.mjs', ['--n', 'abc', 'prompt']);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--n 必须是正整数/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects invalid edit timeout before reading the image path', () => {
        const result = runSkillScript('edit-image.mjs', ['--timeout-ms', 'abc', '/tmp/missing.png', 'prompt']);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--timeout-ms 必须是正整数/);
        assert.equal(result.stdout.trim(), '');
    });

    it('accepts --image as an edit image path alias', () => {
        const result = runSkillScript('edit-image.mjs', ['--image', '/tmp/source.png', 'prompt']);

        assert.equal(result.status, 0);
        assert.equal(result.stderr.trim(), '');
        const body = JSON.parse(result.stdout);
        assert.equal(body.request.image_path, '/tmp/source.png');
        assert.equal(body.request.prompt, 'prompt');
    });

    it('rejects mixing --image with positional edit image path', () => {
        const result = runSkillScript('edit-image.mjs', ['/tmp/source.png', '--image', '/tmp/other.png', 'prompt']);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--image 与位置参数 <image-path> 不能同时设置/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects repeated --image edit image aliases', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--image',
            '/tmp/source.png',
            '--image',
            '/tmp/other.png',
            'prompt'
        ]);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--image 只能设置一次/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects invalid upstream probe timeout before network checks', () => {
        const result = runSkillScript('probe-upstream-image.mjs', ['--timeout-ms', 'abc']);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--timeout-ms 必须是正整数/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects malformed or non-positive image sizes before dry-run or network requests', () => {
        const generateResult = runSkillScript('generate-image.mjs', ['--size', '0x2048', 'prompt']);
        assert.equal(generateResult.status, 2);
        assert.match(generateResult.stderr, /--size 的宽度和高度必须是正数/);
        assert.equal(generateResult.stdout.trim(), '');

        const editResult = runSkillScript('edit-image.mjs', ['--size', '2048x0', '/tmp/source.png', 'prompt']);
        assert.equal(editResult.status, 2);
        assert.match(editResult.stderr, /--size 的宽度和高度必须是正数/);
        assert.equal(editResult.stdout.trim(), '');

        const probeResult = runSkillScript('probe-upstream-image.mjs', ['--size', 'invalid-size']);
        assert.equal(probeResult.status, 2);
        assert.match(probeResult.stderr, /--size 必须是 auto 或 WIDTHxHEIGHT/);
        assert.equal(probeResult.stdout.trim(), '');

        const legacyForceResult = runSkillScript('generate-image.mjs', [
            '--model',
            'gpt-image-1',
            '--force-request',
            '--size',
            '512x512',
            'prompt'
        ]);
        assert.equal(legacyForceResult.status, 2);
        assert.match(legacyForceResult.stderr, /请使用 auto、1024x1024、1536x1024 或 1024x1536/);
        assert.equal(legacyForceResult.stdout.trim(), '');
    });

    it('caps Agent diagnostics enrichment timeout independently of image request timeouts', async () => {
        const startedAt = Date.now();
        const result = await enrichFailureWithAgentDiagnostics({
            baseUrl: 'http://example.test/playground',
            authHeaders: () => ({}),
            idempotencyKey: 'slow-diagnostics-key',
            failureOutput: { ok: false, error: { code: 'network_error' } },
            summary: {
                ok: false,
                retryable: true,
                next_action: 'retry_after_wait'
            },
            timeoutMs: 420000,
            diagnosticsTimeoutMs: 25,
            fetchFn: (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                })
        });

        assert.equal(result.summary.agent_diagnostics_checked, true);
        assert.equal(result.summary.agent_diagnostics_found, false);
        assert.equal(result.summary.agent_diagnostics_unavailable_reason, 'diagnostics_timeout');
        assert.equal(result.failureOutput.agent_failure_diagnostics.unavailable_reason, 'diagnostics_timeout');
        assert.equal(result.summary.retryable, true);
        assert.equal(result.summary.next_action, 'retry_after_wait');
        assert.ok(Date.now() - startedAt < 1000);
    });

    it('reports non-json Agent diagnostics responses distinctly', async () => {
        const result = await enrichFailureWithAgentDiagnostics({
            baseUrl: 'http://example.test/playground',
            authHeaders: () => ({}),
            idempotencyKey: 'html-diagnostics-key',
            failureOutput: { ok: false, error: { code: 'network_error' } },
            summary: { ok: false },
            timeoutMs: 420000,
            fetchFn: async () => ({
                ok: false,
                status: 502,
                headers: new Headers({ 'content-type': 'text/html' }),
                text: async () => '<html>bad gateway</html>'
            })
        });

        assert.equal(result.summary.agent_diagnostics_checked, true);
        assert.equal(result.summary.agent_diagnostics_found, false);
        assert.equal(result.summary.agent_diagnostics_unavailable_reason, 'non_json_response');
        assert.equal(result.summary.agent_diagnostics_http_status, 502);
        assert.equal(result.failureOutput.agent_failure_diagnostics.unavailable_reason, 'non_json_response');
        assert.equal(result.failureOutput.agent_failure_diagnostics.http_status, 502);
    });

    it('treats found Agent diagnostics without payload as invalid', async () => {
        const result = await enrichFailureWithAgentDiagnostics({
            baseUrl: 'http://example.test/playground',
            authHeaders: () => ({}),
            idempotencyKey: 'missing-diagnostics-key',
            failureOutput: { ok: false, error: { code: 'network_error' } },
            summary: { ok: false },
            timeoutMs: 420000,
            fetchFn: async () => ({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                text: async () => JSON.stringify({ found: true })
            })
        });

        assert.equal(result.summary.agent_diagnostics_checked, true);
        assert.equal(result.summary.agent_diagnostics_found, false);
        assert.equal(result.summary.agent_diagnostics_unavailable_reason, 'invalid_response');
        assert.equal(result.summary.agent_diagnostics_http_status, 200);
        assert.equal(result.failureOutput.agent_failure_diagnostics.found, false);
        assert.equal(result.failureOutput.agent_failure_diagnostics.unavailable_reason, 'invalid_response');
        assert.equal(result.failureOutput.agent_failure_diagnostics.http_status, 200);
        assert.equal(result.failureOutput.agent_failure_diagnostics.request_id, undefined);
    });

    it('converts local images to webp by default', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-convert-'));
        try {
            const inputPath = join(tempRoot, 'source.png');
            writeFileSync(inputPath, validPngBuffer());

            const result = runSkillScript('convert-image-format.mjs', [inputPath]);

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            const body = JSON.parse(result.stdout);
            assert.equal(body.ok, true);
            assert.equal(body.output.format, 'webp');
            assert.equal(body.output.quality, 100);
            assert.match(body.output.path, /source\.webp$/);
            const output = readFileSync(body.output.path);
            assert.equal(output.toString('ascii', 0, 4), 'RIFF');
            assert.equal(output.toString('ascii', 8, 12), 'WEBP');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects invalid conversion quality before writing output', () => {
        const result = runSkillScript('convert-image-format.mjs', ['--quality', '101', '/tmp/source.png']);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--quality 必须是 1 到 100/);
        assert.equal(result.stdout.trim(), '');
    });

    it('rejects invalid retry attempt env values', () => {
        const result = runSkillScript('generate-image.mjs', ['prompt'], {
            GPT_IMAGE_AGENT_MAX_ATTEMPTS: 'abc'
        });

        assert.equal(result.status, 2);
        assert.match(result.stderr, /GPT_IMAGE_AGENT_MAX_ATTEMPTS 必须是正整数/);
        assert.equal(result.stdout.trim(), '');
    });

    it('loads private agent env files for CLI scripts without overriding shell env', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'agent-env-load-'));
        try {
            mkdirSync(join(tempRoot, '.git'));
            writeFileSync(
                join(tempRoot, '.env.agent.local'),
                [
                    'GPT_IMAGE_PLAYGROUND_URL=https://file-space.example.test',
                    'GPT_IMAGE_AGENT_MAX_ATTEMPTS=2',
                    'GPT_IMAGE_AGENT_TOKEN=file-token',
                    'GPT_IMAGE_APP_PASSWORD_HASH=file-hash',
                    'GPT_IMAGE_UPSTREAM_BASE_URL=https://upstream.example.test/v1',
                    'GPT_IMAGE_UPSTREAM_API_KEY=upstream-secret'
                ].join('\n')
            );

            const loaded = runSkillScript(
                'generate-image.mjs',
                ['prompt'],
                {},
                { cwd: tempRoot, loadPrivateAgentEnv: true }
            );
            assert.equal(loaded.status, 0);
            const loadedBody = JSON.parse(loaded.stdout);
            assert.equal(loadedBody.verification_scope.service_base_url, 'https://file-space.example.test');
            assert.equal(loadedBody.verification_scope.service_base_url_source, 'GPT_IMAGE_PLAYGROUND_URL');
            assert.equal(loadedBody.verification_scope.interactive_confirmation_required, true);
            assert.doesNotMatch(loaded.stdout, /file-token|file-hash|upstream-secret/);
            assert.equal(loaded.stderr.trim(), '');

            const fromNestedCwd = runSkillScript(
                'generate-image.mjs',
                ['prompt'],
                {},
                { cwd: join(tempRoot, 'nested', 'scripts'), loadPrivateAgentEnv: true, createCwd: true }
            );
            assert.equal(fromNestedCwd.status, 0);
            const nestedBody = JSON.parse(fromNestedCwd.stdout);
            assert.equal(nestedBody.verification_scope.service_base_url, 'https://file-space.example.test');

            const parentRoot = mkdtempSync(join(tmpdir(), 'agent-env-parent-'));
            try {
                writeFileSync(
                    join(parentRoot, '.env.agent.local'),
                    'GPT_IMAGE_PLAYGROUND_URL=https://parent-space.example.test'
                );
                const childRoot = join(parentRoot, 'child-repo');
                mkdirSync(join(childRoot, '.git'), { recursive: true });
                const bounded = runSkillScript(
                    'generate-image.mjs',
                    ['prompt'],
                    {},
                    { cwd: join(childRoot, 'nested'), loadPrivateAgentEnv: true, createCwd: true }
                );
                assert.equal(bounded.status, 0);
                const boundedBody = JSON.parse(bounded.stdout);
                assert.equal(boundedBody.verification_scope.service_base_url, 'http://localhost:4783');

                const projectCopyRoot = join(parentRoot, 'project-copy');
                mkdirSync(join(projectCopyRoot, 'skills/visual-journal-image-agent'), { recursive: true });
                mkdirSync(join(projectCopyRoot, 'nested'), { recursive: true });
                writeFileSync(join(projectCopyRoot, 'package.json'), JSON.stringify({ name: 'visual-journal' }));
                writeFileSync(join(projectCopyRoot, 'skills/visual-journal-image-agent/SKILL.md'), '# skill\n');
                const projectBounded = runSkillScript(
                    'generate-image.mjs',
                    ['prompt'],
                    {},
                    { cwd: join(projectCopyRoot, 'nested'), loadPrivateAgentEnv: true }
                );
                assert.equal(projectBounded.status, 0);
                const projectBoundedBody = JSON.parse(projectBounded.stdout);
                assert.equal(projectBoundedBody.verification_scope.service_base_url, 'http://localhost:4783');

                writeFileSync(
                    join(projectCopyRoot, '.env.agent.local'),
                    'GPT_IMAGE_PLAYGROUND_URL=https://project-copy.example.test'
                );
                const projectLoaded = runSkillScript(
                    'generate-image.mjs',
                    ['prompt'],
                    {},
                    { cwd: join(projectCopyRoot, 'nested'), loadPrivateAgentEnv: true }
                );
                assert.equal(projectLoaded.status, 0);
                const projectLoadedBody = JSON.parse(projectLoaded.stdout);
                assert.equal(
                    projectLoadedBody.verification_scope.service_base_url,
                    'https://project-copy.example.test'
                );

                const projectSkillScriptsLoaded = runSkillScript(
                    'generate-image.mjs',
                    ['prompt'],
                    {},
                    {
                        cwd: join(projectCopyRoot, 'skills/visual-journal-image-agent/scripts'),
                        loadPrivateAgentEnv: true,
                        createCwd: true
                    }
                );
                assert.equal(projectSkillScriptsLoaded.status, 0);
                const projectSkillScriptsLoadedBody = JSON.parse(projectSkillScriptsLoaded.stdout);
                assert.equal(
                    projectSkillScriptsLoadedBody.verification_scope.service_base_url,
                    'https://project-copy.example.test'
                );
            } finally {
                rmSync(parentRoot, { recursive: true, force: true });
            }

            const shellWins = runSkillScript(
                'generate-image.mjs',
                ['prompt'],
                { GPT_IMAGE_PLAYGROUND_URL: 'https://shell-space.example.test' },
                { cwd: tempRoot, loadPrivateAgentEnv: true }
            );
            assert.equal(shellWins.status, 0);
            const shellBody = JSON.parse(shellWins.stdout);
            assert.equal(shellBody.verification_scope.service_base_url, 'https://shell-space.example.test');

            const disabled = runSkillScript(
                'generate-image.mjs',
                ['prompt'],
                { GPT_IMAGE_AGENT_LOAD_ENV_FILE: '0' },
                { cwd: tempRoot }
            );
            assert.equal(disabled.status, 0);
            const disabledBody = JSON.parse(disabled.stdout);
            assert.equal(disabledBody.verification_scope.service_base_url, 'http://localhost:4783');

            const probe = runSkillScript(
                'probe-upstream-image.mjs',
                ['--timeout-ms', '1'],
                {},
                { cwd: tempRoot, loadPrivateAgentEnv: true }
            );
            assert.notEqual(probe.status, 2);
            const probeBody = JSON.parse(probe.stdout);
            assert.equal(probeBody.base_url, 'https://upstream.example.test/v1');
            assert.equal(probeBody.api_key_configured, true);
            assert.doesNotMatch(probe.stdout, /upstream-secret/);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('inherits longer image transport timeout from capabilities by default', () => {
        assert.equal(
            readCapabilitiesImageTransportTimeoutMs({ image_transport: { upstream_timeout_ms: 900_000 } }, 420_000),
            900_000
        );
        assert.equal(
            readCapabilitiesImageTransportTimeoutMs({ image_transport: { upstream_timeout_ms: 300_000 } }, 420_000),
            420_000
        );
    });

    it('rejects service base URLs with embedded credentials before dry-run output', () => {
        const result = runSkillScript('generate-image.mjs', ['prompt'], {
            GPT_IMAGE_PLAYGROUND_URL: 'https://user:secret@example.test'
        });

        assert.equal(result.status, 2);
        assert.match(result.stderr, /base URL/);
        assert.match(result.stderr, /不能包含凭据/);
        assert.doesNotMatch(result.stderr, /secret/);
        assert.equal(result.stdout.trim(), '');
    });

    it('lets explicit base-url override the environment service URL in dry-run output', () => {
        const generateResult = runSkillScript(
            'generate-image.mjs',
            ['--base-url', 'https://space.example.test/', '--size', '1024x1024', 'prompt'],
            { GPT_IMAGE_PLAYGROUND_URL: 'http://localhost:4783' }
        );
        assert.equal(generateResult.status, 0);
        const generateBody = JSON.parse(generateResult.stdout);
        assert.equal(generateBody.verification_scope.service_base_url, 'https://space.example.test');
        assert.equal(generateBody.verification_scope.service_base_url_source, 'user_provided');
        assert.equal(generateBody.verification_scope.interactive_confirmation_required, false);

        const editResult = runSkillScript(
            'edit-image.mjs',
            ['--base-url', 'https://space.example.test/', '--image', '/tmp/source.png', 'prompt'],
            { GPT_IMAGE_PLAYGROUND_URL: 'http://localhost:4783' }
        );
        assert.equal(editResult.status, 0);
        const editBody = JSON.parse(editResult.stdout);
        assert.equal(editBody.verification_scope.service_base_url, 'https://space.example.test');
        assert.equal(editBody.verification_scope.service_base_url_source, 'user_provided');

        const tempRoot = mkdtempSync(join(tmpdir(), 'batch-base-url-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'first', prompt: 'prompt' }));
            const batchResult = runSkillScript(
                'batch-images.mjs',
                ['--base-url', 'https://space.example.test/', '--input', inputPath],
                { GPT_IMAGE_PLAYGROUND_URL: 'http://localhost:4783' }
            );
            assert.equal(batchResult.status, 0);
            const batchBody = JSON.parse(batchResult.stdout);
            assert.equal(batchBody.verification_scope.service_base_url, 'https://space.example.test');
            assert.equal(batchBody.verification_scope.service_base_url_source, 'user_provided');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects upstream probe base URLs with embedded credentials before network checks', () => {
        const result = runSkillScript('probe-upstream-image.mjs', [
            '--base-url',
            'https://user:secret@example.test/v1'
        ]);

        assert.equal(result.status, 2);
        assert.match(result.stderr, /base URL/);
        assert.match(result.stderr, /不能包含凭据/);
        assert.doesNotMatch(result.stderr, /secret/);
        assert.equal(result.stdout.trim(), '');
    });

    it('emits a non-billable upstream probe summary with stable request headers', async () => {
        let userAgent = '';
        await withServer(
            (request, response) => {
                userAgent = String(request.headers['user-agent'] || '');
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `${baseUrl}/v1`,
                    '--timeout-ms',
                    localUpstreamProbeTimeoutMs
                ]);

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.ok, true);
                assert.equal(body.billable, false);
                assert.equal(body.models.model_count, 1);
                assert.equal(body.models.first_model_id, 'gpt-image-2');
                assert.equal(body.models.image_count, undefined);
                assert.equal(body.models.first_b64_length, undefined);
                assert.equal(body.summary.ok, true);
                assert.equal(body.summary.billable, false);
                assert.equal(body.summary.transport, 'upstream_probe');
                assert.equal(body.summary.endpoint.endsWith('/v1/models'), true);
                assert.equal(body.summary.request_headers.user_agent_effective, 'visual-journal/probe');
                assert.equal(body.summary.request_headers.has_extra_headers, false);
                assert.deepEqual(body.summary.request_headers.allowed_header_names, ['authorization', 'user-agent']);
                assert.deepEqual(body.summary.request_headers.configured_header_names, []);
                assert.equal(userAgent, 'visual-journal/probe');
            }
        );
    });

    it('uses the configured default model for upstream probes and local planning', async () => {
        let imageRequestModel = '';
        await withServer(
            async (request, response) => {
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'custom-image-model' }] }));
                    return;
                }
                if (request.url === '/v1/images/generations') {
                    const body = JSON.parse(await readRequestText(request));
                    imageRequestModel = body.model;
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ b64_json: 'YmFzZTY0LWltYWdl' }] }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const probe = await runSkillScriptAsync(
                    'probe-upstream-image.mjs',
                    [
                        '--base-url',
                        `${baseUrl}/v1`,
                        '--allow-billable',
                        '--request-mode',
                        'images-non-stream',
                        '--timeout-ms',
                        localUpstreamProbeTimeoutMs
                    ],
                    { GPT_IMAGE_UPSTREAM_API_KEY: 'probe-secret', OPENAI_IMAGE_MODEL: 'custom-image-model' }
                );
                assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
                assert.equal(JSON.parse(probe.stdout).request_modes.passed[0], 'images-non-stream');

                const generate = runSkillScript('generate-image.mjs', ['--base-url', `${baseUrl}/v1`, 'prompt'], {
                    OPENAI_IMAGE_MODEL: 'custom-image-model'
                });
                assert.equal(generate.status, 0, generate.stderr);
                assert.equal(JSON.parse(generate.stdout).request.model, 'custom-image-model');
                assert.equal(imageRequestModel, 'custom-image-model');
            }
        );
    });

    it('uses an explicit connection IP without changing the upstream hostname', async () => {
        let hostHeader = '';
        await withServer(
            (request, response) => {
                hostHeader = String(request.headers.host || '');
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const localUrl = new URL(baseUrl);
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `http://upstream.invalid:${localUrl.port}/v1`,
                    '--connect-ip',
                    '127.0.0.1',
                    '--timeout-ms',
                    localUpstreamProbeTimeoutMs
                ]);

                assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.connect_ip, '127.0.0.1');
                assert.equal(body.summary.connect_ip, '127.0.0.1');
                assert.equal(body.dns.reason, 'connect_ip_override');
                assert.equal(body.dns.address, '127.0.0.1');
                assert.equal(body.tls.reason, 'non_https_base_url');
                assert.equal(body.models.first_model_id, 'gpt-image-2');
                assert.equal(hostHeader, `upstream.invalid:${localUrl.port}`);
            }
        );
    });

    it('reports configured upstream probe authorization without exposing the key', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.headers.authorization, 'Bearer probe-secret');
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'probe-upstream-image.mjs',
                    ['--base-url', `${baseUrl}/v1`, '--timeout-ms', localUpstreamProbeTimeoutMs],
                    { GPT_IMAGE_UPSTREAM_API_KEY: 'probe-secret', OPENAI_UPSTREAM_USER_AGENT: 'custom-probe' }
                );

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.summary.request_headers.user_agent_effective, 'custom-probe');
                assert.equal(body.summary.request_headers.has_extra_headers, true);
                assert.deepEqual(body.summary.request_headers.configured_header_names, ['authorization', 'user-agent']);
                assert.equal(JSON.stringify(body).includes('probe-secret'), false);
            }
        );
    });

    it('redacts an API key echoed in an upstream probe error body', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.headers.authorization, 'Bearer echoed-probe-secret');
                response.writeHead(401, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        error: { message: 'invalid credential echoed-probe-secret' }
                    })
                );
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'probe-upstream-image.mjs',
                    ['--base-url', `${baseUrl}/v1`, '--timeout-ms', localUpstreamProbeTimeoutMs],
                    { GPT_IMAGE_UPSTREAM_API_KEY: 'echoed-probe-secret' }
                );

                assert.equal(result.status, 1);
                assert.doesNotMatch(result.stdout, /echoed-probe-secret/);
                assert.doesNotMatch(result.stderr, /echoed-probe-secret/);
            }
        );
    });

    it('redacts short API keys from structured upstream probe errors', async () => {
        await withServer(
            (request, response) => {
                assert.equal(request.headers.authorization, 'Bearer k');
                response.writeHead(401, { 'content-type': 'application/json' });
                response.end(
                    JSON.stringify({
                        error: {
                            code: 'credential-k-invalid',
                            type: 'upstream-k-error',
                            message: 'key k rejected'
                        }
                    })
                );
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'probe-upstream-image.mjs',
                    ['--base-url', `${baseUrl}/v1`, '--timeout-ms', localUpstreamProbeTimeoutMs],
                    { GPT_IMAGE_UPSTREAM_API_KEY: 'k' }
                );

                assert.equal(result.status, 1);
                assert.doesNotMatch(result.stdout, /credential-k-invalid/);
                assert.doesNotMatch(result.stdout, /upstream-k-error/);
                assert.doesNotMatch(result.stdout, /key k rejected/);
                assert.match(result.stdout, /\[redacted\]/);
                assert.doesNotMatch(result.stderr, /credential-k-invalid|upstream-k-error|key k rejected/);
            }
        );
    });

    it('probes explicit request modes and classifies Responses 403 as unavailable', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push(`${request.method} ${request.url}`);
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                if (request.url === '/v1/images/generations') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ b64_json: 'YmFzZTY0LWltYWdl' }] }));
                    return;
                }
                if (request.url === '/v1/responses') {
                    response.writeHead(403, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'permission_denied',
                                message: 'Image generation is not enabled for this group',
                                type: 'invalid_request_error'
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `${baseUrl}/v1`,
                    '--allow-billable',
                    '--request-mode',
                    'images-non-stream,responses-non-stream',
                    '--responses-model',
                    'gpt-4.1-mini',
                    '--timeout-ms',
                    '1000'
                ]);

                assert.equal(result.status, 1);
                const body = JSON.parse(result.stdout);
                assert.equal(body.ok, false);
                assert.equal(body.billable, true);
                assert.deepEqual(body.request_modes.requested, ['images-non-stream', 'responses-non-stream']);
                assert.deepEqual(body.request_modes.passed, ['images-non-stream']);
                assert.deepEqual(body.request_modes.failed, ['responses-non-stream']);
                assert.deepEqual(body.request_modes.skipped, []);
                assert.deepEqual(body.request_modes.not_selected, ['images-sse', 'responses-sse']);
                assert.equal(body.request_modes.suggested_channel_config, 'images-non-stream');
                assert.equal(body.request_modes.suggested_env_key, 'OPENAI_CHANNEL_N_REQUEST_MODES');
                assert.equal(body.request_modes.modes['images-non-stream'].ok, true);
                assert.equal(body.request_modes.modes['responses-non-stream'].ok, false);
                assert.equal(body.request_modes.modes['responses-non-stream'].category, 'responses_disabled');
                assert.match(body.request_modes.modes['responses-non-stream'].error, /Image generation is not enabled/);
                assert.equal(body.request_modes.modes['responses-non-stream'].responses_model, 'gpt-4.1-mini');
                assert.deepEqual(requests, ['GET /v1/models', 'POST /v1/images/generations', 'POST /v1/responses']);
            }
        );
    });

    it('does not suggest remote URL-only Responses results as usable request modes', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push(`${request.method} ${request.url}`);
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                if (request.url === '/v1/responses') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            output: [
                                {
                                    type: 'image_generation_call',
                                    status: 'completed',
                                    url: 'https://cdn.example.test/final.png'
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `${baseUrl}/v1`,
                    '--allow-billable',
                    '--request-mode',
                    'responses-non-stream',
                    '--responses-model',
                    'gpt-4.1-mini',
                    '--timeout-ms',
                    '1000'
                ]);

                assert.equal(result.status, 1);
                const body = JSON.parse(result.stdout);
                const mode = body.request_modes.modes['responses-non-stream'];
                assert.deepEqual(body.request_modes.passed, []);
                assert.deepEqual(body.request_modes.failed, ['responses-non-stream']);
                assert.equal(body.request_modes.suggested_channel_config, '');
                assert.equal(mode.ok, false);
                assert.equal(mode.error, 'url_only_result');
                assert.equal(mode.has_url_result, true);
                assert.equal(mode.has_remote_url_result, true);
                assert.equal(mode.has_consumable_image, false);
                assert.deepEqual(requests, ['GET /v1/models', 'POST /v1/responses']);
            }
        );
    });

    it('treats data URL image results as consumable in upstream probe output', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                if (request.url === '/v1/responses') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            output: [
                                {
                                    type: 'image_generation_call',
                                    status: 'completed',
                                    url: 'data:image/png;base64,YmFzZTY0LWltYWdl'
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `${baseUrl}/v1`,
                    '--allow-billable',
                    '--request-mode',
                    'responses-non-stream',
                    '--responses-model',
                    'gpt-4.1-mini',
                    '--timeout-ms',
                    '1000'
                ]);

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                const mode = body.request_modes.modes['responses-non-stream'];
                assert.deepEqual(body.request_modes.passed, ['responses-non-stream']);
                assert.equal(body.request_modes.suggested_channel_config, 'responses-non-stream');
                assert.equal(mode.ok, true);
                assert.equal(mode.has_inline_base64, true);
                assert.equal(mode.has_consumable_image, true);
                assert.equal(mode.has_remote_url_result, false);
            }
        );
    });

    it('does not mark pending Responses image calls as a usable request mode', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/v1/models') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                    return;
                }
                if (request.url === '/v1/responses') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            output: [
                                {
                                    type: 'image_generation_call',
                                    status: 'pending',
                                    result: FIXTURE_IMAGE_BASE64
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                    '--base-url',
                    `${baseUrl}/v1`,
                    '--allow-billable',
                    '--request-mode',
                    'responses-non-stream',
                    '--responses-model',
                    'gpt-4.1-mini',
                    '--timeout-ms',
                    '1000'
                ]);

                assert.equal(result.status, 1);
                const body = JSON.parse(result.stdout);
                const mode = body.request_modes.modes['responses-non-stream'];
                assert.deepEqual(body.request_modes.passed, []);
                assert.deepEqual(body.request_modes.failed, ['responses-non-stream']);
                assert.equal(mode.ok, false);
                assert.equal(mode.error, 'missing_image_call_result');
                assert.equal(mode.has_consumable_image, false);
            }
        );
    });

    it('saves the first final upstream SSE image only when explicitly requested', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'probe-upstream-save-'));
        const outputPath = join(tempRoot, 'probe.png');
        const laterImageBase64 = fakePngBase64(2, 1);
        try {
            await withServer(
                (request, response) => {
                    if (request.url === '/v1/models') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                        return;
                    }
                    if (request.url === '/v1/images/generations') {
                        response.writeHead(200, {
                            'content-type': 'text/event-stream',
                            'cache-control': 'no-cache',
                            connection: 'keep-alive'
                        });
                        response.write(
                            'event: image_generation.partial_image\n' +
                                'data: {"type":"image_generation.partial_image","b64_json":"YmFzZTY0LWltYWdl"}\n\n'
                        );
                        response.write(
                            'event: image_generation.completed\n' +
                                `data: {"type":"image_generation.completed","b64_json":"${FIXTURE_IMAGE_BASE64}"}\n\n`
                        );
                        response.write(
                            'event: image_generation.completed\n' +
                                `data: {"type":"image_generation.completed","b64_json":"${laterImageBase64}"}\n\n`
                        );
                        response.end('data: [DONE]\n\n');
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                        '--base-url',
                        baseUrl + '/v1',
                        '--allow-billable',
                        '--request-mode',
                        'images-sse',
                        '--save-first-image',
                        outputPath,
                        '--timeout-ms',
                        '1000'
                    ]);

                    assert.equal(result.status, 0);
                    const body = JSON.parse(result.stdout);
                    const mode = body.request_modes.modes['images-sse'];
                    assert.equal(mode.saved_image.ok, true);
                    assert.equal(mode.saved_image.path, outputPath);
                    assert.equal(mode.saved_image.byte_length, Buffer.from(FIXTURE_IMAGE_BASE64, 'base64').byteLength);
                    assert.deepEqual(mode.saved_image.dimensions, { width: 1, height: 1 });
                    assert.equal(mode.saved_image.source, 'b64_json');
                    assert.equal(readFileSync(outputPath).toString('base64'), FIXTURE_IMAGE_BASE64);
                    assert.equal(result.stdout.includes(FIXTURE_IMAGE_BASE64), false);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not save partial-only upstream SSE previews as final images', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'probe-upstream-partial-only-'));
        const outputPath = join(tempRoot, 'probe.png');
        try {
            await withServer(
                (request, response) => {
                    if (request.url === '/v1/models') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
                        return;
                    }
                    if (request.url === '/v1/images/generations') {
                        response.writeHead(200, {
                            'content-type': 'text/event-stream',
                            'cache-control': 'no-cache',
                            connection: 'keep-alive'
                        });
                        response.write(
                            'event: image_generation.partial_image\n' +
                                `data: {"type":"image_generation.partial_image","b64_json":"${FIXTURE_IMAGE_BASE64}"}\n\n`
                        );
                        response.end('data: [DONE]\n\n');
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync('probe-upstream-image.mjs', [
                        '--base-url',
                        `${baseUrl}/v1`,
                        '--allow-billable',
                        '--request-mode',
                        'images-sse',
                        '--save-first-image',
                        outputPath,
                        '--timeout-ms',
                        '1000'
                    ]);

                    assert.equal(result.status, 1);
                    const body = JSON.parse(result.stdout);
                    const mode = body.request_modes.modes['images-sse'];
                    assert.equal(mode.ok, false);
                    assert.equal(mode.error, 'missing_final_image');
                    assert.equal(mode.has_partial_image, true);
                    assert.equal(mode.saved_image, undefined);
                    assert.equal(existsSync(outputPath), false);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not read prompt files during default generate dry-run', () => {
        const result = runSkillScript('generate-image.mjs', ['--prompt-file', '/tmp/missing-agent-prompt.txt']);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.dry_run, true);
        assert.equal(body.billable, false);
        assert.equal(body.verification_scope.mode, 'local_planning_only');
        assert.equal(body.verification_scope.remote_capabilities_verified, false);
        assert.equal(body.verification_scope.runtime_capacity_verified, false);
        assert.equal(body.verification_scope.auth_verified, false);
        assert.equal(body.request.output_format, 'webp');
        assert.equal(body.request.output_compression, 100);
        assert.equal(result.stderr.trim(), '');
    });

    it('includes explicit upstream streaming options in generate dry-run requests', () => {
        const result = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'responses',
            '--stream-mode',
            'stream',
            '--streaming-strategy',
            'responses-sse',
            '--partial-images',
            '3',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.request.image_backend, 'responses');
        assert.equal(body.request.stream_mode, 'stream');
        assert.equal(body.request.streaming_strategy, 'responses-sse');
        assert.equal(body.request.partial_images, 3);
        assert.equal(result.stderr.trim(), '');
    });

    it('keeps GPT2Image-compatible generate options on server orchestration dry-runs', () => {
        const result = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'responses',
            '--responses-model',
            'gpt-5.4-mini',
            '--thinking',
            'medium',
            '--prompt-optimization',
            'false',
            '--force-web',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.endpoint, 'http://localhost:4783/api/agent/image-requests');
        assert.equal(body.routing_guidance.transport, 'server_orchestrated');
        assert.equal(body.request.image_backend, 'responses');
        assert.equal(body.request.responsesModel, 'gpt-5.4-mini');
        assert.equal(body.request.thinking, 'medium');
        assert.equal(body.request.promptOptimization, false);
        assert.equal(body.request.force_web, true);
        assert.equal(result.stderr.trim(), '');
    });

    it('includes explicit upstream streaming options in edit dry-run requests', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--stream-mode',
            'auto',
            '--streaming-strategy',
            'force-sse',
            '--partial-images',
            '2',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.request.stream_mode, 'auto');
        assert.equal(body.request.streaming_strategy, 'force-sse');
        assert.equal(body.request.partial_images, 2);
        assert.equal(body.verification_scope.mode, 'local_planning_only');
        assert.equal(body.verification_scope.remote_capabilities_verified, false);
        assert.equal(body.verification_scope.runtime_capacity_verified, false);
        assert.equal(body.verification_scope.auth_verified, false);
        assert.equal(result.stderr.trim(), '');
    });

    it('prints server orchestration guidance for high-resolution generate dry-runs', () => {
        const result = runSkillScript('generate-image.mjs', ['--size', '3072x2048', '--quality', 'high', 'prompt']);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.endpoint, 'http://localhost:4783/api/agent/image-requests');
        assert.equal(body.routing_guidance.recommended_endpoint, '/api/agent/image-requests');
        assert.equal(body.routing_guidance.transport, 'server_orchestrated');
        assert.equal(body.routing_guidance.result_mode, 'job_polling');
        assert.match(body.routing_guidance.reason, /服务端负责选择内部执行路径/);
        assert.equal(result.stderr.trim(), '');
    });

    it('rejects single generate dimension-check without a fixed requested size before remote execution', () => {
        const result = runSkillScript('generate-image.mjs', ['--dimension-check', '--size', 'auto', 'prompt']);

        assert.equal(result.status, 2);
        assert.equal(result.stdout.trim(), '');
        assert.match(result.stderr, /--dimension-check 需要 --size 为 WIDTHxHEIGHT/);
    });

    it('explains explicit page SSE dry-runs without blaming high-resolution routing', () => {
        const result = runSkillScript('generate-image.mjs', ['--page-sse', '--size', '1024x1024', 'prompt']);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.endpoint, 'http://localhost:4783/api/images');
        assert.equal(body.routing_guidance.transport, 'page_sse');
        assert.match(body.routing_guidance.reason, /Explicit --page-sse/);
        assert.doesNotMatch(body.routing_guidance.reason, /max_edge>2048/);
        assert.equal(result.stderr.trim(), '');
    });

    it('prints server orchestration guidance for remote HTTPS small generate dry-runs', () => {
        const result = runSkillScript('generate-image.mjs', ['--base-url', 'https://space.example.test', 'prompt']);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.endpoint, 'https://space.example.test/api/agent/image-requests');
        assert.equal(body.routing_guidance.recommended_endpoint, '/api/agent/image-requests');
        assert.equal(body.routing_guidance.transport, 'server_orchestrated');
        assert.equal(body.routing_guidance.strength, 'recommended');
        assert.match(body.routing_guidance.reason, /只提交生成意图/);
        assert.equal(result.stderr.trim(), '');
    });

    it('can combine generate dry-run planning with non-billable remote checks', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify(
                            agentGenerateCapabilities({
                                supported: {
                                    request_modes: ['images-non-stream', 'images-sse']
                                },
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                },
                                defaults: {
                                    partial_images: 2,
                                    model: 'gpt-image-2-1k'
                                }
                            })
                        )
                    );
                    return;
                }
                if (request.url === '/api/runtime-capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            streamingBatch: { enabled: true, recommendedConcurrency: 2 },
                            channelRouting: { effectiveRequestModes: ['images-non-stream'] }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--check-remote', '--size', '1536x2288', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.verification_scope.mode, 'remote_contract_and_local_planning');
                assert.equal(body.verification_scope.remote_capabilities_verified, true);
                assert.equal(body.verification_scope.runtime_capacity_verified, true);
                assert.equal(body.verification_scope.auth_verified, true);
                assert.equal(body.verification_scope.billable_request_sent, false);
                assert.equal(body.request.model, 'gpt-image-2-1k');
                assert.equal(body.request.size, '1536x2288');
                assert.equal(body.verification_scope.remote_check.default_model, 'gpt-image-2-1k');
                assert.equal(body.verification_scope.remote_check.capabilities.default_model, 'gpt-image-2-1k');
                assert.deepEqual(body.verification_scope.remote_check.capabilities.request_modes, [
                    'images-non-stream',
                    'images-sse'
                ]);
                assert.deepEqual(body.verification_scope.remote_check.runtime.effective_request_modes, [
                    'images-non-stream'
                ]);
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'GET /api/runtime-capabilities']
                );
            }
        );
    });

    it('keeps default generate on server orchestration when request modes are declared', async () => {
        const requests = [];
        let imageRequestBody = '';
        await withServer(
            async (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify(
                            agentGenerateCapabilities({
                                supported: {
                                    request_modes: [
                                        'images-non-stream',
                                        'images-sse',
                                        'responses-non-stream',
                                        'responses-sse'
                                    ]
                                },
                                upstream_request_headers: {
                                    channels: [
                                        {
                                            id: 'images',
                                            request_modes: ['images-non-stream', 'images-sse']
                                        },
                                        {
                                            id: 'responses',
                                            request_modes: ['responses-sse']
                                        }
                                    ]
                                }
                            })
                        )
                    );
                    return;
                }
                if (request.url === '/api/agent/image-requests') {
                    imageRequestBody = await readRequestText(request);
                    response.writeHead(202, { 'content-type': 'application/json', 'retry-after': '1' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-orchestrated-1',
                                state: 'running',
                                result_url: '/api/agent/jobs/job-orchestrated-1/result',
                                retry_after_seconds: 1
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-orchestrated-1/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'job-orchestrated-1',
                            idempotency_key: 'orchestrated-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-orchestrated-1',
                                    filename: 'orchestrated.webp',
                                    content_url: '/api/agent/artifacts/artifact-orchestrated-1/content',
                                    width: 1254,
                                    height: 1254
                                }
                            ],
                            execution: {
                                transport: 'agent_job_polling',
                                endpoint: '/api/agent/image-requests',
                                route_mode: 'job',
                                image_backend: 'images-api',
                                stream_mode: 'non_stream',
                                streaming_strategy: 'off',
                                channel_request_mode: 'images-non-stream',
                                channel_request_mode_fallback_applied: false,
                                route_decision: {
                                    requested_backend: 'images-api',
                                    preferred_channel_request_mode: 'images-non-stream',
                                    selected_channel_request_mode: 'images-non-stream',
                                    fallback_applied: false,
                                    selected_channel_id: 'channel-orchestrated',
                                    upstream_host: 'upstream.example.test'
                                }
                            },
                            timing: { server_elapsed_ms: 1234 }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate' || request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected client-selected route' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--idempotency-key',
                        'orchestrated-key',
                        '--size',
                        '3072x2048',
                        '--streaming-strategy',
                        'off',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        '--thinking',
                        'medium',
                        '--prompt-optimization',
                        'false',
                        '--force-web',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.deepEqual(body.routing, {
                    transport: 'server_orchestrated',
                    endpoint: '/api/agent/image-requests'
                });
                assert.equal(body.summary.transport, 'agent_job_polling');
                assert.equal(body.summary.endpoint, '/api/agent/image-requests');
                assert.equal(body.summary.route_mode, 'job');
                assert.equal(body.summary.channel_request_mode, 'images-non-stream');
                assert.equal(body.summary.channel_request_mode_fallback_applied, false);
                assert.deepEqual(body.summary.route_decision, {
                    requested_backend: 'images-api',
                    preferred_channel_request_mode: 'images-non-stream',
                    selected_channel_request_mode: 'images-non-stream',
                    fallback_applied: false,
                    selected_channel_id: 'channel-orchestrated',
                    upstream_host: 'upstream.example.test'
                });
                assert.deepEqual(body.summary.content_urls, ['/api/agent/artifacts/artifact-orchestrated-1/content']);
                assert.deepEqual(body.summary.actual_dimensions, { width: 1254, height: 1254 });
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/image-requests',
                        'GET /api/agent/jobs/job-orchestrated-1/result'
                    ]
                );
                const requestBody = JSON.parse(imageRequestBody);
                assert.equal(requestBody.size, '3072x2048');
                assert.equal(requestBody.streaming_strategy, 'off');
                assert.equal(requestBody.image_backend, 'responses');
                assert.equal(requestBody.responsesModel, 'gpt-5.4-mini');
                assert.equal(requestBody.thinking, 'medium');
                assert.equal(requestBody.promptOptimization, false);
                assert.equal(requestBody.force_web, true);
            }
        );
    });

    it('checks the server orchestration endpoint during generate contract checks', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify(
                            agentGenerateCapabilities({
                                agent_streaming: {
                                    page_sse: {
                                        supported: true,
                                        endpoint: '/api/images',
                                        client_request_id: { max_length: 128 }
                                    }
                                }
                            })
                        )
                    );
                    return;
                }
                if (
                    request.url === '/api/agent/images/generate' ||
                    request.url === '/api/agent/image-requests' ||
                    request.url === '/api/agent/jobs/images/generate'
                ) {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'clientRequestId 长度不能超过 128 个字符。' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('generate-image.mjs', ['--contract-check', 'contract check'], {
                    GPT_IMAGE_PLAYGROUND_URL: baseUrl
                });

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.deepEqual(
                    body.checks.map((check) => check.endpoint),
                    [
                        '/api/agent/images/generate',
                        '/api/agent/image-requests',
                        '/api/agent/jobs/images/generate',
                        '/api/images'
                    ]
                );
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/images/generate',
                        'POST /api/agent/image-requests',
                        'POST /api/agent/jobs/images/generate',
                        'POST /api/images'
                    ]
                );
            }
        );
    });

    it('fails generate contract checks when the default orchestration contract is missing', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities({ orchestration: undefined })));
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: {
                                code: 'idempotency_key_required',
                                message: 'missing key',
                                retryable: false
                            }
                        })
                    );
                    return;
                }
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unexpected contract probe' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('generate-image.mjs', ['--contract-check', 'contract check'], {
                    GPT_IMAGE_PLAYGROUND_URL: baseUrl
                });

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'orchestration_required');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/agent/images/generate']
                );
            }
        );
    });

    it('expands generate presets into concrete dry-run request fields', () => {
        const agentResult = runSkillScript('generate-image.mjs', ['--preset', '4k-agent-nonstream', 'prompt']);
        assert.equal(agentResult.status, 0);
        const agentBody = JSON.parse(agentResult.stdout);
        assert.equal(agentBody.endpoint, 'http://localhost:4783/api/agent/images/generate');
        assert.equal(agentBody.request.size, '3840x2160');
        assert.equal(agentBody.request.quality, 'high');
        assert.equal(agentBody.request.stream_mode, 'non_stream');
        assert.equal(agentBody.routing_guidance.transport, 'agent_json');

        const upstreamSseResult = runSkillScript('generate-image.mjs', [
            '--preset',
            '4k-upstream-sse-newapi',
            'prompt'
        ]);
        assert.equal(upstreamSseResult.status, 0);
        const upstreamSseBody = JSON.parse(upstreamSseResult.stdout);
        assert.equal(upstreamSseBody.request.size, '3840x2160');
        assert.equal(upstreamSseBody.request.stream_mode, 'stream');
        assert.equal(upstreamSseBody.request.streaming_strategy, 'newapi-keepalive-sse');
        assert.equal(upstreamSseBody.request.partial_images, 2);
    });

    it('does not automatically fall back after an explicit billable page SSE generate failure', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end('data: {"type":"error","error":"stream failed","status":502}\n\n');
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected fallback' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.match(body.error.message, /stream failed/);
                assert.match(body.next_step, /新的 Idempotency-Key/);
                assert.match(body.next_step, /服务端编排入口/);
                assert.equal(body.routing.fallback_endpoint, '/api/agent/image-requests');
                assert.equal(body.routing.fallback_mode, 'manual_after_diagnosis');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/images']
                );
            }
        );
    });

    it('reports non-SSE page validation failures as non-billable', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(400, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'quality 对 gpt-image-2 无效。' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'invalid-quality', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.billable, false);
                assert.equal(body.error.code, 'page_sse_request_rejected');
                assert.equal(body.error.status, 400);
                assert.match(body.error.message, /quality/);
                assert.equal(body.routing.fallback_mode, 'fix_request_before_retry');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/images']
                );
            }
        );
    });

    it('reports non-JSON page 4xx failures as non-billable request rejections', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(401, { 'content-type': 'text/plain' });
                    response.end('missing passwordHash');
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.billable, false);
                assert.equal(body.error.code, 'page_sse_request_rejected');
                assert.equal(body.error.status, 401);
                assert.match(body.error.message, /missing passwordHash/);
                assert.equal(body.routing.fallback_mode, 'fix_request_before_retry');
            }
        );
    });

    it('reports non-SSE page server failures as billable page SSE failures', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: { message: 'upstream page failed' } }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.billable, true);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.equal(body.error.status, 500);
                assert.match(body.error.message, /upstream page failed/);
                assert.equal(body.routing.fallback_mode, 'manual_after_diagnosis');
            }
        );
    });

    it('preserves object page SSE error messages', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"error","error":{"message":"bad request from page","code":"validation_error","status":400}}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.equal(body.billable, true);
                assert.equal(body.error.status, 400);
                assert.match(body.error.message, /bad request from page/);
                assert.doesNotMatch(body.error.message, /\[object Object\]/);
            }
        );
    });

    it('fails large generate auto routing when page SSE capability is unavailable', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({ agent_streaming: {}, agent_jobs: { supported: true, mode: 'job_polling' } })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected fallback' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_unavailable');
                assert.equal(body.routing.fallback_mode, 'manual_after_diagnosis');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities']
                );
            }
        );
    });

    it('fails page SSE output when the stream ends before the done event', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image.png","b64_json":"final-base64","path":"/api/image/image.png","output_format":"png"}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.match(body.error.message, /缺少最终 done 事件/);
                assert.equal(body.error.diagnostics.partial_image_count, 0);
                assert.equal(body.error.diagnostics.completed_event_count, 1);
                assert.equal(body.error.diagnostics.done_received, false);
                assert.equal(body.error.diagnostics.final_image_count, 1);
                assert.equal(body.error.diagnostics.last_upstream_event_type, 'completed');
            }
        );
    });

    it('reports page SSE partial image diagnostics when no final image arrives', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({ agent_streaming: { page_sse: { supported: true, endpoint: '/api/images' } } })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"image_generation.partial_image","partial_image_b64":"partial-a"}',
                            '',
                            'data: {"type":"done","images":[]}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '1024x1024', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.match(body.error.message, /未返回最终图片/);
                assert.equal(body.error.diagnostics.partial_image_count, 1);
                assert.equal(body.error.diagnostics.completed_event_count, 0);
                assert.equal(body.error.diagnostics.done_received, true);
                assert.equal(body.error.diagnostics.final_image_count, 0);
                assert.equal(body.error.diagnostics.last_upstream_event_type, 'done');
            }
        );
    });

    it('saves raw page SSE events when a generate log path is configured', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-sse-log-'));
        try {
            const logPath = join(tempRoot, 'events.jsonl');
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'event: image_generation.partial_image',
                                'data: {"type":"image_generation.partial_image","partial_image_b64":"abc"}',
                                '',
                                'data: {"type":"completed","filename":"image.png","path":"/generated/image.png"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"image.png","path":"/generated/image.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'generate-image.mjs',
                        ['--allow-billable', '--page-sse', '--sse-log', logPath, '--size', '1024x1024', 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const logLines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(logLines.length, 5);
                    assert.equal(logLines[0].event, 'request_started');
                    assert.equal(logLines[0].client_request_id.startsWith('agent-generate-'), true);
                    assert.match(logLines[1].raw_event, /partial_image/);
                    assert.match(logLines[3].raw_event, /"type":"done"/);
                    assert.equal(logLines[4].event, 'request_completed');
                    assert.equal(typeof logLines[4].elapsed_ms, 'number');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps generate page SSE successful when the optional raw log path is unwritable', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-sse-log-unwritable-'));
        try {
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"image.png","path":"/generated/image.png"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"image.png","path":"/generated/image.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'generate-image.mjs',
                        ['--allow-billable', '--page-sse', '--sse-log', tempRoot, '--size', '1024x1024', 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.match(result.stderr, /SSE log write failed/);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.images.length, 1);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('requires page access hash before calling page SSE when capabilities declare page auth', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: {
                                        required: true,
                                        schemes: ['form-password-hash'],
                                        form_field: 'passwordHash'
                                    }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected page call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_auth_required');
                assert.match(body.error.message, /GPT_IMAGE_APP_PASSWORD_HASH/);
                assert.match(body.error.message, /\.env\.agent\.local/);
                assert.match(body.error.message, /GPT_IMAGE_AGENT_TOKEN/);
                assert.equal(body.summary.ok, false);
                assert.equal(body.summary.billable, false);
                assert.equal(body.summary.request_id, null);
                assert.equal(body.summary.idempotency_key.startsWith('agent-generate-'), true);
                assert.deepEqual(body.summary.artifact_ids, []);
                assert.deepEqual(body.summary.content_urls, []);
                assert.deepEqual(body.summary.absolute_content_urls, []);
                assert.equal(body.summary.route_mode, 'page_sse');
                assert.equal(body.summary.image_backend, null);
                assert.equal(body.summary.stream_mode, null);
                assert.equal(body.summary.streaming_strategy, null);
                assert.equal(body.summary.selected_channel_id, null);
                assert.equal(body.summary.upstream_host, null);
                assert.equal(body.summary.transport_error_kind, null);
                assert.equal(body.summary.retry_after_ms, null);
                assert.equal(body.summary.retry_after_seconds, null);
                assert.equal(body.summary.cooldown_until, null);
                assert.equal(body.summary.cooldown_target, null);
                assert.equal(body.summary.elapsed_source, 'client_script');
                assert.equal(typeof body.summary.elapsed_breakdown.client_script_ms, 'number');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities']
                );
            }
        );
    });

    it('rejects overlong page SSE client request ids before sending the stream request', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected page call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    {
                        GPT_IMAGE_PLAYGROUND_URL: baseUrl,
                        GPT_IMAGE_AGENT_IDEMPOTENCY_KEY: 'x'.repeat(129)
                    }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_client_request_id_too_long');
                assert.match(body.error.message, /不能超过 128 个字符/);
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities']
                );
            }
        );
    });

    it('enriches failed Agent generate summaries with Agent state diagnostics', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: { code: 'unexpected_error', message: 'fetch failed', retryable: false }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests?idempotency_key=diag-generate-key') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            found: true,
                            diagnostics: {
                                request: {
                                    request_id: 'req_generate_diag',
                                    idempotency_key: 'diag-generate-key',
                                    status: 'failed'
                                },
                                error: {
                                    code: 'unexpected_error',
                                    retryable: false,
                                    diagnostics: {
                                        channel_request_mode: 'images-non-stream',
                                        channel_request_mode_fallback_applied: true,
                                        route_decision: {
                                            requested_backend: 'images-api',
                                            preferred_channel_request_mode: 'images-sse',
                                            fallback_channel_request_mode: 'images-non-stream',
                                            selected_channel_request_mode: 'images-non-stream',
                                            fallback_applied: true,
                                            selected_channel_id: 'channel-a',
                                            upstream_host: 'upstream.example.test'
                                        },
                                        selected_channel_id: 'channel-a',
                                        upstream_host: 'upstream.example.test',
                                        transport_error_kind: 'aborted',
                                        retry_after_ms: 30000,
                                        cooldown_until: '2026-06-11T12:00:00.000Z',
                                        cooldown_target: {
                                            channel_id: 'channel-a',
                                            request_mode: 'images-non-stream'
                                        }
                                    }
                                }
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--idempotency-key',
                        'diag-generate-key',
                        '--size',
                        '1024x1024',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.summary.request_id, 'req_generate_diag');
                assert.equal(body.summary.channel_request_mode, 'images-non-stream');
                assert.equal(body.summary.channel_request_mode_fallback_applied, true);
                assert.deepEqual(body.summary.route_decision, {
                    requested_backend: 'images-api',
                    preferred_channel_request_mode: 'images-sse',
                    fallback_channel_request_mode: 'images-non-stream',
                    selected_channel_request_mode: 'images-non-stream',
                    fallback_applied: true,
                    selected_channel_id: 'channel-a',
                    upstream_host: 'upstream.example.test'
                });
                assert.equal(body.summary.selected_channel_id, 'channel-a');
                assert.equal(body.summary.upstream_host, 'upstream.example.test');
                assert.equal(body.summary.transport_error_kind, 'aborted');
                assert.equal(body.summary.retry_after_ms, 30000);
                assert.equal(body.summary.cooldown_until, '2026-06-11T12:00:00.000Z');
                assert.deepEqual(body.summary.cooldown_target, {
                    channel_id: 'channel-a',
                    request_mode: 'images-non-stream'
                });
                assert.equal(body.summary.agent_diagnostics_checked, true);
                assert.equal(body.summary.agent_diagnostics_found, true);
                assert.equal(body.agent_failure_diagnostics.request_id, 'req_generate_diag');
                assert.equal(body.agent_failure_diagnostics.status, 'failed');
                assert.deepEqual(body.agent_failure_diagnostics.cooldown_target, {
                    channel_id: 'channel-a',
                    request_mode: 'images-non-stream'
                });
                assert.deepEqual(body.agent_failure_diagnostics.route_decision, {
                    requested_backend: 'images-api',
                    preferred_channel_request_mode: 'images-sse',
                    fallback_channel_request_mode: 'images-non-stream',
                    selected_channel_request_mode: 'images-non-stream',
                    fallback_applied: true,
                    selected_channel_id: 'channel-a',
                    upstream_host: 'upstream.example.test'
                });
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/images/generate',
                        'GET /api/agent/diagnostics/requests?idempotency_key=diag-generate-key'
                    ]
                );
            }
        );
    });

    it('preserves path prefixes when fetching Agent state diagnostics', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/playground/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (request.url === '/playground/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: { code: 'unexpected_error', message: 'fetch failed', retryable: false }
                        })
                    );
                    return;
                }
                if (request.url === '/playground/api/agent/diagnostics/requests?idempotency_key=path-diag-key') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            found: true,
                            diagnostics: {
                                request: {
                                    request_id: 'req_path_diag',
                                    idempotency_key: 'path-diag-key',
                                    status: 'failed'
                                }
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--idempotency-key',
                        'path-diag-key',
                        '--size',
                        '1024x1024',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: `${baseUrl}/playground` }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.summary.request_id, 'req_path_diag');
                assert.equal(body.summary.agent_diagnostics_checked, true);
                assert.equal(body.summary.agent_diagnostics_found, true);
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /playground/api/agent/capabilities',
                        'POST /playground/api/agent/images/generate',
                        'GET /playground/api/agent/diagnostics/requests?idempotency_key=path-diag-key'
                    ]
                );
            }
        );
    });

    it('replaces stale retry guidance when Agent diagnostics report a terminal failure', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
                    response.end(
                        JSON.stringify({
                            error: { code: 'network_error', message: 'temporary failure', retryable: true }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests?idempotency_key=terminal-diag-key') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            found: true,
                            diagnostics: {
                                request: {
                                    request_id: 'req_terminal_diag',
                                    idempotency_key: 'terminal-diag-key',
                                    status: 'failed'
                                },
                                error: {
                                    code: 'upstream_failed',
                                    retryable: false
                                }
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--idempotency-key',
                        'terminal-diag-key',
                        '--size',
                        '1024x1024',
                        'prompt'
                    ],
                    {
                        GPT_IMAGE_AGENT_MAX_ATTEMPTS: '1',
                        GPT_IMAGE_PLAYGROUND_URL: baseUrl
                    }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.summary.request_id, 'req_terminal_diag');
                assert.equal(body.summary.retryable, false);
                assert.equal(body.summary.next_action, 'diagnose_then_new_idempotency_key');
                assert.equal(body.agent_failure_diagnostics.retryable, false);
            }
        );
    });

    it('does not report diagnostics lookup failures as upstream transport errors', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            error: { code: 'unexpected_error', message: 'fetch failed', retryable: false }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests?idempotency_key=diag-unavailable-key') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'diagnostics unavailable' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--idempotency-key',
                        'diag-unavailable-key',
                        '--size',
                        '1024x1024',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.summary.transport_error_kind, null);
                assert.equal(body.summary.agent_diagnostics_checked, true);
                assert.equal(body.summary.agent_diagnostics_found, false);
                assert.equal(body.summary.agent_diagnostics_unavailable_reason, 'status_500');
                assert.equal(body.agent_failure_diagnostics.unavailable_reason, 'status_500');
            }
        );
    });

    it('uses page SSE client request id max length declared by capabilities', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' },
                                    client_request_id: { max_length: 12 }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected page call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--page-sse',
                        '--size',
                        '3072x2048',
                        '--quality',
                        'high',
                        '--idempotency-key',
                        'too-long-page-key',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_client_request_id_too_long');
                assert.match(body.error.message, /不能超过 12 个字符/);
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities']
                );
            }
        );
    });

    it('checks default path-mode page SSE generate dimensions from raw SSE image bytes before formatting', async () => {
        const finalImageBase64 = fakePngBase64(3072, 2048);
        let imageRouteHits = 0;
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            `data: ${JSON.stringify({
                                type: 'completed',
                                filename: 'image.png',
                                b64_json: finalImageBase64,
                                path: '/api/image/image.png',
                                output_format: 'png'
                            })}`,
                            '',
                            'data: {"type":"done","client_request_id":"page-request-1","images":[{"filename":"image.png"}]}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                if (request.url === '/api/image/image.png') {
                    imageRouteHits += 1;
                    response.writeHead(401, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'cookie required' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--page-sse',
                        '--dimension-check',
                        '--size',
                        '3072x2048',
                        '--quality',
                        'high',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.equal(imageRouteHits, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.images[0].filename, 'image.png');
                assert.equal('b64_json' in body.images[0], false);
                assert.equal(body.images[0].path, '/api/image/image.png');
                assert.equal(body.images[0].absolute_path, `${baseUrl}/api/image/image.png`);
                assert.equal(body.images[0].output_format, 'png');
                assert.equal(body.images[0].clientRequestId, 'page-request-1');
                assert.deepEqual(body.images[0].dimensions, { width: 3072, height: 2048 });
                assert.deepEqual(body.summary.actual_dimensions, { width: 3072, height: 2048 });
            }
        );
    });

    it('passes response mode through to page SSE form-data requests', async () => {
        let pageRequestBody = '';
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    pageRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image.png","b64_json":"final-base64","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"page-request-response-mode"}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--page-sse',
                        '--size',
                        '3072x2048',
                        '--quality',
                        'high',
                        '--response-mode',
                        'base64',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.match(pageRequestBody, /name="response_mode"\r?\n\r?\nbase64/);
            }
        );
    });

    it('omits implicit page streaming controls unless explicitly requested', async () => {
        let pageRequestBody = '';
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    pageRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image.png","b64_json":"final-base64","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"page-request-default-streaming"}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '1024x1024', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.doesNotMatch(pageRequestBody, /name="stream"/);
                assert.doesNotMatch(pageRequestBody, /name="image_streaming_strategy"/);
            }
        );
    });

    it('enforces timeout while waiting for page SSE body events', async () => {
        let pageSseRequestReceived = false;
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    pageSseRequestReceived = true;
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.write(': keepalive\n\n');
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--page-sse',
                        '--timeout-ms',
                        '1000',
                        '--size',
                        '1024x1024',
                        '--quality',
                        'high',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl },
                    { timeoutMs: 10_000 }
                );

                assert.equal(result.timedOut, false);
                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                assert.equal(pageSseRequestReceived, true);
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'page_sse_failed');
                assert.match(body.error.message, /\/api\/images/);
            }
        );
    });

    it('passes page access hash through to page SSE form-data requests when configured', async () => {
        let pageRequestBody = '';
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: {
                                        required: true,
                                        schemes: ['form-password-hash'],
                                        form_field: 'passwordHash'
                                    }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    pageRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image.png","b64_json":"final-base64","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"page-request-password"}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    {
                        GPT_IMAGE_PLAYGROUND_URL: baseUrl,
                        GPT_IMAGE_APP_PASSWORD_HASH: 'hash-for-page-sse'
                    }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.match(pageRequestBody, /name="passwordHash"\r?\n\r?\nhash-for-page-sse/);
            }
        );
    });

    it('keeps page SSE base64 in default path-mode output when no path is returned', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image.png","b64_json":"indexeddb-base64","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"page-request-indexeddb"}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.images[0].filename, 'image.png');
                assert.equal(body.images[0].b64_json, 'indexeddb-base64');
                assert.equal('absolute_path' in body.images[0], false);
                assert.equal(body.images[0].clientRequestId, 'page-request-indexeddb');
            }
        );
    });

    it('preserves completed page SSE images when the done event lists fewer images', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: {
                                    supported: true,
                                    endpoint: '/api/images',
                                    auth: { required: false, schemes: [], form_field: 'passwordHash' }
                                }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"image-a.png","b64_json":"base64-a","path":"/api/image/image-a.png","output_format":"png"}',
                            '',
                            'data: {"type":"completed","filename":"image-b.png","b64_json":"base64-b","path":"/api/image/image-b.png","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"page-request-2","images":[{"filename":"image-a.png"}]}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.images.length, 2);
                assert.equal(body.images[0].filename, 'image-a.png');
                assert.equal(body.images[1].filename, 'image-b.png');
                assert.equal(body.images[1].path, '/api/image/image-b.png');
                assert.equal(body.images[1].absolute_path, `${baseUrl}/api/image/image-b.png`);
                assert.equal(body.images[1].clientRequestId, 'page-request-2');
            }
        );
    });

    it('passes streaming strategy off through explicit Agent JSON generate requests', async () => {
        const requests = [];
        let agentRequestBody = '';
        await withServer(
            async (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    agentRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            images: [
                                {
                                    filename: 'agent-off.png',
                                    content_url: '/api/agent/artifacts/artifact-off/content',
                                    metadata_url: '/api/agent/artifacts/artifact-off',
                                    width: 1254,
                                    height: 1254
                                }
                            ],
                            timing: { server_elapsed_ms: 4321 }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected page SSE call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--size',
                        '3072x2048',
                        '--quality',
                        'high',
                        '--streaming-strategy',
                        'off',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.images[0].filename, 'agent-off.png');
                assert.deepEqual(body.routing, { transport: 'agent_json', endpoint: '/api/agent/images/generate' });
                assert.equal(body.summary.ok, true);
                assert.equal(body.summary.billable, true);
                assert.equal(body.summary.idempotency_key.startsWith('agent-generate-'), true);
                assert.equal(body.summary.transport, 'agent_json');
                assert.equal(body.summary.endpoint, '/api/agent/images/generate');
                assert.equal(body.summary.route_mode, 'agent');
                assert.deepEqual(body.summary.content_urls, ['/api/agent/artifacts/artifact-off/content']);
                assert.deepEqual(body.summary.absolute_content_urls, [
                    `${baseUrl}/api/agent/artifacts/artifact-off/content`
                ]);
                assert.deepEqual(body.summary.actual_dimensions, { width: 1254, height: 1254 });
                assert.deepEqual(body.summary.image_dimensions, [{ width: 1254, height: 1254 }]);
                assert.equal(typeof body.summary.elapsed_ms, 'number');
                assert.equal(body.summary.elapsed_source, 'client_script');
                assert.equal(body.summary.server_elapsed_ms, 4321);
                assert.equal(body.summary.elapsed_breakdown.upstream_or_server_ms, 4321);
                assert.equal(body.summary.next_action, 'done');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/agent/images/generate']
                );
                const requestBody = JSON.parse(agentRequestBody);
                assert.equal(requestBody.size, '3072x2048');
                assert.equal(requestBody.streaming_strategy, 'off');
            }
        );
    });

    it('uses Agent JSON for billable large generate requests when --agent is explicit', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            images: [
                                {
                                    filename: 'agent.png',
                                    content_url: '/api/agent/artifacts/artifact-1/content',
                                    metadata_url: '/api/agent/artifacts/artifact-1'
                                }
                            ]
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected page SSE call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--agent', '--size', '3072x2048', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.images[0].filename, 'agent.png');
                assert.equal(body.images[0].absolute_content_url, `${baseUrl}/api/agent/artifacts/artifact-1/content`);
                assert.deepEqual(body.routing, { transport: 'agent_json', endpoint: '/api/agent/images/generate' });
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/agent/images/generate']
                );
            }
        );
    });

    it('uses page SSE for billable small generate requests when --page-sse is explicit', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: {
                                page_sse: { supported: true, endpoint: '/api/images' }
                            },
                            agent_jobs: { supported: true, mode: 'job_polling' }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"small-page.png","path":"/api/image/small-page.png","output_format":"png"}',
                            '',
                            'data: {"type":"done","client_request_id":"small-page-request","images":[{"filename":"small-page.png"}]}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected Agent JSON call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--size', '1024x1024', '--quality', 'high', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.images[0].filename, 'small-page.png');
                assert.equal(body.images[0].absolute_path, `${baseUrl}/api/image/small-page.png`);
                assert.deepEqual(body.routing, {
                    transport: 'page_sse',
                    endpoint: '/api/images',
                    route_mode: 'page_sse',
                    fallback_endpoint: '/api/agent/image-requests',
                    fallback_mode: 'manual_after_diagnosis',
                    stream_mode: null,
                    streaming_strategy: null
                });
                assert.equal(body.summary.ok, true);
                assert.equal(body.summary.billable, true);
                assert.equal(body.summary.transport, 'page_sse');
                assert.equal(body.summary.endpoint, '/api/images');
                assert.equal(body.summary.route_mode, 'page_sse');
                assert.deepEqual(body.summary.content_urls, ['/api/image/small-page.png']);
                assert.deepEqual(body.summary.absolute_content_urls, [`${baseUrl}/api/image/small-page.png`]);
                assert.equal(typeof body.summary.elapsed_ms, 'number');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/images']
                );
            }
        );
    });

    it('passes GPT2Image-compatible generate options to page SSE only when explicitly requested', async () => {
        const requests = [];
        let pageSseRequestBody = '';
        await withServer(
            async (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ agent_streaming: { page_sse: { supported: true } } }));
                    return;
                }
                if (request.url === '/api/images') {
                    pageSseRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.end(
                        [
                            'data: {"type":"completed","filename":"generate.jpg","path":"/generated/generate.jpg"}',
                            '',
                            'data: {"type":"done","images":[{"filename":"generate.jpg","path":"/generated/generate.jpg"}]}',
                            '',
                            ''
                        ].join('\n')
                    );
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected Agent generate call' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--page-sse',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        '--thinking',
                        'medium',
                        '--prompt-optimization',
                        'false',
                        '--force-web',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities', 'POST /api/images']
                );
                assert.match(pageSseRequestBody, /name="mode"\r?\n\r?\ngenerate/);
                assert.match(pageSseRequestBody, /name="image_backend"\r?\n\r?\nresponses-image-generation/);
                assert.match(pageSseRequestBody, /name="responsesModel"\r?\n\r?\ngpt-5\.4-mini/);
                assert.match(pageSseRequestBody, /name="thinking"\r?\n\r?\nmedium/);
                assert.match(pageSseRequestBody, /name="promptOptimization"\r?\n\r?\nfalse/);
                assert.match(pageSseRequestBody, /name="force_web"\r?\n\r?\ntrue/);
            }
        );
    });

    it('rejects generate page SSE partial images outside the selected backend capability before POST', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            agent_streaming: { page_sse: { supported: true } },
                            defaults: { partial_images: 2 },
                            limits: {
                                partial_images: { min: 0, max: 4 },
                                partial_images_by_backend: {
                                    'images-api': { min: 0, max: 4 },
                                    'responses-image-generation': { min: 1, max: 3 }
                                }
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/images') {
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'page SSE should not be called' }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        '--partial-images',
                        '0',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 2);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /partial_images 必须在当前 capabilities 允许的 1 到 3 之间/);
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /api/agent/capabilities']
                );
            }
        );
    });

    it('rejects explicit page SSE when stream-mode is non_stream before network requests', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({ method: request.method, url: request.url });
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unexpected request' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--page-sse', '--stream-mode', 'non_stream', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 2);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /stream_mode=non_stream/);
                assert.doesNotMatch(result.stderr, /ModuleJob|at buildGenerateRoutingGuidance/);
                assert.deepEqual(requests, []);
            }
        );
    });

    it('passes generate response controls through explicit Agent and job diagnostic routes', async () => {
        const requests = [];
        let agentRequestBody = '';
        let jobRequestBody = '';
        await withServer(
            async (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/images/generate') {
                    agentRequestBody = await readRequestText(request);
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            images: [
                                {
                                    id: 'agent-artifact',
                                    filename: 'agent.webp',
                                    content_url: '/api/agent/artifacts/agent-artifact/content'
                                }
                            ]
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/images/generate') {
                    jobRequestBody = await readRequestText(request);
                    response.writeHead(202, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-diagnostic-1',
                                state: 'running',
                                result_url: '/api/agent/jobs/job-diagnostic-1/result',
                                retry_after_seconds: 1
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-diagnostic-1/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'job-diagnostic-1',
                            idempotency_key: 'job-diagnostic-key',
                            cached: false,
                            images: [
                                {
                                    id: 'job-artifact',
                                    filename: 'job.webp',
                                    content_url: '/api/agent/artifacts/job-artifact/content'
                                }
                            ],
                            execution: {
                                transport: 'agent_job_polling',
                                endpoint: '/api/agent/jobs/images/generate',
                                route_mode: 'job',
                                image_backend: 'responses-image-generation',
                                stream_mode: 'auto',
                                streaming_strategy: 'auto'
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--agent',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const agentBody = JSON.parse(agentRequestBody);
                assert.equal(agentBody.image_backend, 'responses');
                assert.equal(agentBody.responsesModel, 'gpt-5.4-mini');

                const jobResult = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--job',
                        '--idempotency-key',
                        'job-diagnostic-key',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );
                assert.equal(jobResult.status, 0);
                assert.equal(jobResult.stderr.trim(), '');
                const jobBody = JSON.parse(jobRequestBody);
                assert.equal(jobBody.image_backend, 'responses');
                assert.equal(jobBody.responsesModel, 'gpt-5.4-mini');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/images/generate',
                        'GET /api/agent/capabilities',
                        'POST /api/agent/jobs/images/generate',
                        'GET /api/agent/jobs/job-diagnostic-1/result'
                    ]
                );
            }
        );
    });

    it('keeps generate response controls on server orchestration when streaming is disabled', async () => {
        const requests = [];
        let imageRequestBody = '';
        await withServer(
            async (request, response) => {
                requests.push({ method: request.method, url: request.url });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests') {
                    imageRequestBody = await readRequestText(request);
                    response.writeHead(202, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-nonstream-controls',
                                state: 'running',
                                result_url: '/api/agent/jobs/job-nonstream-controls/result',
                                retry_after_seconds: 1
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-nonstream-controls/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'job-nonstream-controls',
                            idempotency_key: 'nonstream-controls-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-nonstream-controls',
                                    filename: 'nonstream.webp',
                                    content_url: '/api/agent/artifacts/artifact-nonstream-controls/content'
                                }
                            ],
                            execution: {
                                transport: 'agent_job_polling',
                                endpoint: '/api/agent/image-requests',
                                route_mode: 'job',
                                image_backend: 'responses-image-generation',
                                stream_mode: 'non_stream',
                                streaming_strategy: 'auto'
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--idempotency-key',
                        'nonstream-controls-key',
                        '--image-backend',
                        'responses',
                        '--responses-model',
                        'gpt-5.4-mini',
                        '--stream-mode',
                        'non_stream',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const requestBody = JSON.parse(imageRequestBody);
                assert.equal(requestBody.image_backend, 'responses');
                assert.equal(requestBody.responsesModel, 'gpt-5.4-mini');
                assert.equal(requestBody.stream_mode, 'non_stream');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/image-requests',
                        'GET /api/agent/jobs/job-nonstream-controls/result'
                    ]
                );
            }
        );
    });

    it('prints page SSE guidance for high-resolution edit dry-runs', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--size',
            '3072x2048',
            '--quality',
            'high',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        const body = JSON.parse(result.stdout);
        assert.equal(body.routing_guidance.recommended_endpoint, '/api/images');
        assert.equal(body.routing_guidance.transport, 'page_sse');
        assert.equal(body.routing_guidance.strength, 'default');
        assert.equal(result.stderr.trim(), '');
    });

    it('rejects edit dimension-check without a fixed requested size before remote execution', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--dimension-check',
            '--size',
            'auto',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout.trim(), '');
        assert.match(result.stderr, /--dimension-check 需要 --size 为 WIDTHxHEIGHT/);
    });

    it('routes GPT2Image-compatible edit options through page SSE dry-runs', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--format',
            'jpeg',
            '--output-compression',
            '85',
            '--moderation',
            'auto',
            '--image-backend',
            'responses',
            '--responses-model',
            'gpt-5.4-mini',
            '--thinking',
            'medium',
            '--prompt-optimization',
            'false',
            '--force-web',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        assert.equal(result.stderr.trim(), '');
        const body = JSON.parse(result.stdout);
        assert.equal(body.routing_guidance.transport, 'page_sse');
        assert.equal(body.request.output_format, 'jpeg');
        assert.equal(body.request.output_compression, 85);
        assert.equal(body.request.moderation, 'auto');
        assert.equal(body.request.image_backend, 'responses-image-generation');
        assert.equal(body.request.responsesModel, 'gpt-5.4-mini');
        assert.equal(body.request.thinking, 'medium');
        assert.equal(body.request.promptOptimization, false);
        assert.equal(body.request.force_web, true);
    });

    it('shows edit dimension-check in dry-run requests', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--dimension-check',
            '--size',
            '1024x1024',
            '--agent',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 0);
        assert.equal(result.stderr.trim(), '');
        const body = JSON.parse(result.stdout);
        assert.equal(body.request.dimension_check, true);
        assert.equal(body.routing_guidance.transport, 'agent_json');
    });

    it('uses page SSE for billable high-resolution edit requests', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];
            let pageSseRequestBody = '';

            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        pageSseRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit.png","path":"/generated/edit.png","clientRequestId":"edit-page-sse-key"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.png","path":"/generated/edit.png"}],"clientRequestId":"edit-page-sse-key"}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--size',
                            '3072x2048',
                            '--idempotency-key',
                            'edit-page-sse-key',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.deepEqual(body.routing, {
                        transport: 'page_sse',
                        endpoint: '/api/images',
                        fallback_endpoint: '/api/agent/images/edit',
                        fallback_mode: 'manual_after_diagnosis'
                    });
                    assert.equal(body.images[0].absolute_path, `${baseUrl}/generated/edit.png`);
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                    assert.match(pageSseRequestBody, /name="mode"\r?\n\r?\nedit/);
                    assert.match(pageSseRequestBody, /name="clientRequestId"\r?\n\r?\nedit-page-sse-key/);
                    assert.match(pageSseRequestBody, /name="image_0"; filename="source\.png"/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('checks edit page SSE output dimensions from raw SSE image bytes before formatting', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-dim-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const finalImageBase64 = fakePngBase64(1024, 1024);
            let imageRouteHits = 0;

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify(
                                agentGenerateCapabilities({ agent_streaming: { page_sse: { supported: true } } })
                            )
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                `data: ${JSON.stringify({
                                    type: 'completed',
                                    filename: 'edit.png',
                                    b64_json: finalImageBase64,
                                    path: '/api/image/edit-ok.png'
                                })}`,
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.png","path":"/api/image/edit-ok.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    if (request.url === '/api/image/edit-ok.png') {
                        imageRouteHits += 1;
                        response.writeHead(401, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'cookie required' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--dimension-check',
                            '--page-sse',
                            '--size',
                            '1024x1024',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.equal(imageRouteHits, 0);
                    const body = JSON.parse(result.stdout);
                    assert.equal('b64_json' in body.images[0], false);
                    assert.equal(body.images[0].path, '/api/image/edit-ok.png');
                    assert.equal(body.images[0].absolute_path, `${baseUrl}/api/image/edit-ok.png`);
                    assert.deepEqual(body.images[0].dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.summary.actual_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.summary.image_dimensions, [{ width: 1024, height: 1024 }]);
                    assert.equal(body.summary.transport, 'page_sse');
                    assert.equal(body.summary.endpoint, '/api/images');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('reports edit dimension-check artifact download failures as validation failures', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-dim-download-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify(
                                agentGenerateCapabilities({ agent_streaming: { page_sse: { supported: true } } })
                            )
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit.png","path":"/artifact/missing-edit.png"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.png","path":"/artifact/missing-edit.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing artifact' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--dimension-check',
                            '--page-sse',
                            '--size',
                            '1024x1024',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stdout.trim(), '');
                    const body = JSON.parse(result.stderr);
                    assert.equal(body.error.code, 'dimension_check_failed');
                    assert.match(body.error.message, /下载产物失败，状态码 404/);
                    assert.equal(body.validation_failure_kind, 'generated_artifact_failed_dimension_check');
                    assert.equal(body.summary.dimension_check_failed, true);
                    assert.deepEqual(body.summary.expected_dimensions, { width: 1024, height: 1024 });
                    assert.equal(body.summary.actual_dimensions, null);
                    assert.equal(body.summary.transport, 'page_sse');
                    assert.equal(body.response.images[0].absolute_path, `${baseUrl}/artifact/missing-edit.png`);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('passes GPT2Image-compatible edit options to page SSE form-data', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-fields-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            let pageSseRequestBody = '';

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ agent_streaming: { page_sse: { supported: true } } }));
                        return;
                    }
                    if (request.url === '/api/images') {
                        pageSseRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit.jpg","path":"/generated/edit.jpg"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.jpg","path":"/generated/edit.jpg"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--format',
                            'jpeg',
                            '--output-compression',
                            '85',
                            '--moderation',
                            'auto',
                            '--image-backend',
                            'responses',
                            '--responses-model',
                            'gpt-5.4-mini',
                            '--thinking',
                            'medium',
                            '--prompt-optimization',
                            'false',
                            '--force-web',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.match(pageSseRequestBody, /name="output_format"\r?\n\r?\njpeg/);
                    assert.match(pageSseRequestBody, /name="output_compression"\r?\n\r?\n85/);
                    assert.match(pageSseRequestBody, /name="moderation"\r?\n\r?\nauto/);
                    assert.match(pageSseRequestBody, /name="image_backend"\r?\n\r?\nresponses-image-generation/);
                    assert.match(pageSseRequestBody, /name="responsesModel"\r?\n\r?\ngpt-5\.4-mini/);
                    assert.match(pageSseRequestBody, /name="thinking"\r?\n\r?\nmedium/);
                    assert.match(pageSseRequestBody, /name="promptOptimization"\r?\n\r?\nfalse/);
                    assert.match(pageSseRequestBody, /name="force_web"\r?\n\r?\ntrue/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps edit page SSE successful when the optional raw log path is unwritable', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-sse-log-unwritable-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ agent_streaming: { page_sse: { supported: true } } }));
                        return;
                    }
                    if (request.url === '/api/images') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit.png","path":"/generated/edit.png"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.png","path":"/generated/edit.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        ['--allow-billable', '--page-sse', '--sse-log', tempRoot, imagePath, 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.match(result.stderr, /SSE log write failed/);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.images.length, 1);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses Agent edit for explicit high-resolution edit fallback requests', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-agent-fallback-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];
            let editRequestBody = '';

            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        editRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ images: [{ id: 'edit-image', filename: 'edit.png' }] }));
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected page SSE call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        ['--allow-billable', '--agent', '--size', '3072x2048', imagePath, 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/agent/images/edit']
                    );
                    assert.match(editRequestBody, /name="size"\r?\n\r?\n3072x2048/);
                    assert.match(editRequestBody, /name="image_0"; filename="source\.png"/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('checks explicit Agent edit output dimensions from base64 images', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-agent-dim-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify(agentGenerateCapabilities()));
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                request_id: 'edit-dimension-ok',
                                idempotency_key: 'edit-dimension-ok-key',
                                execution: {
                                    transport: 'agent_json',
                                    endpoint: '/api/agent/images/edit',
                                    route_mode: 'agent',
                                    channel_request_mode: 'images-non-stream',
                                    channel_request_mode_fallback_applied: false,
                                    route_decision: {
                                        requested_backend: 'images-api',
                                        preferred_channel_request_mode: 'images-non-stream',
                                        selected_channel_request_mode: 'images-non-stream'
                                    },
                                    selected_channel_id: 'edit-dim-channel',
                                    upstream_host: 'edit-dim-upstream.example.test'
                                },
                                images: [{ id: 'edit-ok', filename: 'edit.png', b64_json: fakePngBase64(1024, 1024) }]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--agent',
                            '--dimension-check',
                            '--size',
                            '1024x1024',
                            '--idempotency-key',
                            'edit-dimension-ok-key',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.deepEqual(body.images[0].dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.summary.actual_dimensions, { width: 1024, height: 1024 });
                    assert.equal(body.summary.channel_request_mode, 'images-non-stream');
                    assert.equal(body.summary.selected_channel_id, 'edit-dim-channel');
                    assert.equal(body.summary.upstream_host, 'edit-dim-upstream.example.test');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('fails explicit Agent edit dimension-check mismatches with route diagnostics', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-agent-dim-bad-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify(agentGenerateCapabilities()));
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                request_id: 'edit-dimension-bad',
                                idempotency_key: 'edit-dimension-bad-key',
                                execution: {
                                    transport: 'agent_json',
                                    endpoint: '/api/agent/images/edit',
                                    route_mode: 'agent',
                                    channel_request_mode: 'images-non-stream',
                                    channel_request_mode_fallback_applied: true,
                                    route_decision: {
                                        requested_backend: 'images-api',
                                        preferred_channel_request_mode: 'images-sse',
                                        fallback_channel_request_mode: 'images-non-stream',
                                        selected_channel_request_mode: 'images-non-stream'
                                    },
                                    selected_channel_id: 'edit-dim-bad-channel',
                                    upstream_host: 'edit-dim-bad-upstream.example.test'
                                },
                                images: [{ id: 'edit-bad', filename: 'edit.png', b64_json: fakePngBase64(1254, 1254) }]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--agent',
                            '--dimension-check',
                            '--size',
                            '1024x1024',
                            '--idempotency-key',
                            'edit-dimension-bad-key',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stdout.trim(), '');
                    const body = JSON.parse(result.stderr);
                    assert.equal(body.error.code, 'dimension_check_failed');
                    assert.equal(body.validation_failure_kind, 'generated_artifact_failed_dimension_check');
                    assert.deepEqual(body.error.expected_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.error.actual_dimensions, { width: 1254, height: 1254 });
                    assert.equal(body.response.images[0].b64_json, undefined);
                    assert.equal(body.response.images[0].b64_json_length, fakePngBase64(1254, 1254).length);
                    assert.deepEqual(body.response.images[0].dimensions, { width: 1254, height: 1254 });
                    assert.equal(body.summary.dimension_check_failed, true);
                    assert.equal(body.summary.transport, 'agent_json');
                    assert.equal(body.summary.endpoint, '/api/agent/images/edit');
                    assert.equal(body.summary.route_mode, 'agent');
                    assert.equal(body.summary.channel_request_mode, 'images-non-stream');
                    assert.equal(body.summary.channel_request_mode_fallback_applied, true);
                    assert.deepEqual(body.summary.route_decision, {
                        requested_backend: 'images-api',
                        preferred_channel_request_mode: 'images-sse',
                        fallback_channel_request_mode: 'images-non-stream',
                        selected_channel_request_mode: 'images-non-stream'
                    });
                    assert.equal(body.summary.selected_channel_id, 'edit-dim-bad-channel');
                    assert.equal(body.summary.upstream_host, 'edit-dim-bad-upstream.example.test');
                    assert.match(body.summary.next_action, /确认当前编辑渠道是否支持请求尺寸/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('enriches failed Agent edit summaries with Agent state diagnostics', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-diagnostics-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];

            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        await readRequestText(request);
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                error: { code: 'unexpected_error', message: 'edit failed', retryable: false }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/diagnostics/requests?idempotency_key=diag-edit-key') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                found: true,
                                diagnostics: {
                                    request: {
                                        request_id: 'req_edit_diag',
                                        idempotency_key: 'diag-edit-key',
                                        status: 'failed'
                                    },
                                    error: {
                                        code: 'unexpected_error',
                                        retryable: false,
                                        diagnostics: {
                                            selected_channel_id: 'channel-edit',
                                            upstream_host: 'edit-upstream.example.test',
                                            transport_error_kind: 'socket_closed'
                                        }
                                    }
                                }
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--agent',
                            '--idempotency-key',
                            'diag-edit-key',
                            '--size',
                            '3072x2048',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stdout.trim(), '');
                    const body = JSON.parse(result.stderr);
                    assert.equal(body.summary.request_id, 'req_edit_diag');
                    assert.equal(body.summary.selected_channel_id, 'channel-edit');
                    assert.equal(body.summary.upstream_host, 'edit-upstream.example.test');
                    assert.equal(body.summary.transport_error_kind, 'socket_closed');
                    assert.equal(body.summary.agent_diagnostics_checked, true);
                    assert.equal(body.summary.agent_diagnostics_found, true);
                    assert.equal(body.agent_failure_diagnostics.request_id, 'req_edit_diag');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        [
                            'GET /api/agent/capabilities',
                            'POST /api/agent/images/edit',
                            'GET /api/agent/diagnostics/requests?idempotency_key=diag-edit-key'
                        ]
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects default WebP edit dry-runs when streaming is explicitly disabled', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--size',
            '3072x2048',
            '--stream-mode',
            'non_stream',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout.trim(), '');
        assert.match(result.stderr, /默认 WebP 图生图输出需要页面 SSE/);
    });

    it('rejects explicit edit page SSE when stream-mode is non_stream before network requests', () => {
        const result = runSkillScript('edit-image.mjs', [
            '--allow-billable',
            '--page-sse',
            '--stream-mode',
            'non_stream',
            '/tmp/source.png',
            'prompt'
        ]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout.trim(), '');
        assert.match(result.stderr, /stream_mode=non_stream/);
    });

    it('reports high-resolution edit page SSE failures as billable structured failures', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-fail-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];

            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            'data: {"type":"error","error":{"message":"edit stream failed"},"status":502}\n\n'
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        ['--allow-billable', '--size', '3072x2048', imagePath, 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stdout.trim(), '');
                    const body = JSON.parse(result.stderr);
                    assert.equal(body.billable, true);
                    assert.equal(body.error.code, 'page_sse_failed');
                    assert.equal(body.error.status, 502);
                    assert.match(body.error.message, /edit stream failed/);
                    assert.deepEqual(body.routing, {
                        transport: 'page_sse',
                        endpoint: '/api/images',
                        fallback_endpoint: '/api/agent/images/edit',
                        fallback_mode: 'manual_after_diagnosis'
                    });
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('reports high-resolution edit page validation failures as non-billable', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-page-sse-reject-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];

            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(400, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'invalid edit request' }));
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        ['--allow-billable', '--size', '3072x2048', imagePath, 'prompt'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stdout.trim(), '');
                    const body = JSON.parse(result.stderr);
                    assert.equal(body.billable, false);
                    assert.equal(body.summary.billable, false);
                    assert.equal(body.error.code, 'page_sse_request_rejected');
                    assert.equal(body.error.status, 400);
                    assert.match(body.error.message, /invalid edit request/);
                    assert.equal(body.routing.fallback_endpoint, '/api/agent/images/edit');
                    assert.equal(body.routing.fallback_mode, 'fix_request_before_retry');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('sends upstream streaming fields in billable edit multipart requests', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-edit-'));
        try {
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            const requests = [];
            let editRequestBody = '';

            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        editRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ images: [{ id: 'edit-image', filename: 'edit.png' }] }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'edit-image.mjs',
                        [
                            '--allow-billable',
                            '--agent',
                            '--stream-mode',
                            'stream',
                            '--streaming-strategy',
                            'responses-sse',
                            '--partial-images',
                            '3',
                            '--force-request',
                            imagePath,
                            'prompt'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/agent/images/edit']
                    );
                    assert.match(editRequestBody, /name="stream_mode"\r?\n\r?\nstream/);
                    assert.match(editRequestBody, /name="streaming_strategy"\r?\n\r?\nresponses-sse/);
                    assert.match(editRequestBody, /name="partial_images"\r?\n\r?\n3/);
                    assert.match(editRequestBody, /name="force_request"\r?\n\r?\ntrue/);
                    assert.match(editRequestBody, /name="image_0"; filename="source\.png"/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects invalid generate upstream streaming options before dry-run output', () => {
        const invalidPartialImages = runSkillScript('generate-image.mjs', ['--partial-images', '5', 'prompt']);
        assert.equal(invalidPartialImages.status, 2);
        assert.match(invalidPartialImages.stderr, /--partial-images 必须是 0 到 4 的整数/);
        assert.equal(invalidPartialImages.stdout.trim(), '');

        const invalidBackend = runSkillScript('generate-image.mjs', ['--image-backend', 'unknown-backend', 'prompt']);
        assert.equal(invalidBackend.status, 2);
        assert.match(invalidBackend.stderr, /--image-backend 必须是/);
        assert.equal(invalidBackend.stdout.trim(), '');

        const invalidStrategy = runSkillScript('generate-image.mjs', [
            '--streaming-strategy',
            'unknown-strategy',
            'prompt'
        ]);
        assert.equal(invalidStrategy.status, 2);
        assert.match(invalidStrategy.stderr, /--streaming-strategy 必须是/);
        assert.equal(invalidStrategy.stdout.trim(), '');

        const invalidResponseMode = runSkillScript('generate-image.mjs', ['--response-mode', 'url', 'prompt']);
        assert.equal(invalidResponseMode.status, 2);
        assert.match(invalidResponseMode.stderr, /--response-mode 必须是 path、base64 或 both/);
        assert.equal(invalidResponseMode.stdout.trim(), '');

        const invalidThinking = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'responses',
            '--responses-model',
            'gpt-5.4-mini',
            '--thinking',
            'unknown',
            'prompt'
        ]);
        assert.equal(invalidThinking.status, 2);
        assert.match(invalidThinking.stderr, /--thinking 必须是/);
        assert.equal(invalidThinking.stdout.trim(), '');

        const invalidPromptOptimization = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'responses',
            '--responses-model',
            'gpt-5.4-mini',
            '--prompt-optimization',
            'maybe',
            'prompt'
        ]);
        assert.equal(invalidPromptOptimization.status, 2);
        assert.match(invalidPromptOptimization.stderr, /--prompt-optimization 必须是 true 或 false/);
        assert.equal(invalidPromptOptimization.stdout.trim(), '');

        const emptyResponsesModel = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'responses',
            '--responses-model',
            '   ',
            'prompt'
        ]);
        assert.equal(emptyResponsesModel.status, 2);
        assert.match(emptyResponsesModel.stderr, /--responses-model 必须是非空字符串/);
        assert.equal(emptyResponsesModel.stdout.trim(), '');

        const responsesModelWithoutBackend = runSkillScript('generate-image.mjs', [
            '--responses-model',
            'gpt-5.4-mini',
            'prompt'
        ]);
        assert.equal(responsesModelWithoutBackend.status, 2);
        assert.match(responsesModelWithoutBackend.stderr, /--responses-model 必须同时设置 --image-backend/);
        assert.equal(responsesModelWithoutBackend.stdout.trim(), '');

        const responsesModelImagesBackend = runSkillScript('generate-image.mjs', [
            '--image-backend',
            'images-api',
            '--responses-model',
            'gpt-5.4-mini',
            'prompt'
        ]);
        assert.equal(responsesModelImagesBackend.status, 2);
        assert.match(responsesModelImagesBackend.stderr, /--responses-model 仅适用于 --image-backend/);
        assert.equal(responsesModelImagesBackend.stdout.trim(), '');

        const disabledAutoPageSse = runSkillScript('generate-image.mjs', [
            '--size',
            '3072x2048',
            '--streaming-strategy',
            'off',
            'prompt'
        ]);
        assert.equal(disabledAutoPageSse.status, 0);
        const disabledAutoPageSseBody = JSON.parse(disabledAutoPageSse.stdout);
        assert.equal(disabledAutoPageSseBody.endpoint, 'http://localhost:4783/api/agent/image-requests');
        assert.equal(disabledAutoPageSseBody.routing_guidance.recommended_endpoint, '/api/agent/image-requests');
        assert.equal(disabledAutoPageSseBody.routing_guidance.transport, 'server_orchestrated');
        assert.equal(disabledAutoPageSse.stderr.trim(), '');

        const disabledPageSse = runSkillScript('generate-image.mjs', [
            '--page-sse',
            '--streaming-strategy',
            'off',
            'prompt'
        ]);
        assert.equal(disabledPageSse.status, 2);
        assert.match(disabledPageSse.stderr, /streaming_strategy=off/);
        assert.doesNotMatch(disabledPageSse.stderr, /ModuleJob|at buildGenerateRoutingGuidance/);
        assert.equal(disabledPageSse.stdout.trim(), '');
    });

    it('shows edit help without validating unrelated env values', () => {
        const result = runSkillScript('edit-image.mjs', ['--help'], {
            GPT_IMAGE_AGENT_MAX_ATTEMPTS: 'abc'
        });

        assert.equal(result.status, 0);
        assert.match(result.stderr, /用法：edit-image\.mjs/);
        assert.equal(result.stdout.trim(), '');
    });

    it('shows skill script help without validating service URL env values', () => {
        const env = { GPT_IMAGE_PLAYGROUND_URL: 'https://user:secret@example.test' };
        const generateHelp = runSkillScript('generate-image.mjs', ['--help'], env);
        const editHelp = runSkillScript('edit-image.mjs', ['--help'], env);

        assert.equal(generateHelp.status, 0);
        assert.match(generateHelp.stderr, /用法：generate-image\.mjs/);
        assert.equal(generateHelp.stdout.trim(), '');
        assert.equal(editHelp.status, 0);
        assert.match(editHelp.stderr, /用法：edit-image\.mjs/);
        assert.equal(editHelp.stdout.trim(), '');
    });

    it('keeps the skill package free of machine-specific and shell-specific paths', () => {
        const forbiddenPatterns = [
            /\/Users\/[^`\\s)]+/,
            /\/Volumes\/[^`\\s)]+/,
            /\/home\/[^`\\s)]+/,
            /C:\\\\Users\\\\[^`\\s)]+/i,
            /\.\.\/\.\.\/\.\.\/src\//,
            /\.\.\/\.\.\/\.\.\/\.\.\/src\//,
            /```bash/,
            /(^|\n)[A-Z_][A-Z0-9_]*=.*\s+node\s/,
            /\\\r?\n\s+--/
        ];

        const matches = [];
        for (const filePath of listTextFiles(skillRoot)) {
            const content = readFileSync(filePath, 'utf8');
            for (const pattern of forbiddenPatterns) {
                if (pattern.test(content)) {
                    matches.push(filePath);
                    break;
                }
            }
        }

        assert.deepEqual(matches, []);
    });

    it('keeps skill frontmatter valid without requiring Python YAML tooling', () => {
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const match = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        assert.ok(match, 'SKILL.md must start with YAML frontmatter');

        const frontmatter = Object.fromEntries(
            match[1]
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => {
                    const separator = line.indexOf(':');
                    assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
                    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
                })
        );

        assert.deepEqual(Object.keys(frontmatter).sort(), ['description', 'name']);
        assert.match(frontmatter.name, /^[a-z0-9-]+$/);
        assert.ok(frontmatter.description.length > 0);
        assert.ok(frontmatter.description.length <= 1024);
        assert.doesNotMatch(frontmatter.description, /[<>]/);
        assert.match(frontmatter.description, /替代 Codex 内置的通用生图 Skill/);
    });

    it('tells agents to use bundled scripts instead of ad hoc API callers', () => {
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const openAiYaml = readFileSync(join(skillRoot, 'agents/openai.yaml'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');

        assert.match(skillText, /必须优先运行本 Skill 内置 scripts\/generate-image\.mjs/);
        assert.match(skillText, /替代 Codex 内置的通用生图 Skill/);
        assert.match(skillText, /scripts\/channel-capability-matrix\.mjs/);
        assert.match(skillText, /--allow-billable --confirm-billable/);
        assert.match(skillText, /--allow-plain-http/);
        assert.match(skillText, /tested_request_modes/);
        assert.match(skillText, /enabled_request_modes/);
        assert.match(skillText, /默认只启用 `images-non-stream`/);
        assert.match(skillText, /不要临时编写脚本、curl 命令或手写 fetch\/FormData/);
        assert.match(openAiYaml, /先选择并运行内置脚本/);
        assert.match(openAiYaml, /替代 Codex 内置的通用生图 Skill/);
        assert.match(openAiYaml, /不要临时编写 API 调用脚本/);
        assert.match(apiReference, /先使用这些内置脚本/);
        assert.match(apiReference, /scripts\/channel-capability-matrix\.mjs/);
        assert.match(apiReference, /--allow-billable --confirm-billable/);
        assert.match(apiReference, /--allow-plain-http/);
        assert.match(apiReference, /tested_request_modes/);
        assert.match(apiReference, /enabled_request_modes/);
        assert.match(apiReference, /不要临时编写 Node、Python 或 shell 脚本、curl 命令或手写 fetch\/FormData/);
    });

    it('documents backend-specific image output and preview limits in dedicated Agent docs', () => {
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');

        assert.match(skillText, /limits\.partial_images_by_backend\[image_backend\]/);
        assert.match(skillText, /limits\.generate_images_by_backend\[image_backend\]/);
        assert.match(skillText, /limits\.edit_images_by_backend\[image_backend\]/);
        assert.match(skillText, /`responses-image-generation` 当前生成和页面 SSE 编辑都只允许 `n=1`/);
        assert.match(
            skillText,
            /Agent edit 不接受 `image_backend`，其内部上游流式字段按默认 Images API\/profile 范围校验/
        );
        assert.match(skillText, /Responses image_generation 编辑属于页面 SSE 路径/);
        assert.match(
            skillText,
            /Docker compose 本身不设置这两个默认值，未配置 `\.env\.local` 时仍是 `images-api` 和 `auto`/
        );
        assert.match(skillText, /脚本参数仍写作 `--streaming-strategy responses-sse`/);
        assert.match(skillText, /batch JSONL 字段是 `streaming_strategy`/);
        assert.match(skillText, /`image_streaming_strategy` 是页面 form-data 字段名，不是 batch JSONL 字段/);
        assert.match(skillText, /`capabilities` 里声明的 `page_sse_supported=true`/);
        assert.match(skillText, /`selected_channel_id`、`upstream_host` 为空/);
        assert.match(skillText, /支持位置参数 `<image-path> <prompt>`，也支持 `--image <path> <prompt>` 别名/);
        assert.match(skillText, /`--image-backend responses-image-generation` 只用于页面 SSE edit/);
        assert.match(skillText, /不要把 Matsca `limits\.partial_images=0\.\.4` 误套到 `responses-image-generation`/);
        assert.match(apiReference, /limits\.partial_images_by_backend\[image_backend\]/);
        assert.match(apiReference, /limits\.generate_images_by_backend/);
        assert.match(apiReference, /limits\.edit_images_by_backend/);
        assert.match(apiReference, /`responses-image-generation` 当前两种操作都只允许 `n=1`/);
        assert.match(apiReference, /只代表“声明支持”，不代表当前渠道每次实测都能成功/);
        assert.match(apiReference, /如果 `selected_channel_id`、`upstream_host` 为空/);
        assert.match(apiReference, /Agent edit 不接收 `image_backend`、`output_format` 或 `output_compression`/);
        assert.match(
            apiReference,
            /强制 Agent edit 时由服务端固定使用 WebP 输出契约，`partial_images` 按默认 Images API\/profile 范围校验/
        );
        assert.match(
            apiReference,
            /图片路径可以用位置参数 `<image-path> <prompt>`，也可以用 `--image <path> <prompt>`/
        );
        assert.match(
            apiReference,
            /Agent edit 不接受 `image_backend`；需要 Responses backend edit 字段时必须使用页面端 `\/api\/images` form-data SSE 路径/
        );
        assert.match(apiReference, /Responses image_generation edit 必须走页面 SSE/);
        assert.match(apiReference, /JSONL 字段名必须使用 `streaming_strategy`/);
        assert.match(apiReference, /`image_streaming_strategy` 是页面 form-data 字段名，不是 batch JSONL 字段/);
        assert.match(apiReference, /Responses image_generation 后端仅在页面 SSE `\/api\/images` 中支持编辑功能/);
        assert.doesNotMatch(apiReference, /Responses image_generation 后端当前只支持 generate/);
        assert.match(apiReference, /选择 `responses-image-generation` 或兼容别名 `responses` 时必须优先使用该字段/);
    });

    it('documents batch capacity and dimension guardrails for real Agent runs', () => {
        const readmeText = readFileSync(join(repoRoot, 'README.md'), 'utf8');
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');

        assert.match(readmeText, /npm run first-run/);
        assert.match(readmeText, /npm run first-run -- --json/);
        assert.match(readmeText, /\.env\.agent\.local\.example/);
        assert.match(readmeText, /--base-url http:\/\/localhost:4783/);
        assert.match(skillText, /npm run first-run/);
        assert.match(skillText, /-- --json/);
        assert.match(skillText, /--base-url <url>/);
        assert.match(skillText, /\.env\.agent\.local\.example/);
        assert.match(skillText, /page_sse_real_smoke_status/);
        assert.match(skillText, /responses_image_backend_real_smoke_status/);
        assert.match(skillText, /summary\.page_sse_real_smoke/);
        assert.match(skillText, /兼容聚合状态/);
        assert.match(skillText, /summary\.responses_page_sse_generate_smoke/);
        assert.match(skillText, /summary\.responses_agent_generate_smoke/);
        assert.match(skillText, /responses_agent_generate_1k/);
        assert.match(skillText, /request_mode_controls/);
        assert.match(skillText, /summary\.real_smoke_checks/);
        assert.match(apiReference, /npm run first-run/);
        assert.match(apiReference, /npm run first-run -- --json/);
        assert.match(apiReference, /--base-url <url>/);
        assert.match(apiReference, /\.env\.agent\.local\.example/);
        assert.match(apiReference, /page_sse_real_smoke_status/);
        assert.match(apiReference, /responses_image_backend_real_smoke_status/);
        assert.match(apiReference, /summary\.page_sse_real_smoke/);
        assert.match(apiReference, /兼容聚合状态/);
        assert.match(apiReference, /summary\.responses_page_sse_generate_smoke/);
        assert.match(apiReference, /summary\.responses_agent_generate_smoke/);
        assert.match(apiReference, /responses_agent_generate_1k/);
        assert.match(apiReference, /request_mode_controls/);
        assert.match(apiReference, /summary\.real_smoke_checks/);
        assert.match(skillText, /公开分享可直接打开 `direct_content_urls`，设置访问码时优先给用户 `share_urls`/);
        assert.match(apiReference, /公开分享可直接打开 `direct_content_urls`，设置访问码时优先给用户 `share_urls`/);
        assert.match(apiReference, /顶层 `shares`、`summary\.share_urls` 和 `summary\.direct_content_urls` 输出结果/);

        assert.match(skillText, /不要手动并行启动多个单张脚本/);
        assert.match(skillText, /capacity_feedback/);
        assert.match(skillText, /channelQueue\.capacityPerCredential/);
        assert.match(skillText, /输出格式固定为 Agent WebP 契约/);
        assert.match(skillText, /Agent edit 只是对照路径，不保证与页面 SSE 的像素尺寸完全一致/);
        assert.match(skillText, /复杂 UI、长提示词、高质量图生图遇到 5 分钟级超时/);
        assert.match(skillText, /Codex 会话日志会持久保存命令输出/);
        assert.match(skillText, /npm run env:summary/);
        assert.match(skillText, /verification_scope\.mode=local_planning_only/);
        assert.match(skillText, /--check-remote/);
        assert.match(skillText, /remote_contract_and_local_planning/);
        assert.match(skillText, /manifest_written=false/);
        assert.match(skillText, /Hugging Face Space Secrets 只能写入和列出名称/);

        assert.match(apiReference, /不要手动并行启动多个单张脚本来绕过 `capacity_feedback`/);
        assert.match(apiReference, /streamingBatch\.recommendedConcurrency/);
        assert.match(apiReference, /channelQueue\.capacityPerCredential/);
        assert.match(apiReference, /尺寸敏感任务必须使用生成\/编辑\/批量 `--dimension-check` 或下载后校验/);
        assert.match(apiReference, /编辑 `--dimension-check` 会读取响应 `b64_json` 或同 origin `content_url`/);
        assert.match(apiReference, /channel_capacity_queue_aborted/);
        assert.match(apiReference, /npm run env:summary/);
        assert.match(apiReference, /verification_scope\.mode=local_planning_only/);
        assert.match(apiReference, /--check-remote/);
        assert.match(apiReference, /remote_contract_and_local_planning/);
        assert.match(apiReference, /manifest_written=false/);
        assert.match(apiReference, /Hugging Face Space Secrets 只能写入和列出名称/);
        assert.match(apiReference, /这个失败表示上游已生成但本地验收未通过/);
        assert.match(apiReference, /`validation_failure_count>0` 而 `request_failure_count=0`/);
    });

    it('keeps WebUI page APIs out of the Agent OpenAPI contract', () => {
        const readmeText = readFileSync(join(repoRoot, 'README.md'), 'utf8');
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');
        const openApiSource = readFileSync(join(repoRoot, 'src/lib/agent-openapi.ts'), 'utf8');
        const agentEndpointValues = Object.values(AGENT_ENDPOINTS);
        const pageApiBoundaries = [
            '/api/images',
            '/api/runtime-capabilities',
            '/api/feedback',
            '/api/shares',
            '/api/logs',
            '/api/image-delete'
        ];
        const agentReadableDiagnostics = [
            '/api/agent/page-requests/feedback',
            '/api/agent/page-requests/{id}/feedback',
            '/api/agent/diagnostics/page-requests',
            '/api/agent/diagnostics/page-requests/{id}',
            '/api/agent/diagnostics/channel-health'
        ];
        const localWorkbenchFeatures = ['灵感相册', '历史复用'];

        for (const endpoint of pageApiBoundaries) {
            assert.match(skillText, new RegExp(escapeRegExp(endpoint)));
            assert.match(apiReference, new RegExp(escapeRegExp(endpoint)));
            assert.equal(agentEndpointValues.includes(endpoint), false);
        }

        for (const feature of localWorkbenchFeatures) {
            assert.match(readmeText, new RegExp(escapeRegExp(feature)));
            assert.match(skillText, new RegExp(escapeRegExp(feature)));
            assert.match(apiReference, new RegExp(escapeRegExp(feature)));
            assert.match(apiReference, new RegExp(`${escapeRegExp(feature)}[\\s\\S]*不作为机器 API 契约承诺`));
        }

        for (const endpoint of agentReadableDiagnostics) {
            assert.match(skillText, new RegExp(escapeRegExp(endpoint)));
            assert.match(apiReference, new RegExp(escapeRegExp(endpoint)));
            assert.equal(agentEndpointValues.includes(endpoint), true);
        }

        assert.match(readmeText, /边界矩阵/);
        assert.match(apiReference, /### 边界矩阵/);
        assert.match(openApiSource, /AGENT_ENDPOINTS\.page_request_feedback_batch/);
        assert.match(openApiSource, /AGENT_ENDPOINTS\.page_request_feedback/);
        assert.match(openApiSource, /AGENT_ENDPOINTS\.page_request_diagnostics_batch/);
        assert.match(openApiSource, /AGENT_ENDPOINTS\.page_request_diagnostics/);
        assert.match(openApiSource, /高分辨率 edit 默认优先使用页面端 \/api\/images form-data SSE/);
    });

    it('requires new probe and diagnostics work to keep API contracts ahead of Skill wrappers', () => {
        const readmeText = readFileSync(join(repoRoot, 'README.md'), 'utf8');
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');

        assert.match(readmeText, /新增探针、诊断或路由可观测能力时，先落 API、能力声明和 OpenAPI 契约/);
        assert.match(readmeText, /Skill 脚本做薄封装/);
        assert.match(skillText, /新增探针、诊断、路由健康或请求旅程能力时/);
        assert.match(skillText, /GET \/api\/agent\/capabilities/);
        assert.match(skillText, /GET \/api\/agent\/openapi\.json/);
        assert.match(skillText, /\/api\/agent\/diagnostics\/\*/);
        assert.match(skillText, /Skill 脚本只做薄封装/);
        assert.match(skillText, /不能复制页面 API、运行时 API 和 Agent API 的边界判断/);
        assert.match(apiReference, /新增探针、诊断或健康摘要时/);
        assert.match(apiReference, /capabilities、OpenAPI 或明确的 Agent 只读端点/);
        assert.match(apiReference, /不要让脚本自己拼 page API、runtime API 和 Agent API 的边界逻辑/);
    });

    it('runs from a copied standalone skill directory outside the repository', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'visual-journal-image-agent-'));
        const copiedSkillRoot = join(tempRoot, 'visual-journal-image-agent');
        try {
            cpSync(skillRoot, copiedSkillRoot, { recursive: true });
            writeFileSync(
                join(tempRoot, '.env.agent.local'),
                'GPT_IMAGE_PLAYGROUND_URL=https://parent-space.example.test'
            );
            const standaloneRun = spawnSync(
                process.execPath,
                [join(copiedSkillRoot, 'scripts/generate-image.mjs'), 'prompt'],
                {
                    cwd: join(copiedSkillRoot, 'scripts'),
                    encoding: 'utf8',
                    env: {
                        ...buildIsolatedSkillScriptEnv({ loadPrivateAgentEnv: true }),
                        GPT_IMAGE_AGENT_LOAD_ENV_FILE: '1'
                    }
                }
            );
            assert.equal(standaloneRun.status, 0);
            const standaloneBody = JSON.parse(standaloneRun.stdout);
            assert.equal(standaloneBody.verification_scope.service_base_url, 'http://localhost:4783');

            const result = spawnSync(
                process.execPath,
                [join(copiedSkillRoot, 'scripts/generate-image.mjs'), '--help'],
                {
                    cwd: tmpdir(),
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        GPT_IMAGE_PLAYGROUND_URL: 'not a url'
                    }
                }
            );

            assert.equal(result.status, 0);
            assert.match(result.stderr, /用法：generate-image\.mjs/);
            assert.equal(result.stdout.trim(), '');
            assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ERR_MODULE_NOT_FOUND|src\/lib/);

            const convertHelp = spawnSync(
                process.execPath,
                [join(copiedSkillRoot, 'scripts/convert-image-format.mjs'), '--help'],
                {
                    cwd: tmpdir(),
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        NODE_PATH: ''
                    }
                }
            );

            assert.equal(convertHelp.status, 0);
            assert.match(convertHelp.stderr, /用法：convert-image-format\.mjs/);
            assert.equal(convertHelp.stdout.trim(), '');
            assert.doesNotMatch(`${convertHelp.stdout}\n${convertHelp.stderr}`, /ERR_MODULE_NOT_FOUND|sharp/);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('prints batch dry-run JSONL plans without contacting the service', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({
                        id: 'first item',
                        prompt: 'first prompt',
                        size: '1024x1024',
                        output_format: 'jpg',
                        output_compression: '80'
                    }),
                    JSON.stringify({
                        mode: 'edit',
                        id: 'edit item',
                        prompt: 'edit prompt',
                        image_paths: ['/tmp/source-a.png', '/tmp/source-b.png'],
                        mask_path: '/tmp/mask.png'
                    })
                ].join('\n')
            );

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath, '--ordered-prefix', 'demo']);

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            const body = JSON.parse(result.stdout);
            assert.equal(body.dry_run, true);
            assert.equal(body.billable, false);
            assert.equal(body.verification_scope.mode, 'local_planning_only');
            assert.equal(body.verification_scope.remote_capabilities_verified, false);
            assert.equal(body.verification_scope.runtime_capacity_verified, false);
            assert.equal(body.manifest_written, false);
            assert.equal(body.manifest_write_reason, 'dry_run');
            assert.equal(body.total, 2);
            assert.equal(body.concurrency, 1);
            assert.equal(body.guardrails.ordered_prefix, 'demo');
            assert.equal(body.guardrails.repeat_ordered_prefix_on_real_run, true);
            assert.equal(body.guardrails.dimension_check_recommended, true);
            assert.match(body.guardrails.dimension_check_reason, /--dimension-check/);
            assert.equal(body.tasks[0].endpoint, '/api/agent/image-requests');
            assert.equal(body.tasks[0].idempotency_key, 'demo-0001-first-item');
            assert.equal(body.tasks[0].request.model, 'gpt-image-2');
            assert.equal(body.tasks[0].request.output_format, 'jpeg');
            assert.equal(body.tasks[0].request.output_compression, 80);
            assert.equal(body.tasks[1].endpoint, '/api/images');
            assert.equal(body.tasks[1].routing.transport, 'page_sse');
            assert.equal(body.tasks[1].idempotency_key, 'demo-0002-edit-item');
            assert.deepEqual(body.tasks[1].request.image_fields, ['image_0', 'image_1']);
            assert.equal(body.tasks[1].request.mask, 'provided');
            assert.equal(body.tasks[1].request.output_format, 'webp');
            assert.equal(body.tasks[1].request.output_compression, 100);
            assert.equal('image_path' in body.tasks[1].request, false);
            assert.equal('image_paths' in body.tasks[1].request, false);
            assert.equal('mask_path' in body.tasks[1].request, false);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('prints stdin batch dry-run plans without inventing a /dev/stdin manifest path', () => {
        const input = `${JSON.stringify({
            id: 'stdin-task',
            prompt: 'stdin prompt',
            size: '1024x1024'
        })}\n`;

        const result = runSkillScript('batch-images.mjs', ['--input', '-'], {}, { input });

        assert.equal(result.status, 0);
        assert.equal(result.stderr.trim(), '');
        const body = JSON.parse(result.stdout);
        assert.equal(body.input, '/dev/stdin');
        assert.equal(body.manifest, null);
        assert.equal(body.manifest_written, false);
        assert.equal(body.total, 1);
        assert.equal(body.tasks[0].id, 'stdin-task');
    });

    it('records enriched Agent diagnostics for failed batch tasks and manifests', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-diagnostics-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({ id: 'diag-task', prompt: 'prompt', idempotency_key: 'batch-diag-key' })
            );

            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                error: { code: 'unexpected_error', message: 'fetch failed', retryable: false }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/diagnostics/requests?idempotency_key=batch-diag-key') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                found: true,
                                diagnostics: {
                                    request: {
                                        request_id: 'req_batch_diag',
                                        idempotency_key: 'batch-diag-key',
                                        status: 'failed'
                                    },
                                    error: {
                                        code: 'unexpected_error',
                                        retryable: false,
                                        diagnostics: {
                                            selected_channel_id: 'channel-b',
                                            upstream_host: 'batch-upstream.example.test'
                                        }
                                    }
                                }
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath, '--max-attempts', '1'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].summary.request_id, 'req_batch_diag');
                    assert.equal(body.results[0].summary.selected_channel_id, 'channel-b');
                    assert.equal(body.results[0].summary.upstream_host, 'batch-upstream.example.test');
                    assert.equal(body.results[0].summary.agent_diagnostics_checked, true);
                    assert.equal(body.results[0].agent_failure_diagnostics.request_id, 'req_batch_diag');
                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines[0].summary.request_id, 'req_batch_diag');
                    assert.equal(manifestLines[0].agent_failure_diagnostics.request_id, 'req_batch_diag');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects invalid batch concurrency before dry-run output', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-concurrency-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'first', prompt: 'prompt' }));

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath, '--concurrency', '0']);

            assert.equal(result.status, 2);
            assert.match(result.stderr, /--concurrency 必须是正整数/);
            assert.equal(result.stdout.trim(), '');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects batch concurrency with strict consecutive failure stopping', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-concurrency-stop-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'first', prompt: 'prompt' }));

            const result = runSkillScript('batch-images.mjs', [
                '--input',
                inputPath,
                '--concurrency',
                '2',
                '--max-consecutive-failures',
                '1'
            ]);

            assert.equal(result.status, 2);
            assert.match(result.stderr, /不能同时使用 --max-consecutive-failures/);
            assert.equal(result.stdout.trim(), '');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves explicit zero partial image requests in batch dry-run output', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'zero-partial', prompt: 'prompt', partial_images: 0 }));

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath]);

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            const body = JSON.parse(result.stdout);
            assert.equal(body.tasks[0].request.partial_images, 0);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves explicit falsy batch task ids in dry-run plans', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 0, prompt: 'prompt' }));

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath, '--ordered-prefix', 'demo']);

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            const body = JSON.parse(result.stdout);
            assert.equal(body.tasks[0].id, '0');
            assert.equal(body.tasks[0].idempotency_key, 'demo-0001-0');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('normalizes batch output compression before sending Agent JSON', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-compression-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'compressed',
                    prompt: 'prompt',
                    output_format: 'jpeg',
                    output_compression: '80'
                })
            );

            let agentRequestBody = '';
            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        agentRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ images: [{ id: 'compressed-image', filename: 'compressed.jpg' }] })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const requestBody = JSON.parse(agentRequestBody);
                    assert.equal(requestBody.output_format, 'jpeg');
                    assert.equal(requestBody.output_compression, 80);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects batch Agent JSON requests outside the advertised partial image capability', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-partial-capability-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'too-many-partials',
                    prompt: 'prompt',
                    partial_images: 4
                })
            );

            const requests = [];
            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                limits: {
                                    partial_images: { min: 1, max: 3 }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'generate should not be called' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities']
                    );
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].status, 'failed');
                    assert.match(body.results[0].error, /partial_images 必须在当前 capabilities 允许的 1 到 3 之间/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects batch page SSE partial images outside the selected backend capability before POST', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-page-partial-capability-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'responses-zero-partial',
                    prompt: 'prompt',
                    image_backend: 'responses-image-generation',
                    responsesModel: 'gpt-5.4-mini',
                    partial_images: 0
                })
            );

            const requests = [];
            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: { page_sse: { supported: true } },
                                defaults: { partial_images: 2 },
                                limits: {
                                    partial_images: { min: 0, max: 4 },
                                    partial_images_by_backend: {
                                        'images-api': { min: 0, max: 4 },
                                        'responses-image-generation': { min: 1, max: 3 }
                                    }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'page SSE should not be called' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities']
                    );
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.failure_summary.non_billable_count, 1);
                    assert.equal(body.failure_summary.billable_count, 0);
                    assert.equal(body.results[0].billable, false);
                    assert.equal(body.results[0].status, 'failed');
                    assert.match(body.results[0].error, /partial_images 必须在当前 capabilities 允许的 1 到 3 之间/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('appends batch manifests and skips succeeded tasks during resume', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({ id: 'first', prompt: 'first prompt', size: '1024x1024' }),
                    JSON.stringify({ id: 'second', prompt: 'second prompt', size: '1024x1024' })
                ].join('\n')
            );
            writeFileSync(
                manifestPath,
                `${JSON.stringify({ id: 'first', idempotency_key: 'batch-0001-first', status: 'succeeded' })}\n`
            );

            const requests = [];
            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                images: [
                                    {
                                        id: 'image-second',
                                        filename: 'second.png',
                                        b64_json: fakePngBase64(2, 1)
                                    }
                                ]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--resume', '--input', inputPath, '--manifest', manifestPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].status, 'skipped');
                    assert.equal(body.results[1].status, 'succeeded');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/agent/image-requests']
                    );
                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines.length, 3);
                    assert.equal(manifestLines[1].status, 'skipped');
                    assert.equal(manifestLines[2].status, 'succeeded');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('runs batch tasks with the requested concurrency while preserving result order', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-concurrent-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({ id: 'first', prompt: 'first prompt', idempotency_key: 'first-key' }),
                    JSON.stringify({ id: 'second', prompt: 'second prompt', idempotency_key: 'second-key' }),
                    JSON.stringify({ id: 'third', prompt: 'third prompt', idempotency_key: 'third-key' })
                ].join('\n')
            );

            let activeGenerateRequests = 0;
            let maxActiveGenerateRequests = 0;
            let enteredGenerateRequests = 0;
            const requestKeys = [];
            const twoGenerateRequestsEntered = createDeferred();
            const releaseGenerateResponses = createDeferred();
            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        activeGenerateRequests += 1;
                        enteredGenerateRequests += 1;
                        maxActiveGenerateRequests = Math.max(maxActiveGenerateRequests, activeGenerateRequests);
                        requestKeys.push(request.headers['idempotency-key']);
                        if (enteredGenerateRequests === 2) {
                            twoGenerateRequestsEntered.resolve();
                        }
                        await releaseGenerateResponses.promise;
                        activeGenerateRequests -= 1;
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                images: [
                                    {
                                        id: request.headers['idempotency-key'],
                                        filename: `${request.headers['idempotency-key']}.png`,
                                        b64_json: fakePngBase64(2, 1)
                                    }
                                ]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const resultPromise = runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--concurrency', '2'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl },
                        { timeoutMs: 10_000 }
                    );
                    let result;
                    try {
                        await waitWithTimeout(
                            twoGenerateRequestsEntered.promise,
                            2_000,
                            'expected two generate requests to enter before any response was released'
                        );
                        assert.equal(maxActiveGenerateRequests, 2);
                        releaseGenerateResponses.resolve();
                        result = await resultPromise;
                    } finally {
                        releaseGenerateResponses.resolve();
                        await resultPromise;
                    }

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.concurrency, 2);
                    assert.equal(maxActiveGenerateRequests, 2);
                    assert.deepEqual([...requestKeys].sort(), ['first-key', 'second-key', 'third-key']);
                    assert.deepEqual(
                        body.results.map((item) => item.id),
                        ['first', 'second', 'third']
                    );
                    assert.deepEqual(
                        body.results.map((item) => item.response.images[0].filename),
                        ['first-key.png', 'second-key.png', 'third-key.png']
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('limits batch worker concurrency to runtime capacity feedback when requested concurrency is higher', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-capacity-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({ id: 'first', prompt: 'first prompt', idempotency_key: 'first-key' }),
                    JSON.stringify({ id: 'second', prompt: 'second prompt', idempotency_key: 'second-key' })
                ].join('\n')
            );

            let activeGenerateRequests = 0;
            let maxActiveGenerateRequests = 0;
            const requests = [];
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/runtime-capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                streamingBatch: { recommendedConcurrency: 1 },
                                channelQueue: {
                                    enabled: true,
                                    capacityPerCredential: 1,
                                    maxWaitMs: 420000,
                                    maxSize: 50,
                                    active: 0,
                                    queued: 0
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        activeGenerateRequests += 1;
                        maxActiveGenerateRequests = Math.max(maxActiveGenerateRequests, activeGenerateRequests);
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        activeGenerateRequests -= 1;
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                images: [
                                    {
                                        id: request.headers['idempotency-key'],
                                        filename: `${request.headers['idempotency-key']}.png`,
                                        b64_json: fakePngBase64(2, 1)
                                    }
                                ]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--concurrency', '2'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.requested_concurrency, 2);
                    assert.equal(body.effective_concurrency, 1);
                    assert.equal(body.capacity_feedback.adjusted, true);
                    assert.equal(body.capacity_feedback.recommended_concurrency, 1);
                    assert.equal(body.capacity_feedback.channel_queue.enabled, true);
                    assert.equal(maxActiveGenerateRequests, 1);
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        [
                            'GET /api/runtime-capabilities',
                            'GET /api/agent/capabilities',
                            'POST /api/agent/image-requests',
                            'POST /api/agent/image-requests'
                        ]
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not require capabilities when resume skips every batch task', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-resume-skip-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'done', prompt: 'already done', size: '1024x1024' }));
            writeFileSync(
                manifestPath,
                `${JSON.stringify({ id: 'done', idempotency_key: 'batch-0001-done', status: 'succeeded' })}\n`
            );

            const result = runSkillScript(
                'batch-images.mjs',
                ['--allow-billable', '--resume', '--input', inputPath, '--manifest', manifestPath],
                { GPT_IMAGE_PLAYGROUND_URL: 'http://127.0.0.1:9' }
            );

            assert.equal(result.status, 0);
            assert.equal(result.stderr.trim(), '');
            const body = JSON.parse(result.stdout);
            assert.equal(body.results[0].status, 'skipped');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('skips malformed batch manifest lines during resume', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'first', prompt: 'first prompt', size: '1024x1024' }));
            writeFileSync(
                manifestPath,
                `${JSON.stringify({ id: 'first', idempotency_key: 'batch-0001-first', status: 'succeeded' })}\n{"truncated"`
            );

            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected resumed request' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--resume', '--input', inputPath, '--manifest', manifestPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].status, 'skipped');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('runs default WebP batch edit tasks through page SSE multipart input', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            writeFileSync(
                inputPath,
                JSON.stringify({
                    mode: 'edit',
                    id: 'edit-one',
                    prompt: 'edit prompt',
                    image_path: imagePath,
                    size: '1024x1024'
                })
            );

            const requests = [];
            let editRequestBody = '';
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: { page_sse: { supported: true, endpoint: '/api/images' } }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        editRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit-one.webp","path":"/generated/edit-one.webp"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit-one.webp","path":"/generated/edit-one.webp"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].routing.transport, 'page_sse');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                    assert.match(editRequestBody, /name="prompt"\r?\n\r?\nedit prompt/);
                    assert.match(editRequestBody, /name="image_0"; filename="source\.png"/);
                    assert.match(editRequestBody, /name="output_format"\r?\n\r?\nwebp/);
                    assert.match(editRequestBody, /name="output_compression"\r?\n\r?\n100/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('routes high-resolution batch edit tasks through page SSE', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-page-sse-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            writeFileSync(
                inputPath,
                JSON.stringify({
                    mode: 'edit',
                    id: 'edit-large',
                    prompt: 'edit prompt',
                    image_path: imagePath,
                    size: '3072x2048',
                    idempotency_key: 'batch-edit-page-sse-key'
                })
            );

            let pageSseRequestBody = '';
            const requests = [];
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        pageSseRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"batch-edit.png","path":"/generated/batch-edit.png"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"batch-edit.png","path":"/generated/batch-edit.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].routing.transport, 'page_sse');
                    assert.equal(body.results[0].routing.strength, 'default');
                    assert.equal(body.results[0].summary.ok, true);
                    assert.equal(body.results[0].summary.transport, 'page_sse');
                    assert.equal(body.results[0].summary.endpoint, '/api/images');
                    assert.equal(typeof body.results[0].summary.elapsed_ms, 'number');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                    assert.match(pageSseRequestBody, /name="mode"\r?\n\r?\nedit/);
                    assert.match(pageSseRequestBody, /name="clientRequestId"\r?\n\r?\nbatch-edit-page-sse-key/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('routes batch generate requests with responsesModel through server orchestration', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-responses-model-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'responses-generate',
                    prompt: 'prompt',
                    image_backend: 'responses-image-generation',
                    streaming_strategy: 'responses-sse',
                    responsesModel: 'gpt-4.1-responses',
                    idempotency_key: 'batch-responses-model-key'
                })
            );

            let pageSseRequestBody = '';
            const requests = [];
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                orchestration: {
                                    supported: true,
                                    transport_selection: 'server_owned',
                                    endpoint: '/api/agent/image-requests'
                                },
                                agent_jobs: { supported: true, mode: 'job_polling' },
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        pageSseRequestBody = await readRequestText(request);
                        response.writeHead(202, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                job: {
                                    id: 'batch-job-responses',
                                    state: 'running',
                                    result_url: '/api/agent/jobs/batch-job-responses/result',
                                    retry_after_seconds: 1
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/jobs/batch-job-responses/result') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                request_id: 'batch-job-responses',
                                idempotency_key: 'batch-responses-model-key',
                                cached: false,
                                images: [
                                    {
                                        id: 'responses-artifact',
                                        filename: 'responses.png',
                                        content_url: '/generated/responses.png'
                                    }
                                ],
                                execution: {
                                    transport: 'agent_job_polling',
                                    endpoint: '/api/agent/image-requests',
                                    route_mode: 'job',
                                    image_backend: 'responses-image-generation',
                                    stream_mode: 'auto',
                                    streaming_strategy: 'auto',
                                    channel_request_mode: 'responses-sse',
                                    channel_request_mode_fallback_applied: false,
                                    route_decision: {
                                        requested_backend: 'responses-image-generation',
                                        preferred_channel_request_mode: 'responses-sse',
                                        selected_channel_request_mode: 'responses-sse',
                                        fallback_applied: false,
                                        selected_channel_id: 'responses-channel',
                                        upstream_host: 'upstream.example.test'
                                    }
                                },
                                timing: { server_elapsed_ms: 1234 }
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.deepEqual(body.results[0].routing, {
                        strength: 'default',
                        transport: 'server_orchestrated',
                        endpoint: '/api/agent/image-requests',
                        route_mode: 'job',
                        result_mode: 'job_polling',
                        reason: 'Batch generate tasks submit intent to the server orchestration endpoint; the service owns internal route selection.'
                    });
                    assert.equal(body.results[0].summary.transport, 'agent_job_polling');
                    assert.equal(body.results[0].summary.endpoint, '/api/agent/image-requests');
                    assert.equal(body.results[0].summary.route_mode, 'job');
                    assert.equal(body.results[0].summary.channel_request_mode, 'responses-sse');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        [
                            'GET /api/agent/capabilities',
                            'POST /api/agent/image-requests',
                            'GET /api/agent/jobs/batch-job-responses/result'
                        ]
                    );
                    const requestBody = JSON.parse(pageSseRequestBody);
                    assert.equal(requestBody.image_backend, 'responses-image-generation');
                    assert.equal(requestBody.responsesModel, 'gpt-4.1-responses');
                    assert.equal(requestBody.streaming_strategy, 'responses-sse');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses the server-declared default model for real batch requests', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-default-model-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'dynamic-model', prompt: 'prompt' }));
            let requestBody;
            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify(agentGenerateCapabilities({ defaults: { model: 'custom-image-model' } }))
                        );
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        requestBody = JSON.parse(await readRequestText(request));
                        response.writeHead(202, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                job: {
                                    id: 'dynamic-model-job',
                                    state: 'succeeded',
                                    result_url: '/api/agent/jobs/dynamic-model-job/result'
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/jobs/dynamic-model-job/result') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                request_id: 'dynamic-model-request',
                                idempotency_key: 'batch-0001-dynamic-model',
                                images: [{ id: 'dynamic-model-image', content_url: '/generated/dynamic-model.webp' }]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.equal(requestBody.model, 'custom-image-model');
                    assert.equal(JSON.parse(result.stdout).results[0].status, 'succeeded');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('revalidates size after applying a server-declared default model', async () => {
        let imageRequests = 0;
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities({ defaults: { model: 'gpt-image-1' } })));
                    return;
                }
                if (request.url === '/api/agent/image-requests') imageRequests += 1;
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unexpected request' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--size', '2048x2048', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 2);
                assert.match(result.stderr, /gpt-image-1.*1024x1024/);
                assert.equal(imageRequests, 0);
            }
        );
    });

    it('passes GPT2Image-compatible edit options to batch page SSE form-data', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-edit-advanced-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            writeFileSync(
                inputPath,
                JSON.stringify({
                    mode: 'edit',
                    id: 'edit-advanced',
                    prompt: 'edit prompt',
                    image_path: imagePath,
                    size: '1024x1024',
                    output_format: 'jpeg',
                    output_compression: 85,
                    moderation: 'auto',
                    image_backend: 'responses',
                    responsesModel: 'gpt-5.4-mini',
                    thinking: 'medium',
                    promptOptimization: false,
                    force_web: true,
                    idempotency_key: 'batch-edit-advanced-key'
                })
            );

            let pageSseRequestBody = '';
            const requests = [];
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        pageSseRequestBody = await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"edit.jpg","path":"/generated/edit.jpg"}',
                                '',
                                'data: {"type":"done","images":[{"filename":"edit.jpg","path":"/generated/edit.jpg"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].routing.transport, 'page_sse');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                    assert.match(pageSseRequestBody, /name="mode"\r?\n\r?\nedit/);
                    assert.match(pageSseRequestBody, /name="output_format"\r?\n\r?\njpeg/);
                    assert.match(pageSseRequestBody, /name="output_compression"\r?\n\r?\n85/);
                    assert.match(pageSseRequestBody, /name="moderation"\r?\n\r?\nauto/);
                    assert.match(pageSseRequestBody, /name="image_backend"\r?\n\r?\nresponses-image-generation/);
                    assert.match(pageSseRequestBody, /name="responsesModel"\r?\n\r?\ngpt-5\.4-mini/);
                    assert.match(pageSseRequestBody, /name="thinking"\r?\n\r?\nmedium/);
                    assert.match(pageSseRequestBody, /name="promptOptimization"\r?\n\r?\nfalse/);
                    assert.match(pageSseRequestBody, /name="force_web"\r?\n\r?\ntrue/);
                    assert.match(pageSseRequestBody, /name="image_0"/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps batch responsesModel routing on server orchestration when page SSE capability is unavailable', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-responses-model-no-sse-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'responses-no-page-sse',
                    prompt: 'prompt',
                    image_backend: 'responses-image-generation',
                    responsesModel: 'gpt-4.1-responses'
                })
            );

            const requests = [];
            await withServer(
                async (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                orchestration: {
                                    supported: true,
                                    transport_selection: 'server_owned',
                                    endpoint: '/api/agent/image-requests'
                                },
                                agent_jobs: { supported: true, mode: 'job_polling' }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(202, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                job: {
                                    id: 'batch-no-page-sse-job',
                                    state: 'running',
                                    result_url: '/api/agent/jobs/batch-no-page-sse-job/result',
                                    retry_after_seconds: 1
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/jobs/batch-no-page-sse-job/result') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                request_id: 'batch-no-page-sse-job',
                                idempotency_key: 'responses-no-page-sse',
                                cached: false,
                                images: [
                                    {
                                        id: 'batch-no-page-sse-artifact',
                                        filename: 'responses.png',
                                        content_url: '/generated/responses.png'
                                    }
                                ],
                                execution: {
                                    transport: 'agent_job_polling',
                                    endpoint: '/api/agent/image-requests',
                                    route_mode: 'job',
                                    image_backend: 'responses-image-generation',
                                    stream_mode: 'auto',
                                    streaming_strategy: 'auto',
                                    channel_request_mode: 'images-non-stream',
                                    channel_request_mode_fallback_applied: false,
                                    route_decision: {
                                        requested_backend: 'responses-image-generation',
                                        preferred_channel_request_mode: 'images-non-stream',
                                        selected_channel_request_mode: 'images-non-stream',
                                        fallback_applied: false,
                                        selected_channel_id: 'images-channel',
                                        upstream_host: 'upstream.example.test'
                                    }
                                },
                                timing: { server_elapsed_ms: 987 }
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        {
                            GPT_IMAGE_PLAYGROUND_URL: baseUrl
                        }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].ok, true);
                    assert.deepEqual(body.results[0].routing, {
                        strength: 'default',
                        transport: 'server_orchestrated',
                        endpoint: '/api/agent/image-requests',
                        route_mode: 'job',
                        result_mode: 'job_polling',
                        reason: 'Batch generate tasks submit intent to the server orchestration endpoint; the service owns internal route selection.'
                    });
                    assert.equal(body.results[0].summary.transport, 'agent_job_polling');
                    assert.equal(body.results[0].summary.channel_request_mode, 'images-non-stream');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        [
                            'GET /api/agent/capabilities',
                            'POST /api/agent/image-requests',
                            'GET /api/agent/jobs/batch-no-page-sse-job/result'
                        ]
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not route batch generate tasks through page SSE when streaming is explicitly disabled', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-disabled-page-sse-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'large-generate-non-stream',
                    prompt: 'prompt',
                    size: '3072x2048',
                    stream_mode: 'non_stream'
                })
            );

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath]);

            assert.equal(result.status, 0);
            const body = JSON.parse(result.stdout);
            assert.equal(body.tasks[0].routing.transport, 'server_orchestrated');
            assert.equal(body.tasks[0].routing.endpoint, '/api/agent/image-requests');
            assert.equal(body.tasks[0].routing.result_mode, 'job_polling');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects explicit batch page SSE when streaming is explicitly disabled', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-disabled-explicit-page-sse-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'large-generate-forced-page-sse',
                    prompt: 'prompt',
                    size: '3072x2048',
                    page_sse: true,
                    stream_mode: 'non_stream'
                })
            );

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath]);

            assert.equal(result.status, 2);
            assert.equal(result.stdout.trim(), '');
            assert.match(result.stderr, /large-generate-forced-page-sse/);
            assert.match(result.stderr, /stream_mode=non_stream/);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('records structured page SSE failures in batch output and manifest', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-page-sse-fail-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            writeFileSync(
                inputPath,
                JSON.stringify({
                    mode: 'edit',
                    id: 'edit-large-fail',
                    prompt: 'edit prompt',
                    image_path: imagePath,
                    size: '3072x2048',
                    idempotency_key: 'batch-edit-page-sse-fail-key'
                })
            );

            const requests = [];
            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(400, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'invalid edit request' }));
                        return;
                    }
                    if (request.url === '/api/agent/images/edit') {
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'unexpected Agent edit call' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.ok, false);
                    assert.equal(body.failed, 1);
                    assert.equal(body.results[0].billable, false);
                    assert.equal(body.results[0].error.code, 'page_sse_request_rejected');
                    assert.equal(body.results[0].error.status, 400);
                    assert.equal(body.results[0].routing.fallback_endpoint, '/api/agent/images/edit');
                    assert.equal(body.results[0].routing.fallback_mode, 'fix_request_before_retry');
                    assert.match(body.results[0].next_step, /请求参数或鉴权/);
                    assert.equal(body.results[0].summary.ok, false);
                    assert.equal(body.results[0].summary.billable, false);
                    assert.equal(body.results[0].summary.transport, 'page_sse');
                    assert.equal(body.results[0].summary.endpoint, '/api/images');

                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines.length, 1);
                    assert.equal(manifestLines[0].status, 'failed');
                    assert.equal(manifestLines[0].billable, false);
                    assert.equal(manifestLines[0].error.code, 'page_sse_request_rejected');
                    assert.equal(manifestLines[0].routing.transport, 'page_sse');
                    assert.equal(manifestLines[0].summary.ok, false);
                    assert.equal(manifestLines[0].summary.billable, false);
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'POST /api/images']
                    );
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('re-fetches batch page SSE capabilities after a transient capabilities failure', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-page-sse-capability-retry-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            const imagePath = join(tempRoot, 'source.png');
            writeFileSync(imagePath, fakePngBuffer(2, 1));
            writeFileSync(
                inputPath,
                JSON.stringify({
                    mode: 'edit',
                    id: 'edit-large-capability-retry',
                    prompt: 'edit prompt',
                    image_path: imagePath,
                    size: '3072x2048',
                    idempotency_key: 'capability-retry-key'
                })
            );

            let capabilitiesRequests = 0;
            const requests = [];
            await withServer(
                (request, response) => {
                    requests.push({ method: request.method, url: request.url });
                    if (request.url === '/api/agent/capabilities') {
                        capabilitiesRequests += 1;
                        if (capabilitiesRequests === 1) {
                            response.writeHead(503, { 'content-type': 'text/plain' });
                            response.end('capabilities maintenance');
                            return;
                        }
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: {
                                    page_sse: { supported: true, endpoint: '/api/images' }
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                'data: {"type":"completed","filename":"retry-edit.png","path":"/generated/retry-edit.png","output_format":"png"}',
                                '',
                                'data: {"type":"done"}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath, '--max-attempts', '2'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        ['GET /api/agent/capabilities', 'GET /api/agent/capabilities', 'POST /api/images']
                    );
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].attempt, 2);
                    assert.equal(body.results[0].root_idempotency_key, 'capability-retry-key');
                    assert.equal(body.results[0].response.images[0].filename, 'retry-edit.png');

                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines.length, 2);
                    assert.equal(manifestLines[0].status, 'failed');
                    assert.equal(manifestLines[0].idempotency_key, 'capability-retry-key');
                    assert.equal(manifestLines[1].status, 'succeeded');
                    assert.equal(manifestLines[1].idempotency_key, 'capability-retry-key-attempt-2');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('retries batch failures with fresh attempt idempotency keys and reports a fix list', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-retry-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'retry-generate',
                    prompt: 'prompt',
                    idempotency_key: 'retry-key'
                })
            );

            const idempotencyKeys = [];
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        idempotencyKeys.push(request.headers['idempotency-key']);
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ error: { message: 'upstream failed', code: 'upstream_failed' } })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath, '--max-attempts', '2'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(idempotencyKeys, ['retry-key', 'retry-key-attempt-2']);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.failure_summary.count, 1);
                    assert.equal(body.failure_summary.tasks[0].id, 'retry-generate');
                    assert.equal(body.resume_fix_list[0].previous_idempotency_key, 'retry-key');
                    assert.equal(body.resume_fix_list[0].suggested_idempotency_key, 'retry-key-attempt-3');
                    assert.equal(body.results[0].attempt, 2);
                    assert.equal(body.results[0].root_idempotency_key, 'retry-key');

                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines.length, 2);
                    assert.equal(manifestLines[0].idempotency_key, 'retry-key');
                    assert.equal(manifestLines[0].attempt, 1);
                    assert.equal(manifestLines[1].idempotency_key, 'retry-key-attempt-2');
                    assert.equal(manifestLines[1].root_idempotency_key, 'retry-key');
                    assert.equal(manifestLines[1].attempt, 2);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves the retry suffix when long batch idempotency keys are truncated', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-retry-long-key-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            const longKey = 'k'.repeat(198);
            writeFileSync(
                inputPath,
                JSON.stringify({
                    id: 'retry-generate-long-key',
                    prompt: 'prompt',
                    idempotency_key: longKey
                })
            );

            const idempotencyKeys = [];
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        idempotencyKeys.push(request.headers['idempotency-key']);
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ error: { message: 'upstream failed', code: 'upstream_failed' } })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath, '--max-attempts', '3'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(idempotencyKeys.length, 3);
                    assert.equal(idempotencyKeys[1].length, 200);
                    assert.equal(idempotencyKeys[1].endsWith('-attempt-2'), true);
                    assert.equal(idempotencyKeys[2].length, 200);
                    assert.equal(idempotencyKeys[2].endsWith('-attempt-3'), true);
                    assert.notEqual(idempotencyKeys[1], idempotencyKeys[2]);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.resume_fix_list[0].suggested_idempotency_key.endsWith('-attempt-4'), true);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps truncated batch retry idempotency keys distinct when long roots share a prefix', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-retry-collision-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            const sharedPrefix = 'shared-key-'.padEnd(199, 'x');
            const firstKey = `${sharedPrefix}a`;
            const secondKey = `${sharedPrefix}b`;
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({ id: 'first-long-key', prompt: 'first', idempotency_key: firstKey }),
                    JSON.stringify({ id: 'second-long-key', prompt: 'second', idempotency_key: secondKey })
                ].join('\n')
            );

            const idempotencyKeys = [];
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        idempotencyKeys.push(request.headers['idempotency-key']);
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ error: { message: 'upstream failed', code: 'upstream_failed' } })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath, '--manifest', manifestPath, '--max-attempts', '2'],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(idempotencyKeys.length, 4);
                    assert.equal(idempotencyKeys[1].length, 200);
                    assert.equal(idempotencyKeys[3].length, 200);
                    assert.equal(idempotencyKeys[1].endsWith('-attempt-2'), true);
                    assert.equal(idempotencyKeys[3].endsWith('-attempt-2'), true);
                    assert.notEqual(idempotencyKeys[1], idempotencyKeys[3]);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('stops batch execution after max consecutive failures and leaves later tasks resumable', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-circuit-breaker-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const manifestPath = join(tempRoot, 'manifest.jsonl');
            writeFileSync(
                inputPath,
                [
                    JSON.stringify({ id: 'first-fail', prompt: 'first', idempotency_key: 'first-key' }),
                    JSON.stringify({ id: 'second-skip', prompt: 'second', idempotency_key: 'second-key' })
                ].join('\n')
            );

            const idempotencyKeys = [];
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        idempotencyKeys.push(request.headers['idempotency-key']);
                        response.writeHead(500, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'upstream failed' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        [
                            '--allow-billable',
                            '--input',
                            inputPath,
                            '--manifest',
                            manifestPath,
                            '--max-consecutive-failures',
                            '1'
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    assert.deepEqual(idempotencyKeys, ['first-key']);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.failed, 1);
                    assert.equal(body.results[0].status, 'failed');
                    assert.equal(body.results[1].status, 'skipped');
                    assert.equal(body.results[1].skipped_reason, 'max_consecutive_failures');
                    assert.equal(body.results[1].billable, false);
                    assert.equal(body.failure_summary.count, 1);

                    const manifestLines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
                    assert.equal(manifestLines.length, 2);
                    assert.equal(manifestLines[0].status, 'failed');
                    assert.equal(manifestLines[1].status, 'skipped');
                    assert.equal(manifestLines[1].skipped_reason, 'max_consecutive_failures');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('checks batch output dimensions from same-origin artifact URLs', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'dim-ok', prompt: 'prompt', size: '1024x1024' }));

            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                images: [{ id: 'dim-image', filename: 'dim.png', content_url: '/artifact/dim.png' }]
                            })
                        );
                        return;
                    }
                    if (request.url === '/artifact/dim.png') {
                        response.writeHead(200, { 'content-type': 'image/png' });
                        response.end(fakePngBuffer(1024, 1024));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--dimension-check', '--input', inputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].status, 'succeeded');
                    assert.deepEqual(body.results[0].summary.actual_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].summary.image_dimensions, [{ width: 1024, height: 1024 }]);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('checks batch page SSE path-mode dimensions from raw SSE image bytes before formatting', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-page-sse-dim-'));
        try {
            const inputPath = join(tempRoot, 'tasks.jsonl');
            const finalImageBase64 = fakePngBase64(1024, 1024);
            let imageRouteHits = 0;
            writeFileSync(
                inputPath,
                JSON.stringify({ id: 'dim-page-sse', prompt: 'prompt', size: '1024x1024', page_sse: true })
            );

            await withServer(
                async (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                agent_streaming: { page_sse: { supported: true, endpoint: '/api/images' } }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/images') {
                        await readRequestText(request);
                        response.writeHead(200, { 'content-type': 'text/event-stream' });
                        response.end(
                            [
                                `data: ${JSON.stringify({
                                    type: 'completed',
                                    filename: 'batch.png',
                                    b64_json: finalImageBase64,
                                    path: '/api/image/batch.png',
                                    output_format: 'png'
                                })}`,
                                '',
                                'data: {"type":"done","images":[{"filename":"batch.png","path":"/api/image/batch.png"}]}',
                                '',
                                ''
                            ].join('\n')
                        );
                        return;
                    }
                    if (request.url === '/api/image/batch.png') {
                        imageRouteHits += 1;
                        response.writeHead(401, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ error: 'cookie required' }));
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--dimension-check', '--input', inputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    assert.equal(imageRouteHits, 0);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].status, 'succeeded');
                    assert.equal(body.results[0].routing.transport, 'page_sse');
                    assert.equal('b64_json' in body.results[0].response.images[0], false);
                    assert.equal(body.results[0].response.images[0].path, '/api/image/batch.png');
                    assert.equal(body.results[0].response.images[0].absolute_path, `${baseUrl}/api/image/batch.png`);
                    assert.deepEqual(body.results[0].response.images[0].dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].summary.actual_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].summary.image_dimensions, [{ width: 1024, height: 1024 }]);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('fails batch dimension-check mismatches and invalid size parameters', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-'));
        try {
            const invalidInputPath = join(tempRoot, 'invalid.jsonl');
            writeFileSync(invalidInputPath, JSON.stringify({ id: 'bad-size', prompt: 'prompt', size: 'wide' }));
            const invalidResult = runSkillScript('batch-images.mjs', ['--input', invalidInputPath]);
            assert.equal(invalidResult.status, 2);
            assert.match(invalidResult.stderr, /bad-size\.size 必须是 auto 或 WIDTHxHEIGHT/);
            assert.equal(invalidResult.stdout.trim(), '');

            const nonPositiveInputPath = join(tempRoot, 'non-positive.jsonl');
            writeFileSync(
                nonPositiveInputPath,
                JSON.stringify({ id: 'non-positive-size', prompt: 'prompt', size: '0x3840' })
            );
            const nonPositiveResult = runSkillScript('batch-images.mjs', ['--input', nonPositiveInputPath]);
            assert.equal(nonPositiveResult.status, 2);
            assert.match(nonPositiveResult.stderr, /non-positive-size\.size 的宽度和高度必须是正数/);
            assert.equal(nonPositiveResult.stdout.trim(), '');

            const invalidModelInputPath = join(tempRoot, 'invalid-model.jsonl');
            writeFileSync(
                invalidModelInputPath,
                JSON.stringify({
                    id: 'invalid-model',
                    prompt: 'prompt',
                    model: 'bad-model',
                    size: 'wide'
                })
            );
            const invalidModelResult = runSkillScript('batch-images.mjs', ['--input', invalidModelInputPath]);
            assert.equal(invalidModelResult.status, 2);
            assert.match(invalidModelResult.stderr, /invalid-model\.size 必须是 auto 或 WIDTHxHEIGHT/);
            assert.equal(invalidModelResult.stdout.trim(), '');

            const customModelInputPath = join(tempRoot, 'custom-model.jsonl');
            writeFileSync(
                customModelInputPath,
                JSON.stringify({ id: 'custom-model', prompt: 'prompt', model: 'bad-model', size: '2048x2048' })
            );
            const customModelResult = runSkillScript('batch-images.mjs', ['--input', customModelInputPath]);
            assert.equal(customModelResult.status, 0);
            assert.match(customModelResult.stdout, /bad-model/);

            const pngCompressionInputPath = join(tempRoot, 'png-compression.jsonl');
            writeFileSync(
                pngCompressionInputPath,
                JSON.stringify({
                    id: 'png-compression',
                    prompt: 'prompt',
                    output_format: 'png',
                    output_compression: 80
                })
            );
            const pngCompressionResult = runSkillScript('batch-images.mjs', ['--input', pngCompressionInputPath]);
            assert.equal(pngCompressionResult.status, 0);
            assert.equal(pngCompressionResult.stderr.trim(), '');
            const pngCompressionBody = JSON.parse(pngCompressionResult.stdout);
            assert.equal(pngCompressionBody.tasks[0].request.normalizations.output_compression_ignored_for_png, true);
            assert.equal(pngCompressionBody.tasks[0].request.output_compression, undefined);

            const conflictingFormatInputPath = join(tempRoot, 'conflicting-format.jsonl');
            writeFileSync(
                conflictingFormatInputPath,
                JSON.stringify({
                    id: 'conflicting-format',
                    prompt: 'prompt',
                    output_format: 'png',
                    format: 'webp'
                })
            );
            const conflictingFormatResult = runSkillScript('batch-images.mjs', ['--input', conflictingFormatInputPath]);
            assert.equal(conflictingFormatResult.status, 2);
            assert.match(conflictingFormatResult.stderr, /conflicting-format\.output_format 与 format 不能同时设置/);
            assert.equal(conflictingFormatResult.stdout.trim(), '');

            const editFormatInputPath = join(tempRoot, 'edit-format.jsonl');
            writeFileSync(
                editFormatInputPath,
                JSON.stringify({
                    id: 'edit-format',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    size: '1024x1024',
                    output_format: 'jpeg'
                })
            );
            const editFormatResult = runSkillScript('batch-images.mjs', ['--input', editFormatInputPath]);
            assert.equal(editFormatResult.status, 0);
            assert.equal(editFormatResult.stderr.trim(), '');
            const editFormatBody = JSON.parse(editFormatResult.stdout);
            assert.equal(editFormatBody.tasks[0].routing.transport, 'page_sse');
            assert.match(editFormatBody.tasks[0].routing.reason, /GPT2Image-compatible edit options/);
            assert.equal(editFormatBody.tasks[0].request.output_format, 'jpeg');

            const editBackendInputPath = join(tempRoot, 'edit-backend.jsonl');
            writeFileSync(
                editBackendInputPath,
                JSON.stringify({
                    id: 'edit-backend',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    image_backend: 'responses-image-generation'
                })
            );
            const editBackendResult = runSkillScript('batch-images.mjs', ['--input', editBackendInputPath]);
            assert.equal(editBackendResult.status, 0);
            assert.equal(editBackendResult.stderr.trim(), '');
            const editBackendBody = JSON.parse(editBackendResult.stdout);
            assert.equal(editBackendBody.tasks[0].routing.transport, 'page_sse');
            assert.equal(editBackendBody.tasks[0].request.image_backend, 'responses-image-generation');

            const editBackgroundInputPath = join(tempRoot, 'edit-background.jsonl');
            writeFileSync(
                editBackgroundInputPath,
                JSON.stringify({
                    id: 'edit-background',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    background: 'opaque'
                })
            );
            const editBackgroundResult = runSkillScript('batch-images.mjs', ['--input', editBackgroundInputPath]);
            assert.equal(editBackgroundResult.status, 2);
            assert.match(editBackgroundResult.stderr, /edit-background\.background 仅适用于 generate 任务/);
            assert.equal(editBackgroundResult.stdout.trim(), '');

            const editResponsesModelInputPath = join(tempRoot, 'edit-responses-model.jsonl');
            writeFileSync(
                editResponsesModelInputPath,
                JSON.stringify({
                    id: 'edit-responses-model',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    responsesModel: 'gpt-4.1'
                })
            );
            const editResponsesModelResult = runSkillScript('batch-images.mjs', [
                '--input',
                editResponsesModelInputPath
            ]);
            assert.equal(editResponsesModelResult.status, 2);
            assert.match(
                editResponsesModelResult.stderr,
                /edit-responses-model\.responsesModel 必须同时设置 image_backend=responses-image-generation/
            );
            assert.equal(editResponsesModelResult.stdout.trim(), '');

            const generateImagePathInputPath = join(tempRoot, 'generate-image-path.jsonl');
            writeFileSync(
                generateImagePathInputPath,
                JSON.stringify({
                    id: 'generate-image-path',
                    mode: 'generate',
                    prompt: 'prompt',
                    image_path: 'source.png'
                })
            );
            const generateImagePathResult = runSkillScript('batch-images.mjs', ['--input', generateImagePathInputPath]);
            assert.equal(generateImagePathResult.status, 2);
            assert.match(generateImagePathResult.stderr, /generate-image-path\.image_path 仅适用于 edit 任务/);
            assert.equal(generateImagePathResult.stdout.trim(), '');

            const camelCaseBackendInputPath = join(tempRoot, 'camel-case-backend.jsonl');
            writeFileSync(
                camelCaseBackendInputPath,
                JSON.stringify({
                    id: 'camel-case-backend',
                    prompt: 'prompt',
                    imageBackend: 'responses'
                })
            );
            const camelCaseBackendResult = runSkillScript('batch-images.mjs', ['--input', camelCaseBackendInputPath]);
            assert.equal(camelCaseBackendResult.status, 2);
            assert.match(camelCaseBackendResult.stderr, /camel-case-backend\.imageBackend 不是支持的 batch JSONL 字段/);
            assert.equal(camelCaseBackendResult.stdout.trim(), '');

            const formFieldStreamingInputPath = join(tempRoot, 'form-field-streaming.jsonl');
            writeFileSync(
                formFieldStreamingInputPath,
                JSON.stringify({
                    id: 'form-field-streaming',
                    prompt: 'prompt',
                    image_backend: 'responses-image-generation',
                    image_streaming_strategy: 'responses-sse'
                })
            );
            const formFieldStreamingResult = runSkillScript('batch-images.mjs', [
                '--input',
                formFieldStreamingInputPath
            ]);
            assert.equal(formFieldStreamingResult.status, 2);
            assert.match(
                formFieldStreamingResult.stderr,
                /form-field-streaming\.image_streaming_strategy 不是支持的 batch JSONL 字段/
            );
            assert.equal(formFieldStreamingResult.stdout.trim(), '');

            const camelCaseResponseModeInputPath = join(tempRoot, 'camel-case-response-mode.jsonl');
            writeFileSync(
                camelCaseResponseModeInputPath,
                JSON.stringify({
                    id: 'camel-case-response-mode',
                    prompt: 'prompt',
                    responseMode: 'both'
                })
            );
            const camelCaseResponseModeResult = runSkillScript('batch-images.mjs', [
                '--input',
                camelCaseResponseModeInputPath
            ]);
            assert.equal(camelCaseResponseModeResult.status, 2);
            assert.match(
                camelCaseResponseModeResult.stderr,
                /camel-case-response-mode\.responseMode 不是支持的 batch JSONL 字段/
            );
            assert.equal(camelCaseResponseModeResult.stdout.trim(), '');

            const numericImagePathInputPath = join(tempRoot, 'numeric-image-path.jsonl');
            writeFileSync(
                numericImagePathInputPath,
                JSON.stringify({
                    id: 'numeric-image-path',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 123
                })
            );
            const numericImagePathResult = runSkillScript('batch-images.mjs', ['--input', numericImagePathInputPath]);
            assert.equal(numericImagePathResult.status, 2);
            assert.match(numericImagePathResult.stderr, /numeric-image-path\.image_path 必须是非空字符串/);
            assert.equal(numericImagePathResult.stdout.trim(), '');

            const emptyImagePathsInputPath = join(tempRoot, 'empty-image-paths.jsonl');
            writeFileSync(
                emptyImagePathsInputPath,
                JSON.stringify({
                    id: 'empty-image-paths',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_paths: []
                })
            );
            const emptyImagePathsResult = runSkillScript('batch-images.mjs', ['--input', emptyImagePathsInputPath]);
            assert.equal(emptyImagePathsResult.status, 2);
            assert.match(emptyImagePathsResult.stderr, /empty-image-paths\.image_paths 必须是非空字符串数组/);
            assert.equal(emptyImagePathsResult.stdout.trim(), '');

            const invalidImagePathsInputPath = join(tempRoot, 'invalid-image-paths.jsonl');
            writeFileSync(
                invalidImagePathsInputPath,
                JSON.stringify({
                    id: 'invalid-image-paths',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_paths: ['source.png', 123]
                })
            );
            const invalidImagePathsResult = runSkillScript('batch-images.mjs', ['--input', invalidImagePathsInputPath]);
            assert.equal(invalidImagePathsResult.status, 2);
            assert.match(invalidImagePathsResult.stderr, /invalid-image-paths\.image_paths\[1\] 必须是非空字符串/);
            assert.equal(invalidImagePathsResult.stdout.trim(), '');

            const conflictingImagePathsInputPath = join(tempRoot, 'conflicting-image-paths.jsonl');
            writeFileSync(
                conflictingImagePathsInputPath,
                JSON.stringify({
                    id: 'conflicting-image-paths',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    image_paths: ['source-a.png']
                })
            );
            const conflictingImagePathsResult = runSkillScript('batch-images.mjs', [
                '--input',
                conflictingImagePathsInputPath
            ]);
            assert.equal(conflictingImagePathsResult.status, 2);
            assert.match(
                conflictingImagePathsResult.stderr,
                /conflicting-image-paths\.image_path 与 image_paths 不能同时设置/
            );
            assert.equal(conflictingImagePathsResult.stdout.trim(), '');

            const invalidMaskInputPath = join(tempRoot, 'invalid-mask.jsonl');
            writeFileSync(
                invalidMaskInputPath,
                JSON.stringify({
                    id: 'invalid-mask',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: 'source.png',
                    mask_path: {}
                })
            );
            const invalidMaskResult = runSkillScript('batch-images.mjs', ['--input', invalidMaskInputPath]);
            assert.equal(invalidMaskResult.status, 2);
            assert.match(invalidMaskResult.stderr, /invalid-mask\.mask_path 必须是非空字符串/);
            assert.equal(invalidMaskResult.stdout.trim(), '');

            const transparentInputPath = join(tempRoot, 'transparent.jsonl');
            writeFileSync(
                transparentInputPath,
                JSON.stringify({
                    id: 'transparent-background',
                    prompt: 'prompt',
                    background: 'transparent'
                })
            );
            const transparentResult = runSkillScript('batch-images.mjs', ['--input', transparentInputPath]);
            assert.equal(transparentResult.status, 0);
            assert.equal(transparentResult.stderr.trim(), '');
            const transparentBody = JSON.parse(transparentResult.stdout);
            assert.equal(transparentBody.tasks[0].request.background, 'transparent');

            const stringPageSseInputPath = join(tempRoot, 'string-page-sse.jsonl');
            writeFileSync(
                stringPageSseInputPath,
                JSON.stringify({
                    id: 'string-page-sse',
                    prompt: 'prompt',
                    page_sse: 'true'
                })
            );
            const stringPageSseResult = runSkillScript('batch-images.mjs', ['--input', stringPageSseInputPath]);
            assert.equal(stringPageSseResult.status, 2);
            assert.match(stringPageSseResult.stderr, /string-page-sse\.page_sse 必须是布尔值/);
            assert.equal(stringPageSseResult.stdout.trim(), '');

            const stringComplexUiInputPath = join(tempRoot, 'string-complex-ui.jsonl');
            writeFileSync(
                stringComplexUiInputPath,
                JSON.stringify({
                    id: 'string-complex-ui',
                    prompt: 'prompt',
                    complex_ui: 'true'
                })
            );
            const stringComplexUiResult = runSkillScript('batch-images.mjs', ['--input', stringComplexUiInputPath]);
            assert.equal(stringComplexUiResult.status, 2);
            assert.match(stringComplexUiResult.stderr, /string-complex-ui\.complex_ui 必须是布尔值/);
            assert.equal(stringComplexUiResult.stdout.trim(), '');

            const numericResumeInputPath = join(tempRoot, 'numeric-resume.jsonl');
            writeFileSync(
                numericResumeInputPath,
                JSON.stringify({
                    id: 'numeric-resume',
                    prompt: 'prompt',
                    resume_or_recover: 1
                })
            );
            const numericResumeResult = runSkillScript('batch-images.mjs', ['--input', numericResumeInputPath]);
            assert.equal(numericResumeResult.status, 2);
            assert.match(numericResumeResult.stderr, /numeric-resume\.resume_or_recover 必须是布尔值/);
            assert.equal(numericResumeResult.stdout.trim(), '');

            const unsupportedTransportInputPath = join(tempRoot, 'unsupported-transport.jsonl');
            writeFileSync(
                unsupportedTransportInputPath,
                JSON.stringify({
                    id: 'unsupported-transport',
                    prompt: 'prompt',
                    transport: 'unsupported'
                })
            );
            const unsupportedTransportResult = runSkillScript('batch-images.mjs', [
                '--input',
                unsupportedTransportInputPath
            ]);
            assert.equal(unsupportedTransportResult.status, 2);
            assert.match(
                unsupportedTransportResult.stderr,
                /unsupported-transport\.transport 必须是 page_sse 或 agent_json/
            );
            assert.equal(unsupportedTransportResult.stdout.trim(), '');

            const generateAgentTransportInputPath = join(tempRoot, 'generate-agent-transport.jsonl');
            writeFileSync(
                generateAgentTransportInputPath,
                JSON.stringify({
                    id: 'generate-agent-transport',
                    prompt: 'prompt',
                    transport: 'agent_json'
                })
            );
            const generateAgentTransportResult = runSkillScript('batch-images.mjs', [
                '--input',
                generateAgentTransportInputPath
            ]);
            assert.equal(generateAgentTransportResult.status, 2);
            assert.match(
                generateAgentTransportResult.stderr,
                /generate-agent-transport\.transport=agent_json 仅适用于 edit 任务/
            );
            assert.equal(generateAgentTransportResult.stdout.trim(), '');

            const agentEditTransportInputPath = join(tempRoot, 'agent-edit-transport.jsonl');
            writeFileSync(
                agentEditTransportInputPath,
                JSON.stringify({
                    id: 'agent-edit-transport',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_paths: ['/tmp/source-a.png', '/tmp/source-b.png'],
                    transport: 'agent_json'
                })
            );
            const agentEditTransportResult = runSkillScript('batch-images.mjs', [
                '--input',
                agentEditTransportInputPath
            ]);
            assert.equal(agentEditTransportResult.status, 0);
            assert.equal(agentEditTransportResult.stderr.trim(), '');
            const agentEditTransportBody = JSON.parse(agentEditTransportResult.stdout);
            assert.equal(agentEditTransportBody.tasks[0].endpoint, '/api/agent/images/edit');
            assert.equal(agentEditTransportBody.tasks[0].routing.transport, 'agent_json');
            assert.deepEqual(agentEditTransportBody.tasks[0].request.image_fields, ['image_0', 'image_1']);

            const agentEditNonStreamInputPath = join(tempRoot, 'agent-edit-non-stream.jsonl');
            writeFileSync(
                agentEditNonStreamInputPath,
                JSON.stringify({
                    id: 'agent-edit-non-stream',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: '/tmp/source.png',
                    stream_mode: 'non_stream',
                    streaming_strategy: 'off',
                    transport: 'agent_json'
                })
            );
            const agentEditNonStreamResult = runSkillScript('batch-images.mjs', [
                '--input',
                agentEditNonStreamInputPath
            ]);
            assert.equal(agentEditNonStreamResult.status, 0);
            assert.equal(agentEditNonStreamResult.stderr.trim(), '');
            const agentEditNonStreamBody = JSON.parse(agentEditNonStreamResult.stdout);
            assert.equal(agentEditNonStreamBody.tasks[0].routing.transport, 'agent_json');
            assert.equal(agentEditNonStreamBody.tasks[0].request.stream_mode, 'non_stream');
            assert.equal(agentEditNonStreamBody.tasks[0].request.streaming_strategy, 'off');

            const agentEditPageSseConflictInputPath = join(tempRoot, 'agent-edit-page-sse-conflict.jsonl');
            writeFileSync(
                agentEditPageSseConflictInputPath,
                JSON.stringify({
                    id: 'agent-edit-page-sse-conflict',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: '/tmp/source.png',
                    page_sse: true,
                    transport: 'agent_json'
                })
            );
            const agentEditPageSseConflictResult = runSkillScript('batch-images.mjs', [
                '--input',
                agentEditPageSseConflictInputPath
            ]);
            assert.equal(agentEditPageSseConflictResult.status, 2);
            assert.match(
                agentEditPageSseConflictResult.stderr,
                /agent-edit-page-sse-conflict\.transport=agent_json 不能同时设置 page_sse=true/
            );
            assert.equal(agentEditPageSseConflictResult.stdout.trim(), '');

            const agentEditPageFieldInputPath = join(tempRoot, 'agent-edit-page-field.jsonl');
            writeFileSync(
                agentEditPageFieldInputPath,
                JSON.stringify({
                    id: 'agent-edit-page-field',
                    mode: 'edit',
                    prompt: 'prompt',
                    image_path: '/tmp/source.png',
                    output_format: 'png',
                    transport: 'agent_json'
                })
            );
            const agentEditPageFieldResult = runSkillScript('batch-images.mjs', [
                '--input',
                agentEditPageFieldInputPath
            ]);
            assert.equal(agentEditPageFieldResult.status, 2);
            assert.match(
                agentEditPageFieldResult.stderr,
                /agent-edit-page-field\.transport=agent_json 不支持页面 SSE 高级字段：output_format/
            );
            assert.equal(agentEditPageFieldResult.stdout.trim(), '');

            const responsesModelNonStreamInputPath = join(tempRoot, 'responses-model-non-stream.jsonl');
            writeFileSync(
                responsesModelNonStreamInputPath,
                JSON.stringify({
                    id: 'responses-model-non-stream',
                    prompt: 'prompt',
                    image_backend: 'responses-image-generation',
                    responsesModel: 'gpt-4.1',
                    stream_mode: 'non_stream'
                })
            );
            const responsesModelNonStreamResult = runSkillScript('batch-images.mjs', [
                '--input',
                responsesModelNonStreamInputPath
            ]);
            assert.equal(responsesModelNonStreamResult.status, 0);
            assert.equal(responsesModelNonStreamResult.stderr.trim(), '');
            const responsesModelNonStreamBody = JSON.parse(responsesModelNonStreamResult.stdout);
            assert.equal(responsesModelNonStreamBody.tasks[0].routing.transport, 'server_orchestrated');
            assert.equal(responsesModelNonStreamBody.tasks[0].routing.endpoint, '/api/agent/image-requests');
            assert.equal(responsesModelNonStreamBody.tasks[0].request.responsesModel, 'gpt-4.1');
            assert.equal(responsesModelNonStreamBody.tasks[0].request.stream_mode, 'non_stream');

            const responsesModelWithoutBackendInputPath = join(tempRoot, 'responses-model-without-backend.jsonl');
            writeFileSync(
                responsesModelWithoutBackendInputPath,
                JSON.stringify({
                    id: 'responses-model-without-backend',
                    prompt: 'prompt',
                    responsesModel: 'gpt-4.1'
                })
            );
            const responsesModelWithoutBackendResult = runSkillScript('batch-images.mjs', [
                '--input',
                responsesModelWithoutBackendInputPath
            ]);
            assert.equal(responsesModelWithoutBackendResult.status, 2);
            assert.match(
                responsesModelWithoutBackendResult.stderr,
                /responses-model-without-backend\.responsesModel 必须同时设置 image_backend=responses-image-generation/
            );
            assert.equal(responsesModelWithoutBackendResult.stdout.trim(), '');

            const responsesModelImagesBackendInputPath = join(tempRoot, 'responses-model-images-backend.jsonl');
            writeFileSync(
                responsesModelImagesBackendInputPath,
                JSON.stringify({
                    id: 'responses-model-images-backend',
                    prompt: 'prompt',
                    image_backend: 'images-api',
                    responsesModel: 'gpt-4.1'
                })
            );
            const responsesModelImagesBackendResult = runSkillScript('batch-images.mjs', [
                '--input',
                responsesModelImagesBackendInputPath
            ]);
            assert.equal(responsesModelImagesBackendResult.status, 2);
            assert.match(
                responsesModelImagesBackendResult.stderr,
                /responses-model-images-backend\.responsesModel 仅适用于 image_backend=responses-image-generation/
            );
            assert.equal(responsesModelImagesBackendResult.stdout.trim(), '');

            const mismatchInputPath = join(tempRoot, 'mismatch.jsonl');
            writeFileSync(mismatchInputPath, JSON.stringify({ id: 'dim-bad', prompt: 'prompt', size: '1024x1024' }));
            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                execution: {
                                    transport: 'agent_job_polling',
                                    endpoint: '/api/agent/image-requests',
                                    route_mode: 'job',
                                    channel_request_mode: 'images-non-stream',
                                    channel_request_mode_fallback_applied: true,
                                    route_decision: {
                                        requested_backend: 'images-api',
                                        preferred_channel_request_mode: 'images-sse',
                                        fallback_channel_request_mode: 'images-non-stream',
                                        selected_channel_request_mode: 'images-non-stream'
                                    },
                                    selected_channel_id: 'dimension-channel',
                                    upstream_host: 'dimension-upstream.example.test'
                                },
                                images: [
                                    { id: 'dim-image-bad', filename: 'dim-bad.png', b64_json: fakePngBase64(512, 512) },
                                    { id: 'dim-image-ok', filename: 'dim-ok.png', b64_json: fakePngBase64(1024, 1024) }
                                ]
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--dimension-check', '--input', mismatchInputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.ok, false);
                    assert.equal(body.results[0].error.code, 'dimension_check_failed');
                    assert.match(body.results[0].error.message, /尺寸校验失败/);
                    assert.deepEqual(body.results[0].error.expected_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].error.actual_dimensions, { width: 512, height: 512 });
                    assert.equal(body.results[0].validation_failure_kind, 'generated_artifact_failed_dimension_check');
                    assert.equal(body.results[0].response.images[0].b64_json, undefined);
                    assert.equal(body.results[0].response.images[0].b64_json_length, fakePngBase64(512, 512).length);
                    assert.deepEqual(body.results[0].response.images[0].dimensions, { width: 512, height: 512 });
                    assert.equal(body.results[0].response.images[1].b64_json, undefined);
                    assert.equal(body.results[0].response.images[1].b64_json_length, fakePngBase64(1024, 1024).length);
                    assert.deepEqual(body.results[0].response.images[1].dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].summary.artifact_ids, ['dim-image-bad', 'dim-image-ok']);
                    assert.deepEqual(body.results[0].summary.image_dimensions, [
                        { width: 512, height: 512 },
                        { width: 1024, height: 1024 }
                    ]);
                    assert.deepEqual(body.results[0].summary.expected_dimensions, { width: 1024, height: 1024 });
                    assert.deepEqual(body.results[0].summary.actual_dimensions, { width: 512, height: 512 });
                    assert.equal(body.results[0].summary.dimension_check_failed, true);
                    assert.equal(body.results[0].summary.transport, 'agent_job_polling');
                    assert.equal(body.results[0].summary.endpoint, '/api/agent/image-requests');
                    assert.equal(body.results[0].summary.route_mode, 'job');
                    assert.equal(body.results[0].summary.channel_request_mode, 'images-non-stream');
                    assert.equal(body.results[0].summary.channel_request_mode_fallback_applied, true);
                    assert.deepEqual(body.results[0].summary.route_decision, {
                        requested_backend: 'images-api',
                        preferred_channel_request_mode: 'images-sse',
                        fallback_channel_request_mode: 'images-non-stream',
                        selected_channel_request_mode: 'images-non-stream'
                    });
                    assert.equal(body.results[0].summary.selected_channel_id, 'dimension-channel');
                    assert.equal(body.results[0].summary.upstream_host, 'dimension-upstream.example.test');
                    assert.equal(body.failure_summary.validation_failure_count, 1);
                    assert.equal(body.failure_summary.request_failure_count, 0);
                    assert.equal(
                        body.failure_summary.tasks[0].failure_kind,
                        'generated_artifact_failed_dimension_check'
                    );
                    assert.deepEqual(body.failure_summary.tasks[0].artifact_ids, ['dim-image-bad', 'dim-image-ok']);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects an omitted-model batch size using the configured default model policy', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-default-model-size-'));
        try {
            const inputPath = join(tempRoot, 'legacy-default.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'legacy-default', prompt: 'prompt', size: '2048x2048' }));

            const result = runSkillScript('batch-images.mjs', ['--input', inputPath], {
                OPENAI_IMAGE_MODEL: 'gpt-image-1'
            });

            assert.equal(result.status, 2);
            assert.match(result.stderr, /legacy-default\.size 对自定义模型 gpt-image-1 无效/);
            assert.equal(result.stdout.trim(), '');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('revalidates an omitted-model batch size against the remote default model', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-batch-remote-default-size-'));
        try {
            const inputPath = join(tempRoot, 'remote-default.jsonl');
            writeFileSync(inputPath, JSON.stringify({ id: 'remote-default', prompt: 'prompt', size: '2048x2048' }));
            let imageRequests = 0;

            await withServer(
                (request, response) => {
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(JSON.stringify(agentGenerateCapabilities({ defaults: { model: 'gpt-image-1' } })));
                        return;
                    }
                    if (request.url === '/api/agent/image-requests') imageRequests += 1;
                    response.writeHead(500, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'unexpected request' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'batch-images.mjs',
                        ['--allow-billable', '--input', inputPath],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                    );

                    assert.equal(result.status, 1);
                    assert.equal(result.stderr.trim(), '');
                    assert.equal(imageRequests, 0);
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.results[0].billable, false);
                    assert.match(body.results[0].error, /gpt-image-1/);
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects cross-origin job result URLs before sending auth headers', () => {
        assert.throws(
            () =>
                resolveSameOriginUrl(
                    'https://space.example.test',
                    'https://evil.example.test/result',
                    'job.result_url'
                ),
            /不同 origin/
        );
        assert.equal(
            resolveSameOriginUrl('https://space.example.test', '/api/agent/jobs/abc/result', 'job.result_url'),
            'https://space.example.test/api/agent/jobs/abc/result'
        );
    });

    it('caps retry-after values before sleeping', () => {
        assert.equal(parseRetryAfterValue('5'), 5);
        assert.equal(parseRetryAfterValue('0'), 1);
        assert.equal(parseRetryAfterValue('999999999999999999999'), 60);
        assert.equal(parseRetryAfterValue('not-a-number', 7), 7);
    });

    it('preserves non-JSON capabilities status and body in generate failures', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(503, { 'content-type': 'text/plain' });
                    response.end('maintenance window');
                    return;
                }
                response.writeHead(404, { 'content-type': 'text/plain' });
                response.end('missing');
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('generate-image.mjs', ['--allow-billable', 'prompt'], {
                    GPT_IMAGE_PLAYGROUND_URL: baseUrl
                });

                assert.equal(result.status, 1);
                assert.match(result.stderr, /capabilities 请求失败，状态码 503：maintenance window/);
            }
        );
    });

    it('checks single generate output dimensions from same-origin artifact URLs', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-dimension-ok',
                                state: 'succeeded',
                                result_url: '/api/agent/jobs/job-dimension-ok/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-dimension-ok/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-dimension-ok',
                            idempotency_key: 'dimension-ok-key',
                            images: [
                                {
                                    id: 'artifact-dimension-ok',
                                    content_url: '/artifact/dimension-ok.png'
                                }
                            ]
                        })
                    );
                    return;
                }
                if (request.url === '/artifact/dimension-ok.png') {
                    response.writeHead(200, { 'content-type': 'image/png' });
                    response.end(fakePngBuffer(1024, 1024));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--dimension-check',
                        '--size',
                        '1024x1024',
                        '--idempotency-key',
                        'dimension-ok-key',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.deepEqual(body.images[0].dimensions, { width: 1024, height: 1024 });
                assert.deepEqual(body.summary.actual_dimensions, { width: 1024, height: 1024 });
                assert.deepEqual(body.summary.image_dimensions, [{ width: 1024, height: 1024 }]);
            }
        );
    });

    it('fails single generate dimension-check mismatches with route diagnostics', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-dimension-bad',
                                state: 'succeeded',
                                result_url: '/api/agent/jobs/job-dimension-bad/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-dimension-bad/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-dimension-bad',
                            idempotency_key: 'dimension-bad-key',
                            execution: {
                                transport: 'agent_job_polling',
                                endpoint: '/api/agent/image-requests',
                                route_mode: 'job',
                                channel_request_mode: 'images-non-stream',
                                channel_request_mode_fallback_applied: true,
                                route_decision: {
                                    requested_backend: 'images-api',
                                    preferred_channel_request_mode: 'images-sse',
                                    fallback_channel_request_mode: 'images-non-stream',
                                    selected_channel_request_mode: 'images-non-stream'
                                },
                                selected_channel_id: 'single-dimension-channel',
                                upstream_host: 'single-dimension-upstream.example.test'
                            },
                            images: [
                                {
                                    id: 'artifact-dimension-bad',
                                    b64_json: fakePngBase64(1254, 1254)
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--dimension-check',
                        '--size',
                        '1024x1024',
                        '--idempotency-key',
                        'dimension-bad-key',
                        'prompt'
                    ],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const body = JSON.parse(result.stderr);
                assert.equal(body.error.code, 'dimension_check_failed');
                assert.equal(body.validation_failure_kind, 'generated_artifact_failed_dimension_check');
                assert.deepEqual(body.error.expected_dimensions, { width: 1024, height: 1024 });
                assert.deepEqual(body.error.actual_dimensions, { width: 1254, height: 1254 });
                assert.equal(body.response.images[0].b64_json, undefined);
                assert.equal(body.response.images[0].b64_json_length, fakePngBase64(1254, 1254).length);
                assert.deepEqual(body.response.images[0].dimensions, { width: 1254, height: 1254 });
                assert.equal(body.summary.dimension_check_failed, true);
                assert.equal(body.summary.transport, 'agent_job_polling');
                assert.equal(body.summary.endpoint, '/api/agent/image-requests');
                assert.equal(body.summary.route_mode, 'job');
                assert.equal(body.summary.channel_request_mode, 'images-non-stream');
                assert.equal(body.summary.channel_request_mode_fallback_applied, true);
                assert.deepEqual(body.summary.route_decision, {
                    requested_backend: 'images-api',
                    preferred_channel_request_mode: 'images-sse',
                    fallback_channel_request_mode: 'images-non-stream',
                    selected_channel_request_mode: 'images-non-stream'
                });
                assert.equal(body.summary.selected_channel_id, 'single-dimension-channel');
                assert.equal(body.summary.upstream_host, 'single-dimension-upstream.example.test');
                assert.match(body.summary.next_action, /确认当前渠道是否支持请求尺寸/);
            }
        );
    });

    it('creates artifact share links through the Agent share endpoint when requested', async () => {
        const requests = [];
        await withServer(
            async (request, response) => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    authorization: request.headers.authorization
                });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-share',
                                state: 'succeeded',
                                result_url: '/api/agent/jobs/job-share/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-share/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-share',
                            idempotency_key: 'share-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-share',
                                    content_url: '/api/agent/artifacts/artifact-share/content',
                                    metadata_url: '/api/agent/artifacts/artifact-share',
                                    output_format: 'png',
                                    mime_type: 'image/png',
                                    size_bytes: 12,
                                    width: 1024,
                                    height: 1024
                                }
                            ],
                            created_at: '2026-06-27T00:00:00.000Z'
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/artifacts/artifact-share/share' && request.method === 'POST') {
                    assert.equal(request.headers.authorization, 'Bearer share-token');
                    assert.deepEqual(JSON.parse(await readRequestText(request)), {
                        expires_in_minutes: 60,
                        access_code: 'share-code'
                    });
                    response.writeHead(201, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            artifact_id: 'artifact-share',
                            token: '0123456789abcdef01234567',
                            share_url: `${serverOrigin(request)}/share/0123456789abcdef01234567`,
                            direct_content_url: `${serverOrigin(request)}/api/shares/0123456789abcdef01234567/content`,
                            expires_at: '2026-06-28T00:00:00.000Z',
                            access_code_required: true
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    [
                        '--allow-billable',
                        '--share',
                        '--share-expires-minutes',
                        '60',
                        '--idempotency-key',
                        'share-key',
                        'prompt'
                    ],
                    {
                        GPT_IMAGE_PLAYGROUND_URL: baseUrl,
                        GPT_IMAGE_AGENT_TOKEN: 'share-token',
                        GPT_IMAGE_SHARE_ACCESS_CODE: 'share-code'
                    }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.shares.length, 1);
                assert.equal(body.shares[0].artifact_id, 'artifact-share');
                assert.equal(body.shares[0].access_code_required, true);
                assert.equal(body.summary.share_urls[0], `${baseUrl}/share/0123456789abcdef01234567`);
                assert.equal(
                    body.summary.direct_content_urls[0],
                    `${baseUrl}/api/shares/0123456789abcdef01234567/content`
                );
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/image-requests',
                        'GET /api/agent/jobs/job-share/result',
                        'POST /api/agent/artifacts/artifact-share/share'
                    ]
                );
            }
        );
    });

    it('resolves relative share URLs against the configured playground base url', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-relative-share',
                                state: 'succeeded',
                                result_url: '/api/agent/jobs/job-relative-share/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-relative-share/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-relative-share',
                            idempotency_key: 'relative-share-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-relative-share',
                                    content_url: '/api/agent/artifacts/artifact-relative-share/content',
                                    metadata_url: '/api/agent/artifacts/artifact-relative-share',
                                    output_format: 'png',
                                    mime_type: 'image/png',
                                    size_bytes: 12,
                                    width: 1024,
                                    height: 1024
                                }
                            ],
                            created_at: '2026-06-27T00:00:00.000Z'
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/artifacts/artifact-relative-share/share' && request.method === 'POST') {
                    response.writeHead(201, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            artifact_id: 'artifact-relative-share',
                            token: 'fedcba9876543210fedcba98',
                            share_url: '/share/fedcba9876543210fedcba98',
                            direct_content_url: '/api/shares/fedcba9876543210fedcba98/content',
                            expires_at: null,
                            access_code_required: false
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--share', '--idempotency-key', 'relative-share-key', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl, GPT_IMAGE_AGENT_TOKEN: 'share-token' }
                );

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.summary.share_urls[0], `${baseUrl}/share/fedcba9876543210fedcba98`);
                assert.equal(
                    body.summary.direct_content_urls[0],
                    `${baseUrl}/api/shares/fedcba9876543210fedcba98/content`
                );
            }
        );
    });

    it('rejects share-only generate flags without share mode', async () => {
        const result = await runSkillScriptAsync('generate-image.mjs', ['--share-expires-minutes', '60', 'prompt'], {});

        assert.equal(result.status, 2);
        assert.match(result.stderr, /--share-expires-minutes 需要和 --share 一起使用/);
    });

    it('keeps share URLs under configured playground subpaths', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/playground/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/playground/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-subpath-share',
                                state: 'succeeded',
                                result_url: '/playground/api/agent/jobs/job-subpath-share/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/playground/api/agent/jobs/job-subpath-share/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-subpath-share',
                            idempotency_key: 'subpath-share-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-subpath-share',
                                    content_url: '/playground/api/agent/artifacts/artifact-subpath-share/content',
                                    metadata_url: '/playground/api/agent/artifacts/artifact-subpath-share',
                                    output_format: 'png',
                                    mime_type: 'image/png',
                                    size_bytes: 12,
                                    width: 1024,
                                    height: 1024
                                }
                            ],
                            created_at: '2026-06-27T00:00:00.000Z'
                        })
                    );
                    return;
                }
                if (
                    request.url === '/playground/api/agent/artifacts/artifact-subpath-share/share' &&
                    request.method === 'POST'
                ) {
                    response.writeHead(201, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            artifact_id: 'artifact-subpath-share',
                            token: 'abcdefabcdefabcdefabcdef',
                            share_url: '/playground/share/abcdefabcdefabcdefabcdef',
                            direct_content_url: '/playground/api/shares/abcdefabcdefabcdefabcdef/content',
                            expires_at: null,
                            access_code_required: false
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--share', '--idempotency-key', 'subpath-share-key', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: `${baseUrl}/playground`, GPT_IMAGE_AGENT_TOKEN: 'share-token' }
                );

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.summary.share_urls[0], `${baseUrl}/playground/share/abcdefabcdefabcdefabcdef`);
                assert.equal(
                    body.summary.direct_content_urls[0],
                    `${baseUrl}/playground/api/shares/abcdefabcdefabcdefabcdef/content`
                );
            }
        );
    });

    it('treats blank share access code env as unset', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(agentGenerateCapabilities()));
                    return;
                }
                if (request.url === '/api/agent/image-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            job: {
                                id: 'job-share-blank-access-code',
                                state: 'succeeded',
                                result_url: '/api/agent/jobs/job-share-blank-access-code/result'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/jobs/job-share-blank-access-code/result') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            request_id: 'request-share-blank-access-code',
                            idempotency_key: 'share-blank-access-code-key',
                            cached: false,
                            images: [
                                {
                                    id: 'artifact-share-blank-access-code',
                                    content_url: '/api/agent/artifacts/artifact-share-blank-access-code/content',
                                    metadata_url: '/api/agent/artifacts/artifact-share-blank-access-code',
                                    output_format: 'png',
                                    mime_type: 'image/png',
                                    size_bytes: 12,
                                    width: 1024,
                                    height: 1024
                                }
                            ],
                            created_at: '2026-06-27T00:00:00.000Z'
                        })
                    );
                    return;
                }
                if (
                    request.url === '/api/agent/artifacts/artifact-share-blank-access-code/share' &&
                    request.method === 'POST'
                ) {
                    response.writeHead(201, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            artifact_id: 'artifact-share-blank-access-code',
                            token: '0123456789abcdef01234567',
                            share_url: '/share/0123456789abcdef01234567',
                            direct_content_url: '/api/shares/0123456789abcdef01234567/content',
                            expires_at: null,
                            access_code_required: false
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--share', '--idempotency-key', 'share-blank-access-code-key', 'prompt'],
                    {
                        GPT_IMAGE_PLAYGROUND_URL: baseUrl,
                        GPT_IMAGE_AGENT_TOKEN: 'share-token',
                        GPT_IMAGE_SHARE_ACCESS_CODE: '   '
                    }
                );

                assert.equal(result.status, 0);
                const body = JSON.parse(result.stdout);
                assert.equal(body.shares[0].access_code_required, false);
                assert.equal(body.summary.share_urls[0], `${baseUrl}/share/0123456789abcdef01234567`);
            }
        );
    });

    it('does not duplicate network failure prefixes in generate capability errors', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    return;
                }
                response.writeHead(404, { 'content-type': 'text/plain' });
                response.end('missing');
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'generate-image.mjs',
                    ['--allow-billable', '--timeout-ms', '50', 'prompt'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                const prefixes = result.stderr.match(/请求失败：/g) || [];
                assert.equal(prefixes.length, 1);
                assert.match(result.stderr, /\/api\/agent\/capabilities/);
            }
        );
    });

    it('diagnoses page request feedback and log summaries through Agent endpoints', async () => {
        const requests = [];
        await withServer(
            async (request, response) => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    authorization: request.headers.authorization
                });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                page_request_feedback: '/api/agent/page-requests/{id}/feedback',
                                page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                    assert.deepEqual(JSON.parse(await readRequestText(request)), { ids: ['web-diag'] });
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            feedback: [
                                {
                                    target_type: 'page_request',
                                    target_id: 'web-diag',
                                    value: 'usable',
                                    source: 'webui',
                                    updated_at: '2026-05-12T00:00:00.000Z',
                                    note: 'approved'
                                }
                            ]
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/page-requests/web-diag?filename=hero.png') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            scope: {
                                request_ids: ['web-diag'],
                                filenames: ['hero.png'],
                                filename_matched_request_ids: [],
                                copy_text: 'requestIds=web-diag'
                            },
                            matched_log_count: 1,
                            events: [{ id: 1, at: '2026-05-12T00:00:01.000Z', level: 'info', message: 'ok' }]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--client-request-id', 'web-diag', '--filename', 'hero.png'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl, GPT_IMAGE_AGENT_TOKEN: 'diag-token' }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.client_request_id, 'web-diag');
                assert.equal(body.found, true);
                assert.equal(body.page_request_query_count, 1);
                assert.equal(body.page_request_found_count, 1);
                assert.equal(body.feedback.value, 'usable');
                assert.equal(body.diagnostics.matched_log_count, 1);
                assert.equal(body.request_count, 1);
                assert.equal(body.requests[0].client_request_id, 'web-diag');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'POST /api/agent/page-requests/feedback',
                        'GET /api/agent/diagnostics/page-requests/web-diag?filename=hero.png'
                    ]
                );
                assert.equal(requests[1].authorization, 'Bearer diag-token');
                assert.equal(requests[2].authorization, 'Bearer diag-token');
            }
        );
    });

    it('diagnoses repeated request ids and batch manifests without duplicate feedback calls', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'diagnose-request-'));
        const manifestPath = join(tempRoot, 'batch.manifest.jsonl');
        const outputPath = join(tempRoot, 'diagnosis.json');
        writeFileSync(
            manifestPath,
            [
                JSON.stringify({ id: 'task-a', idempotency_key: 'web-diag-a', status: 'succeeded' }),
                JSON.stringify({ id: 'task-b', client_request_id: 'web-diag-b', status: 'succeeded' })
            ].join('\n')
        );

        const requests = [];
        try {
            await withServer(
                async (request, response) => {
                    requests.push({
                        method: request.method,
                        url: request.url,
                        authorization: request.headers.authorization
                    });
                    if (request.url === '/api/agent/capabilities') {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                endpoints: {
                                    page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                    page_request_diagnostics_batch: '/api/agent/diagnostics/page-requests',
                                    page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                                }
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                        assert.deepEqual(JSON.parse(await readRequestText(request)), {
                            ids: ['web-diag-a', 'web-diag-b']
                        });
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                feedback: [
                                    {
                                        target_type: 'page_request',
                                        target_id: 'web-diag-b',
                                        value: 'needs_revision',
                                        source: 'webui',
                                        updated_at: '2026-05-12T00:00:00.000Z'
                                    }
                                ]
                            })
                        );
                        return;
                    }
                    if (request.url === '/api/agent/diagnostics/page-requests' && request.method === 'POST') {
                        assert.deepEqual(JSON.parse(await readRequestText(request)), {
                            ids: ['web-diag-a', 'web-diag-b'],
                            filenames: ['hero.png']
                        });
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({
                                diagnostics: ['web-diag-a', 'web-diag-b'].map((requestId) => ({
                                    client_request_id: requestId,
                                    scope: {
                                        request_ids: [requestId],
                                        filenames: ['hero.png'],
                                        filename_matched_request_ids: [],
                                        copy_text: `requestIds=${requestId}`
                                    },
                                    matched_log_count: 1,
                                    events: [{ id: 1, at: '2026-05-12T00:00:01.000Z', level: 'info', message: 'ok' }]
                                }))
                            })
                        );
                        return;
                    }
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: 'missing' }));
                },
                async (baseUrl) => {
                    const result = await runSkillScriptAsync(
                        'diagnose-request.mjs',
                        [
                            '--client-request-id',
                            'web-diag-a',
                            '--manifest',
                            manifestPath,
                            '--filename',
                            'hero.png',
                            '--output',
                            outputPath
                        ],
                        { GPT_IMAGE_PLAYGROUND_URL: baseUrl, GPT_IMAGE_AGENT_TOKEN: 'diag-token' }
                    );

                    assert.equal(result.status, 0);
                    assert.equal(result.stderr.trim(), '');
                    const body = JSON.parse(result.stdout);
                    assert.equal(body.request_count, 2);
                    assert.deepEqual(
                        body.requests.map((item) => item.client_request_id),
                        ['web-diag-a', 'web-diag-b']
                    );
                    assert.equal(body.requests[0].feedback, null);
                    assert.equal(body.requests[1].feedback.value, 'needs_revision');
                    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), body);
                    assert.deepEqual(
                        requests.map((item) => `${item.method} ${item.url}`),
                        [
                            'GET /api/agent/capabilities',
                            'POST /api/agent/page-requests/feedback',
                            'POST /api/agent/diagnostics/page-requests'
                        ]
                    );
                    assert.equal(requests[1].authorization, 'Bearer diag-token');
                    assert.equal(requests[2].authorization, 'Bearer diag-token');
                }
            );
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('reads Agent state diagnostics by request id and idempotency key without page feedback calls', async () => {
        const requests = [];
        await withServer(
            async (request, response) => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    authorization: request.headers.authorization
                });
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                agent_request_diagnostics: '/api/agent/diagnostics/requests/{id}',
                                agent_request_diagnostics_lookup: '/api/agent/diagnostics/requests'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests/req_1') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            found: true,
                            diagnostics: {
                                request: {
                                    request_id: 'req_1',
                                    idempotency_key: 'idem_req_1',
                                    mode: 'generate',
                                    status: 'succeeded'
                                },
                                response: {
                                    image_count: 1,
                                    timing: { elapsed_ms: 61234, server_elapsed_ms: 61000 },
                                    execution: {
                                        transport: 'agent_json',
                                        endpoint: '/api/agent/images/generate',
                                        request_headers: {
                                            user_agent_effective: 'visual-journal/2.3.0',
                                            has_extra_headers: false
                                        }
                                    }
                                }
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests?idempotency_key=idem_2') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            found: true,
                            diagnostics: {
                                request: {
                                    request_id: 'req_2',
                                    idempotency_key: 'idem_2',
                                    mode: 'generate',
                                    status: 'failed'
                                },
                                error: {
                                    code: 'upstream_unavailable',
                                    retryable: true,
                                    diagnostics: {
                                        transport_error_kind: 'dns',
                                        cooldown_until: '2026-06-11T12:00:00.000Z',
                                        cooldown_target: {
                                            channel_id: 'channel-a',
                                            request_mode: 'images-non-stream'
                                        }
                                    }
                                }
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--agent-request-id', 'req_1', '--idempotency-key', 'idem_2'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl, GPT_IMAGE_AGENT_TOKEN: 'diag-token' }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.billable, false);
                assert.equal(body.page_request_count, 0);
                assert.equal(body.request_count, 0);
                assert.equal(body.agent_request_count, 2);
                assert.deepEqual(body.requests, []);
                assert.equal(body.agent_requests[0].lookup.type, 'request_id');
                assert.equal(body.agent_requests[0].diagnostics.response.timing.elapsed_ms, 61234);
                assert.equal(
                    body.agent_requests[0].diagnostics.response.execution.request_headers.user_agent_effective,
                    'visual-journal/2.3.0'
                );
                assert.equal(body.agent_requests[1].lookup.type, 'idempotency_key');
                assert.equal(body.agent_requests[1].diagnostics.error.diagnostics.transport_error_kind, 'dns');
                assert.equal(
                    body.agent_requests[1].diagnostics.error.diagnostics.cooldown_target.request_mode,
                    'images-non-stream'
                );
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    [
                        'GET /api/agent/capabilities',
                        'GET /api/agent/diagnostics/requests/req_1',
                        'GET /api/agent/diagnostics/requests?idempotency_key=idem_2'
                    ]
                );
                assert.equal(requests[1].authorization, 'Bearer diag-token');
                assert.equal(requests[2].authorization, 'Bearer diag-token');
            }
        );
    });

    it('lets diagnose-request explicit base-url override the environment service URL', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ endpoints: {} }));
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests/req_base_url') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ found: false }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--base-url', baseUrl, '--agent-request-id', 'req_base_url'],
                    { GPT_IMAGE_PLAYGROUND_URL: 'http://127.0.0.1:9' }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.service_base_url, baseUrl);
                assert.equal(body.service_base_url_source, 'user_provided');
                assert.equal(body.interactive_confirmation_required, false);
                assert.equal(body.agent_found, false);
            }
        );
    });

    it('reports missing Agent state diagnostics as found false without failing the script', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ endpoints: {} }));
                    return;
                }
                if (request.url === '/api/agent/diagnostics/requests/missing-request') {
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ found: false }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--agent-request-id', 'missing-request'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.equal(body.agent_request_count, 1);
                assert.equal(body.agent_found, false);
                assert.equal(body.agent_diagnostics, null);
                assert.equal(body.agent_requests[0].found, false);
            }
        );
    });

    it('fails diagnostics when the feedback batch response violates the contract', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                page_request_diagnostics_batch: '/api/agent/diagnostics/page-requests',
                                page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ targets: [{ type: 'page_request', id: 'web-diag' }] }));
                    return;
                }
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ diagnostics: [] }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('diagnose-request.mjs', ['--client-request-id', 'web-diag'], {
                    GPT_IMAGE_PLAYGROUND_URL: baseUrl
                });

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /批量反馈响应缺少 feedback 数组/);
            }
        );
    });

    it('fails diagnostics when the diagnostics batch response violates the contract', async () => {
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                page_request_diagnostics_batch: '/api/agent/diagnostics/page-requests',
                                page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ feedback: [] }));
                    return;
                }
                if (request.url === '/api/agent/diagnostics/page-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ targets: [{ type: 'page_request', id: 'web-diag' }] }));
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('diagnose-request.mjs', ['--client-request-id', 'web-diag'], {
                    GPT_IMAGE_PLAYGROUND_URL: baseUrl
                });

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /批量诊断响应缺少 diagnostics 数组/);
            }
        );
    });

    it('explains empty page request diagnostics with the advertised log retention boundary', async () => {
        const retention = {
            storage: 'bounded_local_jsonl',
            max_entries: 123,
            default_max_entries: 300,
            min_entries: 100,
            max_configured_entries: 5000,
            configured_by: 'APP_LOG_MAX_ENTRIES',
            persisted_across_process_restart: true,
            loss_modes: ['entry_evicted_by_max_entries', 'log_level_filter', 'local_log_file_missing_or_cleared'],
            bounded: true,
            not_agent_state_backend: true
        };
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                page_request_diagnostics_batch: '/api/agent/diagnostics/page-requests',
                                page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                            },
                            page_request_diagnostics: {
                                supported: true,
                                source: 'app_log',
                                retention
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ feedback: [] }));
                    return;
                }
                if (request.url === '/api/agent/diagnostics/page-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            diagnostics: [
                                {
                                    client_request_id: 'missing-log',
                                    scope: {
                                        request_ids: ['missing-log'],
                                        filenames: [],
                                        filename_matched_request_ids: [],
                                        copy_text: 'requestIds=missing-log'
                                    },
                                    matched_log_count: 0,
                                    events: []
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--client-request-id', 'missing-log'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.deepEqual(body.diagnostics_retention, retention);
                assert.equal(body.found, false);
                assert.equal(body.page_request_query_count, 1);
                assert.equal(body.page_request_found_count, 0);
                assert.equal(body.diagnostics_note.code, 'no_matching_logs_in_retention_window');
                assert.equal(body.requests[0].found, false);
                assert.equal(body.requests[0].diagnostics_note.code, 'no_matching_logs_in_retention_window');
                assert.equal(body.requests[0].diagnostics_note.retention.max_entries, 123);
                assert.match(body.requests[0].diagnostics_note.message, /最近 123 条本地应用日志/);
            }
        );
    });

    it('uses diagnostics API retention when capabilities omit diagnostics metadata', async () => {
        const retention = {
            storage: 'bounded_local_jsonl',
            max_entries: 456,
            default_max_entries: 300,
            min_entries: 100,
            max_configured_entries: 5000,
            configured_by: 'APP_LOG_MAX_ENTRIES',
            persisted_across_process_restart: true,
            loss_modes: ['entry_evicted_by_max_entries', 'log_level_filter', 'local_log_file_missing_or_cleared'],
            bounded: true,
            not_agent_state_backend: true
        };
        await withServer(
            async (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                page_request_feedback_batch: '/api/agent/page-requests/feedback',
                                page_request_diagnostics_batch: '/api/agent/diagnostics/page-requests',
                                page_request_diagnostics: '/api/agent/diagnostics/page-requests/{id}'
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/api/agent/page-requests/feedback' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ feedback: [] }));
                    return;
                }
                if (request.url === '/api/agent/diagnostics/page-requests' && request.method === 'POST') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            diagnostics_retention: retention,
                            diagnostics: [
                                {
                                    client_request_id: 'api-retention-only',
                                    scope: {
                                        request_ids: ['api-retention-only'],
                                        filenames: [],
                                        filename_matched_request_ids: [],
                                        copy_text: 'requestIds=api-retention-only'
                                    },
                                    matched_log_count: 0,
                                    events: []
                                }
                            ]
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-request.mjs',
                    ['--client-request-id', 'api-retention-only'],
                    { GPT_IMAGE_PLAYGROUND_URL: baseUrl }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                const body = JSON.parse(result.stdout);
                assert.deepEqual(body.diagnostics_retention, retention);
                assert.equal(body.diagnostics_note.retention.max_entries, 456);
                assert.equal(body.requests[0].diagnostics_note.retention.max_entries, 456);
                assert.match(body.requests[0].diagnostics_note.message, /最近 456 条本地应用日志/);
            }
        );
    });

    it('reads the process-local channel health snapshot through the declared Agent capability', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push({
                    method: request.method,
                    url: request.url,
                    authorization: request.headers.authorization
                });
                if (request.url === '/playground/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                channel_health_diagnostics: '/api/agent/diagnostics/channel-health'
                            },
                            channel_health_diagnostics: {
                                supported: true,
                                endpoint: '/api/agent/diagnostics/channel-health',
                                source: 'in_process_channel_router',
                                state_scope: 'process_local',
                                billable: false
                            }
                        })
                    );
                    return;
                }
                if (request.url === '/playground/api/agent/diagnostics/channel-health') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            ok: true,
                            billable: false,
                            source: 'in_process_channel_router',
                            state_scope: 'process_local',
                            state_initialized: true,
                            snapshot: {
                                observed_at: 1_000,
                                channels: [
                                    {
                                        channel_id: 'primary',
                                        credential_count: 1,
                                        healthy_credential_count: 1,
                                        unhealthy_credential_count: 0,
                                        state: 'healthy',
                                        probe_required: false,
                                        credentials: [
                                            {
                                                credential_id: 'primary#0',
                                                state: 'healthy',
                                                probe_required: false,
                                                request_modes: [
                                                    {
                                                        mode: 'images-non-stream',
                                                        state: 'healthy',
                                                        probe_required: false
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                ]
                            }
                        })
                    );
                    return;
                }
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'missing' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync(
                    'diagnose-channel-health.mjs',
                    ['--base-url', `${baseUrl}/playground`],
                    { GPT_IMAGE_AGENT_TOKEN: 'channel-health-token' }
                );

                assert.equal(result.status, 0);
                assert.equal(result.stderr.trim(), '');
                assert.doesNotMatch(result.stdout, /channel-health-token/);
                const body = JSON.parse(result.stdout);
                assert.equal(body.ok, true);
                assert.equal(body.billable, false);
                assert.equal(body.state_initialized, true);
                assert.equal(body.service_base_url, `${baseUrl}/playground`);
                assert.equal(body.service_base_url_source, 'user_provided');
                assert.equal(body.snapshot.channels[0].channel_id, 'primary');
                assert.deepEqual(
                    requests.map((item) => `${item.method} ${item.url}`),
                    ['GET /playground/api/agent/capabilities', 'GET /playground/api/agent/diagnostics/channel-health']
                );
                assert.equal(requests[0].authorization, 'Bearer channel-health-token');
                assert.equal(requests[1].authorization, 'Bearer channel-health-token');
            }
        );
    });

    it('does not guess a channel health endpoint when capabilities do not declare support', async () => {
        await withServer(
            (request, response) => {
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ endpoints: {} }));
                    return;
                }
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unexpected request' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('diagnose-channel-health.mjs', ['--base-url', baseUrl]);

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /channel_health_diagnostics/);
            }
        );
    });

    it('rejects inconsistent channel health endpoint declarations before reading diagnostics', async () => {
        const requests = [];
        await withServer(
            (request, response) => {
                requests.push([request.method, request.url].join(' '));
                if (request.url === '/api/agent/capabilities') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(
                        JSON.stringify({
                            endpoints: {
                                channel_health_diagnostics: '/api/agent/diagnostics/other-channel-health'
                            },
                            channel_health_diagnostics: {
                                supported: true,
                                endpoint: '/api/agent/diagnostics/channel-health',
                                source: 'in_process_channel_router',
                                state_scope: 'process_local',
                                billable: false
                            }
                        })
                    );
                    return;
                }
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'unexpected request' }));
            },
            async (baseUrl) => {
                const result = await runSkillScriptAsync('diagnose-channel-health.mjs', ['--base-url', baseUrl]);

                assert.equal(result.status, 1);
                assert.equal(result.stdout.trim(), '');
                assert.match(result.stderr, /端点声明不一致/);
                assert.deepEqual(requests, ['GET /api/agent/capabilities']);
            }
        );
    });
});

describe('Agent endpoint path drift guards', () => {
    it('keeps the Skill endpoint registry identical to the server registry', () => {
        assert.deepEqual(AGENT_ENDPOINTS, SERVER_AGENT_ENDPOINTS);
    });

    it('keeps channel health Skill documentation aligned with the Agent-only contract', () => {
        const readmeText = readFileSync(join(repoRoot, 'README.md'), 'utf8');
        const skillText = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
        const apiReference = readFileSync(join(skillRoot, 'references/api.md'), 'utf8');
        const openApiSource = readFileSync(join(repoRoot, 'src/lib/agent-openapi.ts'), 'utf8');

        assert.equal(AGENT_ENDPOINTS.channel_health_diagnostics, '/api/agent/diagnostics/channel-health');
        assert.match(readmeText, /\/api\/agent\/diagnostics\/channel-health/);
        assert.match(skillText, /diagnose-channel-health\.mjs/);
        assert.match(apiReference, /diagnose-channel-health\.mjs/);
        assert.match(skillText, /\/api\/agent\/diagnostics\/channel-health/);
        assert.match(apiReference, /\/api\/agent\/diagnostics\/channel-health/);
        assert.match(readmeText, /不触发上游探测或图片生成/);
        assert.match(readmeText, /不替代页面/);
        assert.match(readmeText, /runtime-capabilities/);
        assert.match(skillText, /不触发上游探测或图片生成/);
        assert.match(apiReference, /不触发上游探测或图片生成/);
        assert.match(skillText, /state_initialized=false/);
        assert.match(apiReference, /state_initialized=false/);
        assert.match(skillText, /不替代页面/);
        assert.match(skillText, /runtime-capabilities/);
        assert.match(apiReference, /不替代页面/);
        assert.match(apiReference, /runtime-capabilities/);
        assert.match(openApiSource, /AgentChannelHealthDiagnosticsResponse/);
        assert.match(openApiSource, /不会触发上游探测或图片生成/);
    });
});

function runSkillScript(filename, args, env = {}, options = {}) {
    const baseEnv = buildIsolatedSkillScriptEnv({ loadPrivateAgentEnv: options.loadPrivateAgentEnv });
    if (options.createCwd) mkdirSync(options.cwd, { recursive: true });
    return spawnSync(process.execPath, [join(skillScriptsRoot, filename), ...args], {
        cwd: options.cwd || repoRoot,
        encoding: 'utf8',
        env: { ...baseEnv, ...env },
        ...(options.input !== undefined ? { input: options.input } : {})
    });
}

function buildIsolatedSkillScriptEnv(options = {}) {
    const keepNames = ['HOME', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE'];
    const isolated = {};
    for (const name of keepNames) {
        if (process.env[name] !== undefined) isolated[name] = process.env[name];
    }
    if (!options.loadPrivateAgentEnv) isolated.GPT_IMAGE_AGENT_LOAD_ENV_FILE = '0';
    return isolated;
}

function listTextFiles(root) {
    const result = [];
    for (const name of readdirSync(root)) {
        const filePath = join(root, name);
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
            result.push(...listTextFiles(filePath));
        } else if (/\.(md|mjs|yaml)$/.test(name)) {
            result.push(filePath);
        }
    }
    return result;
}

function runSkillScriptAsync(filename, args, env = {}, options = {}) {
    return new Promise((resolve) => {
        const baseEnv = buildIsolatedSkillScriptEnv({ loadPrivateAgentEnv: options.loadPrivateAgentEnv });
        const child = spawn(process.execPath, [join(skillScriptsRoot, filename), ...args], {
            cwd: repoRoot,
            env: { ...baseEnv, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = options.timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  child.kill('SIGTERM');
              }, options.timeoutMs)
            : undefined;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('close', (status, signal) => {
            if (timeout) clearTimeout(timeout);
            resolve({ status, signal, stdout, stderr, timedOut });
        });
    });
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

async function waitWithTimeout(promise, timeoutMs, message) {
    let timeout;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeout);
    }
}

async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        assert.equal(typeof address, 'object');
        assert.ok(address);
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function readRequestText(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
        });
        request.on('end', () => {
            resolve(body);
        });
        request.on('error', reject);
    });
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serverOrigin(request) {
    return `http://${request.headers.host}`;
}

function fakePngBuffer(width, height) {
    const buffer = Buffer.alloc(24);
    buffer[0] = 0x89;
    buffer.write('PNG', 1, 'ascii');
    buffer[4] = 0x0d;
    buffer[5] = 0x0a;
    buffer[6] = 0x1a;
    buffer[7] = 0x0a;
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function fakePngBase64(width, height) {
    return fakePngBuffer(width, height).toString('base64');
}

function validPngBuffer() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64'
    );
}
