import { apply, Config, internals } from '../lib/index.js';
import z from '@deepseek-ai/schemastery';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function registerTools(timeoutMs = 1000, baseUrl = 'http://localhost:4783') {
    const tools = new Map();
    const config = { baseUrl };
    if (timeoutMs !== null) config.timeoutMs = timeoutMs;
    apply(
        {
            tools: {
                register(definition) {
                    tools.set(definition.name, definition);
                    return () => tools.delete(definition.name);
                }
            }
        },
        config
    );
    return tools;
}

test('uses the server job lifetime as the default tool timeout', () => {
    const tools = registerTools(null);
    assert.equal(internals.DEFAULT_TIMEOUT_MS, 900_000);
    assert.equal(tools.get('visual_journal_generate').timeoutMs, 900_000);
});

test('registers the three Visual Journal tools with strict billable guardrails', () => {
    const tools = registerTools();
    assert.deepEqual(
        [...tools.keys()],
        ['visual_journal_capabilities', 'visual_journal_generate', 'visual_journal_diagnose']
    );
    assert.equal(tools.get('visual_journal_generate').parameters.properties.allow_billable.type, 'boolean');
    assert.equal(Object.hasOwn(tools.get('visual_journal_generate').parameters.properties, 'base_url'), false);
    assert.equal(Object.hasOwn(tools.get('visual_journal_diagnose').parameters.properties, 'base_url'), false);
    assert.equal(typeof tools.get('visual_journal_generate').output.render, 'function');
    assert.deepEqual(tools.get('visual_journal_generate').output.schema, {});
});

test('dry-run never calls fetch and keeps the request body explicit', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error('fetch must not run for dry-run');
    };
    try {
        const result = await generate.execute(
            { prompt: 'test prompt', output_compression: 80 },
            { signal: new AbortController().signal }
        );
        assert.equal(called, false);
        assert.equal(result.dry_run, true);
        assert.equal(result.billable, false);
        assert.deepEqual(result.request, { prompt: 'test prompt', output_compression: 80 });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('allows billable requests when the service has no auth configured', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AGENT_API_TOKEN;
    const originalClientToken = process.env.GPT_IMAGE_AGENT_TOKEN;
    const originalPasswordHash = process.env.GPT_IMAGE_APP_PASSWORD_HASH;
    let requestHeaders;
    delete process.env.AGENT_API_TOKEN;
    delete process.env.GPT_IMAGE_AGENT_TOKEN;
    delete process.env.GPT_IMAGE_APP_PASSWORD_HASH;
    let callCount = 0;
    globalThis.fetch = async (_input, init) => {
        callCount += 1;
        requestHeaders = new Headers(init?.headers);
        if (callCount === 1) {
            return new Response(
                JSON.stringify({ job: { id: 'job-auth', result_url: '/api/agent/jobs/job-auth/result' } }),
                {
                    status: 202
                }
            );
        }
        return new Response(JSON.stringify({ request_id: 'request-auth', images: [] }), { status: 200 });
    };
    try {
        const result = await generate.execute(
            { prompt: 'test prompt', allow_billable: true, idempotency_key: 'test-key' },
            { signal: new AbortController().signal }
        );
        assert.equal(result.response.request_id, 'request-auth');
        assert.equal(requestHeaders.has('authorization'), false);
        assert.equal(requestHeaders.has('x-app-password-hash'), false);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.AGENT_API_TOKEN;
        else process.env.AGENT_API_TOKEN = originalToken;
        if (originalClientToken === undefined) delete process.env.GPT_IMAGE_AGENT_TOKEN;
        else process.env.GPT_IMAGE_AGENT_TOKEN = originalClientToken;
        if (originalPasswordHash === undefined) delete process.env.GPT_IMAGE_APP_PASSWORD_HASH;
        else process.env.GPT_IMAGE_APP_PASSWORD_HASH = originalPasswordHash;
    }
});

test('prefers the canonical server Agent token when both token variables are set', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    const originalAgentToken = process.env.AGENT_API_TOKEN;
    const originalClientToken = process.env.GPT_IMAGE_AGENT_TOKEN;
    let requestHeaders;
    process.env.AGENT_API_TOKEN = 'server-token';
    process.env.GPT_IMAGE_AGENT_TOKEN = 'legacy-token';
    globalThis.fetch = async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ request_id: 'request-token-precedence', images: [] }), { status: 200 });
    };
    try {
        const result = await generate.execute(
            { prompt: 'test prompt', allow_billable: true, idempotency_key: 'token-precedence-key' },
            { signal: new AbortController().signal }
        );
        assert.equal(result.response.request_id, 'request-token-precedence');
        assert.equal(requestHeaders.get('authorization'), 'Bearer server-token');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalAgentToken === undefined) delete process.env.AGENT_API_TOKEN;
        else process.env.AGENT_API_TOKEN = originalAgentToken;
        if (originalClientToken === undefined) delete process.env.GPT_IMAGE_AGENT_TOKEN;
        else process.env.GPT_IMAGE_AGENT_TOKEN = originalClientToken;
    }
});

test('polls an orchestrated job until the final image response is ready', async () => {
    const tools = registerTools(3000);
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        if (calls.length === 1) {
            return new Response(JSON.stringify({ job: { id: 'job-1', retry_after_seconds: 0, result_url: '' } }), {
                status: 202
            });
        }
        if (calls.length === 2) {
            return new Response(
                JSON.stringify({ error: { code: 'request_in_progress', retryable: true, message: 'running' } }),
                { status: 409, headers: { 'Retry-After': '0' } }
            );
        }
        return new Response(JSON.stringify({ request_id: 'request-1', images: [{ url: '/artifacts/1' }] }), {
            status: 200
        });
    };
    try {
        const result = await generate.execute(
            { prompt: 'test prompt', allow_billable: true, idempotency_key: 'test-key' },
            { signal: new AbortController().signal }
        );
        assert.equal(result.billable, true);
        assert.equal(result.job_id, 'job-1');
        assert.equal(result.response.request_id, 'request-1');
        assert.deepEqual(
            calls.map((call) => call.method),
            ['POST', 'GET', 'GET']
        );
        assert.deepEqual(
            calls.map((call) => call.url),
            [
                'http://localhost:4783/api/agent/image-requests',
                'http://localhost:4783/api/agent/jobs/job-1/result',
                'http://localhost:4783/api/agent/jobs/job-1/result'
            ]
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('keeps the deployment path prefix when polling a root-relative job URL', async () => {
    const tools = registerTools(3000, 'https://host.example/playground');
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        if (calls.length === 1) {
            return new Response(
                JSON.stringify({ job: { id: 'job-prefix', result_url: '/api/agent/jobs/job-prefix/result' } }),
                {
                    status: 202
                }
            );
        }
        return new Response(JSON.stringify({ request_id: 'request-prefix', images: [] }), { status: 200 });
    };
    try {
        const result = await generate.execute(
            { prompt: 'test prompt', allow_billable: true, idempotency_key: 'prefix-key' },
            { signal: new AbortController().signal }
        );
        assert.equal(result.response.request_id, 'request-prefix');
        assert.deepEqual(
            calls.map((call) => call.url),
            [
                'https://host.example/playground/api/agent/image-requests',
                'https://host.example/playground/api/agent/jobs/job-prefix/result'
            ]
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('uses one deadline across job creation and result polling', async () => {
    const tools = registerTools(30);
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async (_input, init) => {
        callCount += 1;
        if (callCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return new Response(JSON.stringify({ job: { id: 'job-deadline', result_url: '' } }), { status: 202 });
        }
        return new Response(
            JSON.stringify({ error: { code: 'request_in_progress', retryable: true, message: 'running' } }),
            { status: 409 }
        );
    };
    try {
        await assert.rejects(
            generate.execute(
                { prompt: 'test prompt', allow_billable: true, idempotency_key: 'deadline-key' },
                { signal: new AbortController().signal }
            ),
            /超时/
        );
        assert.equal(callCount, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('rejects a job result URL on another origin before sending credentials', () => {
    assert.throws(
        () => internals.resolveSameOriginUrl('http://localhost:4783', 'https://attacker.example/result'),
        /不同 origin/
    );
});

test('normalizes configured base URLs and rejects malformed idempotency keys', () => {
    assert.equal(internals.resolveBaseUrl('http://localhost:4783///'), 'http://localhost:4783');
    assert.equal(internals.resolveBaseUrl('http://127.0.0.1:4783'), 'http://127.0.0.1:4783');
    assert.equal(internals.resolveBaseUrl('http://[::1]:4783'), 'http://[::1]:4783');
    assert.equal(internals.resolveBaseUrl('http://[::ffff:7f00:1]:4783'), 'http://[::ffff:7f00:1]:4783');
    assert.throws(
        () => internals.resolveBaseUrl('http://[::ffff:0:7f00:1]:4783'),
        /HTTP 时仅允许 localhost 或回环地址/
    );
    assert.throws(() => internals.resolveBaseUrl('http://[::7f00:1]:4783'), /HTTP 时仅允许 localhost 或回环地址/);
    assert.throws(
        () => internals.resolveBaseUrl('http://remote.example/workbench'),
        /HTTP 时仅允许 localhost 或回环地址/
    );
    assert.throws(() => internals.requireIdempotencyKey('valid\nkey'), /idempotency_key 不能包含控制字符/);
});

test('uses the environment service URL when profile config leaves baseUrl unset', () => {
    const original = process.env.GPT_IMAGE_PLAYGROUND_URL;
    process.env.GPT_IMAGE_PLAYGROUND_URL = 'https://journal.example/workbench///';
    try {
        assert.equal(internals.resolveBaseUrl(undefined), 'https://journal.example/workbench');
    } finally {
        if (original === undefined) delete process.env.GPT_IMAGE_PLAYGROUND_URL;
        else process.env.GPT_IMAGE_PLAYGROUND_URL = original;
    }
});

test('allows the bundled empty profile config to resolve without a base URL', () => {
    const [resolved] = z.resolve({}, Config);
    assert.equal(resolved.baseUrl, undefined);
});

test('ships a standard YAML patch without executable tags', () => {
    const patch = fs.readFileSync(path.join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8');
    const parsed = yaml.load(patch);
    assert.deepEqual(parsed, [
        {
            insert: [
                {
                    id: 'visual-journal-dsh-plugin',
                    name: '@visual-journal/dsh-plugin',
                    config: {}
                }
            ]
        }
    ]);
});

test('rejects an accepted response that has neither a job nor a final response', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ accepted: true }), { status: 202 });
    try {
        await assert.rejects(
            generate.execute(
                { prompt: 'test prompt', allow_billable: true, idempotency_key: 'test-key' },
                { signal: new AbortController().signal }
            ),
            /创建 job 的响应缺少 job/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('tool arguments cannot redirect requests away from the configured service', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AGENT_API_TOKEN;
    const urls = [];
    process.env.AGENT_API_TOKEN = 'test-token';
    globalThis.fetch = async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ request_id: 'request-redirect-guard', images: [] }), { status: 200 });
    };
    try {
        await generate.execute(
            {
                prompt: 'test prompt',
                allow_billable: true,
                idempotency_key: 'test-key',
                base_url: 'https://attacker.example'
            },
            { signal: new AbortController().signal }
        );
        assert.deepEqual(urls, ['http://localhost:4783/api/agent/image-requests']);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.AGENT_API_TOKEN;
        else process.env.AGENT_API_TOKEN = originalToken;
    }
});

test('billable execution requires an explicit idempotency key', async () => {
    const tools = registerTools();
    const generate = tools.get('visual_journal_generate');
    await assert.rejects(
        generate.execute({ prompt: 'test prompt', allow_billable: true }, { signal: new AbortController().signal }),
        /必须提供 idempotency_key/
    );
});

test('diagnostics requires exactly one lookup key', () => {
    assert.throws(() => internals.resolveDiagnosticLookup({}), /必须提供 request_id 或 idempotency_key/);
    assert.throws(() => internals.resolveDiagnosticLookup({ request_id: 'a', idempotency_key: 'b' }), /只能提供一个/);
    assert.deepEqual(internals.resolveDiagnosticLookup({ idempotency_key: 'key-1' }), {
        type: 'idempotency_key',
        value: 'key-1'
    });
});

test('diagnostics reports a missing request without converting the service contract into an error', async () => {
    const tools = registerTools();
    const diagnose = tools.get('visual_journal_diagnose');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ found: false }), { status: 404 });
    try {
        for (const args of [{ idempotency_key: 'missing-key' }, { request_id: 'missing-request' }]) {
            const result = await diagnose.execute(args, { signal: new AbortController().signal });
            assert.equal(result.ok, true);
            assert.equal(result.billable, false);
            assert.deepEqual(result.response, { found: false });
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('non-diagnostic requests still reject a 404 found-false response', async () => {
    const tools = registerTools();
    const capabilities = tools.get('visual_journal_capabilities');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ found: false }), { status: 404 });
    try {
        await assert.rejects(
            capabilities.execute({}, { signal: new AbortController().signal }),
            /请求失败，状态码 404/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
