import { internals } from '../lib/index.js';
import { BASE_URL, CAPABILITIES, json, mockFetch, withEnv } from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const {
    assertGenerateWithinCapabilities,
    authHeaders,
    createClient,
    intersectRanges,
    readNumericRange,
    readUploadLimits,
    requireIdempotencyKey,
    resolveBaseUrl,
    resolveSameOriginUrl,
    stripInlineImages,
    VisualJournalError
} = internals;

test('base URL comes only from config or environment and stays credential-free', async () => {
    assert.equal(resolveBaseUrl('https://host.example/playground/'), 'https://host.example/playground');
    assert.equal(resolveBaseUrl('http://127.0.0.1:4783'), 'http://127.0.0.1:4783');
    assert.equal(resolveBaseUrl('http://[::1]:4783'), 'http://[::1]:4783');
    assert.throws(() => resolveBaseUrl('http://remote.example'), /HTTPS/);
    assert.throws(() => resolveBaseUrl('https://user:pass@host.example'), /无凭据/);
    assert.throws(() => resolveBaseUrl('https://host.example/?x=1'), /无查询参数/);
    await withEnv({ GPT_IMAGE_PLAYGROUND_URL: 'https://env.example' }, () => {
        assert.equal(resolveBaseUrl(undefined), 'https://env.example');
    });
    await withEnv({ GPT_IMAGE_PLAYGROUND_URL: undefined }, () => {
        assert.equal(resolveBaseUrl(undefined), 'http://localhost:4783');
    });
});

test('auth prefers the server token, then the legacy token, then the password hash', () => {
    assert.deepEqual(authHeaders({ AGENT_API_TOKEN: 'a', GPT_IMAGE_AGENT_TOKEN: 'b' }), { Authorization: 'Bearer a' });
    assert.deepEqual(authHeaders({ GPT_IMAGE_AGENT_TOKEN: 'b' }), { Authorization: 'Bearer b' });
    assert.deepEqual(authHeaders({ GPT_IMAGE_APP_PASSWORD_HASH: 'h' }), { 'X-App-Password-Hash': 'h' });
    assert.deepEqual(authHeaders({}), {});
});

test('idempotency keys are required, bounded, and printable', () => {
    assert.equal(requireIdempotencyKey(' key-1 '), 'key-1');
    assert.throws(() => requireIdempotencyKey(''), /必须提供/);
    assert.throws(() => requireIdempotencyKey('x'.repeat(201)), /200/);
    assert.throws(() => requireIdempotencyKey('a\nb'), /控制字符/);
});

test('server URLs are resolved against the configured origin and path prefix', () => {
    assert.equal(
        resolveSameOriginUrl('https://host.example/playground', '/api/agent/jobs/j/result'),
        'https://host.example/playground/api/agent/jobs/j/result'
    );
    assert.equal(
        resolveSameOriginUrl('https://host.example/playground', '/playground/api/x'),
        'https://host.example/playground/api/x'
    );
    assert.throws(() => resolveSameOriginUrl('https://host.example', 'https://evil.example/x'), /不同 origin/);
    assert.throws(() => resolveSameOriginUrl('https://host.example', '//evil.example/x'), /不同 origin/);
});

test('numeric ranges validate structure and intersect with allowedValues', () => {
    assert.deepEqual(readNumericRange({ min: 1, max: 4 }, 'r'), { min: 1, max: 4 });
    assert.throws(() => readNumericRange({ min: 3, max: 1 }, 'r'), /整数范围/);
    assert.throws(() => readNumericRange({ min: 1, max: 4, allowedValues: [] }, 'r'), /非空/);
    assert.throws(() => readNumericRange({ min: 1, max: 4, allowedValues: [1.5] }, 'r'), /整数/);
    assert.deepEqual(intersectRanges({ min: 0, max: 3 }, { min: 1, max: 3, allowedValues: [1, 3] }, 'r'), {
        min: 1,
        max: 3,
        allowedValues: [1, 3]
    });
    assert.throws(() => intersectRanges({ min: 0, max: 1 }, { min: 2, max: 3 }, 'r'), /不相交/);
});

test('generate preflight checks only requested fields against general and backend ranges', () => {
    assert.doesNotThrow(() => assertGenerateWithinCapabilities({ prompt: 'p' }, CAPABILITIES));
    assert.doesNotThrow(() => assertGenerateWithinCapabilities({ n: 4 }, CAPABILITIES));
    assert.throws(() => assertGenerateWithinCapabilities({ n: 5 }, CAPABILITIES), /n 必须在 1 到 4/);
    assert.throws(
        () => assertGenerateWithinCapabilities({ n: 2, image_backend: 'responses-image-generation' }, CAPABILITIES),
        /n 必须在 1 到 1/
    );
    assert.throws(
        () =>
            assertGenerateWithinCapabilities(
                { partial_images: 2, image_backend: 'responses-image-generation' },
                CAPABILITIES
            ),
        /partial_images 只能是 1、3/
    );
    assert.throws(
        () => assertGenerateWithinCapabilities({ n: 1, image_backend: 'unknown-backend' }, CAPABILITIES),
        /未声明 image_backend=unknown-backend/
    );
    assert.throws(() => assertGenerateWithinCapabilities({ n: 1 }, { limits: {} }), /limits.generate_images/);
});

test('upload limits convert megabytes and default the total budget', () => {
    assert.deepEqual(readUploadLimits(CAPABILITIES), {
        maxFiles: 2,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: Math.floor(1.5 * 1024 * 1024)
    });
    const withoutTotal = { limits: { ...CAPABILITIES.limits, max_total_upload_mb: undefined } };
    assert.equal(readUploadLimits(withoutTotal).maxTotalBytes, 2 * 1024 * 1024);
});

test('inline base64 never survives into tool output', () => {
    const cleaned = stripInlineImages({ images: [{ id: 'a', b64_json: 'AAAA', content_url: '/c' }] });
    assert.deepEqual(cleaned.images, [{ id: 'a', content_url: '/c' }]);
});

test('a transport failure reaches the model as network/retryable, not a bare fetch error', async () => {
    // skill.js tells the model to branch on code/retryable instead of parsing
    // message text, so an unreachable service must not surface `fetch failed`.
    const original = globalThis.fetch;
    const failure = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    globalThis.fetch = async () => {
        throw failure;
    };
    try {
        const client = createClient({ baseUrl: BASE_URL, timeoutMs: 1000, signal: new AbortController().signal });
        await assert.rejects(client.request('/api/agent/capabilities'), (error) => {
            assert.ok(error instanceof VisualJournalError);
            assert.equal(error.code, 'network');
            assert.equal(error.retryable, true);
            assert.match(error.message, /ECONNREFUSED/);
            assert.doesNotMatch(error.message, /^fetch failed$/);
            return true;
        });
    } finally {
        globalThis.fetch = original;
    }
});

test('the caller\'s own cancellation is rethrown untouched', async () => {
    const abort = new AbortController();
    abort.abort();
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new DOMException('aborted', 'AbortError');
    };
    try {
        const client = createClient({ baseUrl: BASE_URL, timeoutMs: 1000, signal: abort.signal });
        await assert.rejects(client.request('/api/agent/capabilities'), (error) => {
            assert.notEqual(error.code, 'network');
            return true;
        });
    } finally {
        globalThis.fetch = original;
    }
});

test('service errors expose code, retryable, and Retry-After without parsing message text', async () => {
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(
            { error: { code: 'rate_limited', message: 'slow down', retryable: true } },
            429,
            { 'retry-after': '7' }
        )
    });
    try {
        const client = createClient({ baseUrl: BASE_URL, timeoutMs: 1000, signal: new AbortController().signal });
        await assert.rejects(client.request('/api/agent/capabilities'), (error) => {
            assert.ok(error instanceof VisualJournalError);
            assert.equal(error.code, 'rate_limited');
            assert.equal(error.status, 429);
            assert.equal(error.retryable, true);
            assert.equal(error.retryAfterSeconds, 7);
            assert.match(error.message, /code=rate_limited, retryable=true, retry_after_seconds=7/);
            return true;
        });
    } finally {
        fetchMock.restore();
    }
});

test('job polling honors Retry-After and shares one deadline', async () => {
    const fetchMock = mockFetch({
        'GET /api/agent/jobs/job-1/result': [
            json({ error: { code: 'request_in_progress', retryable: true } }, 409, { 'retry-after': '1' }),
            json({ request_id: 'r1', images: [] })
        ]
    });
    try {
        const client = createClient({ baseUrl: BASE_URL, timeoutMs: 5000, signal: new AbortController().signal });
        const result = await client.waitForJob({ id: 'job-1', retry_after_seconds: 1 });
        assert.equal(result.request_id, 'r1');
        assert.equal(fetchMock.calls.length, 2);

        const short = createClient({ baseUrl: BASE_URL, timeoutMs: 30, signal: new AbortController().signal });
        fetchMock.calls.length = 0;
        const stuck = mockFetch({
            'GET /api/agent/jobs/job-2/result': json({ error: { code: 'request_in_progress', retryable: true } }, 409, {
                'retry-after': '1'
            })
        });
        try {
            await assert.rejects(short.waitForJob({ id: 'job-2' }), (error) => error.code === 'deadline');
        } finally {
            stuck.restore();
        }
    } finally {
        fetchMock.restore();
    }
});

test('job polling refuses a result URL on another origin before sending credentials', async () => {
    const fetchMock = mockFetch({});
    try {
        const client = createClient({ baseUrl: BASE_URL, timeoutMs: 1000, signal: new AbortController().signal });
        await assert.rejects(client.waitForJob({ id: 'j', result_url: 'https://evil.example/r' }), /不同 origin/);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        fetchMock.restore();
    }
});
