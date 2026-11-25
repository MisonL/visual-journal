import { internals } from '../lib/index.js';
import {
    attachmentStore,
    CAPABILITIES,
    createContext,
    exec,
    imageAgent,
    json,
    memoryFs,
    mockFetch,
    withEnv
} from './helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { TOOL_NAMES, resolveDiagnosticTarget } = internals;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const finalResponse = (requestId, artifactId = 'art-1') => ({
    request_id: requestId,
    cached: false,
    images: [
        {
            id: artifactId,
            filename: `${artifactId}.png`,
            mime_type: 'image/png',
            content_url: `/api/agent/artifacts/${artifactId}/content`
        }
    ]
});

test('registers six tools; edit only appears with a Session filesystem', () => {
    const withoutFs = createContext();
    assert.deepEqual(
        [...withoutFs.tools.keys()],
        [TOOL_NAMES.capabilities, TOOL_NAMES.generate, TOOL_NAMES.batch, TOOL_NAMES.artifact, TOOL_NAMES.diagnose]
    );
    const withFs = createContext({ services: { fs: memoryFs({}), workingDirectory: {} } });
    assert.ok(withFs.tools.has(TOOL_NAMES.edit));
    for (const tool of withFs.tools.values()) {
        assert.equal(Object.hasOwn(tool.parameters.properties, 'base_url'), false, `${tool.name} exposes base_url`);
    }
});

test('billable tools serialize while read-only tools may overlap', () => {
    const { tools } = createContext({ services: { fs: memoryFs({}), workingDirectory: {} } });
    assert.equal(tools.get(TOOL_NAMES.generate).isConcurrencySafe, undefined);
    assert.equal(tools.get(TOOL_NAMES.edit).isConcurrencySafe, undefined);
    assert.equal(tools.get(TOOL_NAMES.batch).isConcurrencySafe, undefined);
    assert.equal(tools.get(TOOL_NAMES.capabilities).isConcurrencySafe({}), true);
    assert.equal(tools.get(TOOL_NAMES.artifact).isConcurrencySafe({ artifact_id: 'a', action: 'share' }), false);
    assert.equal(tools.get(TOOL_NAMES.artifact).isConcurrencySafe({ artifact_id: 'a', action: 'metadata' }), true);
});

test('read tools use a short budget while billable tools keep the job lifetime', () => {
    const { tools } = createContext();
    assert.equal(tools.get(TOOL_NAMES.capabilities).timeoutMs, 60_000);
    assert.equal(tools.get(TOOL_NAMES.generate).timeoutMs, 900_000);
});

test('the runtime skill carries the operating rules', () => {
    const { skills } = createContext();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'visual-journal-image-workflow');
    for (const rule of ['allow_billable=true', 'idempotency_key', 'channel_health=true', 'retryable=false']) {
        assert.ok(skills[0].content.includes(rule), `skill misses ${rule}`);
    }
});

test('approval gate asks only for billable or sharing calls and never overrides a denial', async () => {
    const { listeners } = createContext();
    const gate = listeners.get('tools/pre-execute');
    const allow = async () => ({ kind: 'allow' });
    assert.deepEqual(await gate({ name: TOOL_NAMES.generate, arguments: { prompt: 'p' } }, allow), { kind: 'allow' });
    const ask = await gate(
        { name: TOOL_NAMES.generate, arguments: { prompt: 'p', allow_billable: true, idempotency_key: 'k' } },
        allow
    );
    assert.equal(ask.kind, 'ask');
    assert.match(ask.reason, /1 个计费图片生成请求.*idempotency_key=k/);
    assert.ok(ask.displayReason.en);
    const batch = await gate(
        { name: TOOL_NAMES.batch, arguments: { allow_billable: true, idempotency_key: 'b', items: [{}, {}, {}] } },
        allow
    );
    assert.match(batch.reason, /3 个计费图片批量请求/);
    assert.equal(
        (await gate({ name: TOOL_NAMES.artifact, arguments: { action: 'share', artifact_id: 'a' } }, allow)).kind,
        'ask'
    );
    assert.equal((await gate({ name: TOOL_NAMES.artifact, arguments: { artifact_id: 'a' } }, allow)).kind, 'allow');
    assert.equal((await gate({ name: 'bash', arguments: {} }, allow)).kind, 'allow');
    const denied = await gate({ name: TOOL_NAMES.generate, arguments: { allow_billable: true } }, async () => ({
        kind: 'deny',
        reason: 'policy'
    }));
    assert.deepEqual(denied, { kind: 'deny', reason: 'policy' });
});

test('approval can be turned off for unattended profiles', () => {
    const { listeners } = createContext({ config: { approval: 'off' } });
    assert.equal(listeners.has('tools/pre-execute'), false);
});

test('generate dry-run sends nothing and drops server-owned transport controls', async () => {
    const { tools } = createContext();
    const fetchMock = mockFetch({});
    try {
        const result = await tools
            .get(TOOL_NAMES.generate)
            .execute({ prompt: 'cat', n: 2, stream_mode: 'stream', force_request: true }, exec());
        assert.equal(fetchMock.calls.length, 0);
        assert.equal(result.dry_run, true);
        assert.equal(result.billable, false);
        assert.deepEqual(result.request, { prompt: 'cat', n: 2 });
    } finally {
        fetchMock.restore();
    }
});

test('generate validates capabilities before the billable POST', async () => {
    const { tools } = createContext();
    const fetchMock = mockFetch({ 'GET /api/agent/capabilities': json(CAPABILITIES) });
    try {
        await assert.rejects(
            tools
                .get(TOOL_NAMES.generate)
                .execute({ prompt: 'p', n: 9, allow_billable: true, idempotency_key: 'k' }, exec()),
            /n 必须在 1 到 4/
        );
        assert.deepEqual(
            fetchMock.calls.map((call) => `${call.method} ${call.path}`),
            ['GET /api/agent/capabilities']
        );
        await assert.rejects(
            tools.get(TOOL_NAMES.generate).execute({ prompt: 'p', allow_billable: true }, exec()),
            /必须提供 idempotency_key/
        );
    } finally {
        fetchMock.restore();
    }
});

test('generate submits once, polls the job, and returns artifacts as image attachments', async () => {
    const store = attachmentStore();
    const { agent, llm } = imageAgent();
    const { tools } = createContext({ services: { attachments: store, llm } });
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/image-requests': json({ job: { id: 'job-1', retry_after_seconds: 1 } }, 202),
        'GET /api/agent/jobs/job-1/result': json(finalResponse('req-1')),
        'GET /api/agent/artifacts/art-1/content': new Response(PNG, { headers: { 'content-type': 'image/png' } })
    });
    try {
        await withEnv({ AGENT_API_TOKEN: 'secret' }, async () => {
            const tool = tools.get(TOOL_NAMES.generate);
            const result = await tool.execute(
                { prompt: 'p', allow_billable: true, idempotency_key: 'k' },
                exec({ agent })
            );
            assert.deepEqual(
                fetchMock.calls.map((call) => `${call.method} ${call.path}`),
                [
                    'GET /api/agent/capabilities',
                    'POST /api/agent/image-requests',
                    'GET /api/agent/jobs/job-1/result',
                    'GET /api/agent/artifacts/art-1/content'
                ]
            );
            const post = fetchMock.calls[1];
            assert.equal(post.headers['Idempotency-Key'], 'k');
            assert.equal(post.headers.Authorization, 'Bearer secret');
            assert.deepEqual(JSON.parse(post.body), { prompt: 'p' });
            assert.equal(result.job_id, 'job-1');
            assert.equal(result.response.request_id, 'req-1');
            assert.equal(store.saved.length, 1);
            assert.equal(store.saved[0].mediaType, 'image/png');

            const blocks = tool.output.render({}, result);
            assert.equal(blocks[0].type, 'text');
            assert.deepEqual(blocks[1], {
                type: 'image',
                attachment: {
                    attachmentId: 'att-1',
                    mediaType: 'image/png',
                    bytes: PNG.byteLength,
                    width: 8,
                    height: 8,
                    name: 'art-1.png'
                }
            });
            assert.doesNotMatch(blocks[0].text, /secret/);
        });
    } finally {
        fetchMock.restore();
    }
});

test('image attachment is skipped, not failed, when the route cannot take images', async () => {
    const store = attachmentStore();
    const { agent, llm } = imageAgent(['text']);
    const { tools } = createContext({ services: { attachments: store, llm } });
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/image-requests': json(finalResponse('req-2'))
    });
    try {
        const result = await tools
            .get(TOOL_NAMES.generate)
            .execute({ prompt: 'p', allow_billable: true, idempotency_key: 'k' }, exec({ agent }));
        assert.equal(result.attachments.skipped_reason, 'model_without_image_input');
        assert.equal(store.saved.length, 0);
        assert.equal(
            fetchMock.calls.some((call) => call.path.endsWith('/content')),
            false
        );
    } finally {
        fetchMock.restore();
    }
});

test('generate surfaces a terminal failure with its structured code', async () => {
    const { tools } = createContext();
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/image-requests': json(
            { error: { code: 'idempotency_failed', message: 'replayed failure', retryable: false } },
            409
        )
    });
    try {
        await assert.rejects(
            tools.get(TOOL_NAMES.generate).execute({ prompt: 'p', allow_billable: true, idempotency_key: 'k' }, exec()),
            (error) => error.code === 'idempotency_failed' && error.retryable === false
        );
    } finally {
        fetchMock.restore();
    }
});

const editServices = (files) => ({ fs: memoryFs(files), workingDirectory: { ensure: async () => '/workspace' } });

test('edit dry-run inspects sources without reading bytes or calling the service', async () => {
    const files = { 'in.png': { data: PNG }, 'mask.png': { data: PNG } };
    const { tools } = createContext({ services: editServices(files) });
    const fetchMock = mockFetch({});
    try {
        const result = await tools
            .get(TOOL_NAMES.edit)
            .execute({ prompt: 'p', image_paths: ['in.png'], mask_path: 'mask.png' }, exec());
        assert.equal(fetchMock.calls.length, 0);
        assert.deepEqual(result.sources.images, [
            { field: 'image_0', name: 'in.png', media_type: 'image/png', size_bytes: 8 }
        ]);
        assert.equal(result.sources.mask.field, 'mask');
    } finally {
        fetchMock.restore();
    }
});

test('edit rejects symlinks, unsupported types, non-PNG masks, and missing files', async () => {
    const files = {
        'link.png': { type: 'symlink' },
        'doc.gif': { data: PNG },
        'in.png': { data: PNG },
        'mask.jpg': { data: PNG }
    };
    const { tools } = createContext({ services: editServices(files) });
    const edit = tools.get(TOOL_NAMES.edit);
    await assert.rejects(edit.execute({ prompt: 'p', image_paths: ['link.png'] }, exec()), /符号链接/);
    await assert.rejects(edit.execute({ prompt: 'p', image_paths: ['doc.gif'] }, exec()), /PNG、JPEG 或 WebP/);
    await assert.rejects(
        edit.execute({ prompt: 'p', image_paths: ['in.png'], mask_path: 'mask.jpg' }, exec()),
        /mask.*PNG/
    );
    await assert.rejects(edit.execute({ prompt: 'p', image_paths: ['gone.png'] }, exec()), /不存在/);
});

test('edit uploads multipart sources within capability limits', async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    const files = { 'a.png': { data: PNG }, 'b.webp': { data: PNG }, 'c.png': { data: PNG }, 'big.png': { data: big } };
    const { tools } = createContext({ services: editServices(files) });
    const edit = tools.get(TOOL_NAMES.edit);
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/images/edit': json(finalResponse('req-e'))
    });
    try {
        const args = { prompt: 'p', n: 1, allow_billable: true, idempotency_key: 'ek' };
        await assert.rejects(edit.execute({ ...args, image_paths: ['a.png', 'b.webp', 'c.png'] }, exec()), /最多 2 张/);
        await assert.rejects(edit.execute({ ...args, image_paths: ['big.png'] }, exec()), /超过单图上限/);

        const result = await edit.execute({ ...args, image_paths: ['a.png', 'b.webp'] }, exec());
        const post = fetchMock.calls.find((call) => call.method === 'POST');
        assert.ok(post.body instanceof FormData);
        assert.equal(post.body.get('prompt'), 'p');
        assert.equal(post.body.get('n'), '1');
        assert.equal(post.body.get('image_0').name, 'a.png');
        assert.equal(post.body.get('image_1').type, 'image/webp');
        assert.equal(post.headers['Content-Type'], undefined);
        assert.equal(post.headers['Idempotency-Key'], 'ek');
        assert.deepEqual(
            result.sources.map((source) => source.name),
            ['a.png', 'b.webp']
        );
        assert.doesNotMatch(JSON.stringify(result), /\/workspace/);
    } finally {
        fetchMock.restore();
    }
});

test('batch runs items serially with derived keys and isolates failures', async () => {
    const { tools } = createContext();
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/image-requests': ({ init }) =>
            init.headers['Idempotency-Key'] === 'b:1'
                ? json({ error: { code: 'upstream_error', message: 'boom', retryable: false } }, 502)
                : json(
                      finalResponse(`req-${init.headers['Idempotency-Key']}`, `art-${init.headers['Idempotency-Key']}`)
                  )
    });
    try {
        const result = await tools.get(TOOL_NAMES.batch).execute(
            {
                items: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c', idempotency_key: 'own' }],
                allow_billable: true,
                idempotency_key: 'b'
            },
            exec()
        );
        assert.equal(fetchMock.calls.filter((call) => call.path === '/api/agent/capabilities').length, 1);
        assert.deepEqual(
            result.items.map((item) => [item.idempotency_key, item.status]),
            [
                ['b:0', 'succeeded'],
                ['b:1', 'failed'],
                ['own', 'succeeded']
            ]
        );
        assert.equal(result.items[1].error.code, 'upstream_error');
        assert.equal(result.items[1].error.retryable, false);
        assert.deepEqual(result.summary, {
            total: 3,
            succeeded: 2,
            failed: 1,
            not_started: 0,
            replayed: 0,
            billable: 2
        });
        assert.equal(result.ok, false);
        assert.match(result.next_action, /新的 idempotency_key/);
    } finally {
        fetchMock.restore();
    }
});

test('batch enforces its bounds and dry-runs without network', async () => {
    const { tools } = createContext({ config: { maxBatchItems: 2 } });
    const batch = tools.get(TOOL_NAMES.batch);
    const fetchMock = mockFetch({});
    try {
        await assert.rejects(batch.execute({ items: [] }, exec()), /至少需要一项/);
        await assert.rejects(
            batch.execute({ items: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, exec()),
            /最多 2 项/
        );
        await assert.rejects(
            batch.execute(
                {
                    items: [
                        { prompt: 'a', idempotency_key: 'x' },
                        { prompt: 'b', idempotency_key: 'x' }
                    ],
                    allow_billable: true,
                    idempotency_key: 'k'
                },
                exec()
            ),
            /不能重复/
        );
        const plan = await batch.execute({ items: [{ prompt: 'a' }, { prompt: 'b', image_paths: ['x.png'] }] }, exec());
        assert.equal(plan.dry_run, true);
        assert.deepEqual(
            plan.items.map((item) => item.operation),
            ['generate', 'edit']
        );
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        fetchMock.restore();
    }
});

test('artifact share forwards options and never echoes the access code', async () => {
    const { tools } = createContext();
    const artifact = tools.get(TOOL_NAMES.artifact);
    const fetchMock = mockFetch({
        'GET /api/agent/artifacts/a1': json({ id: 'a1', mime_type: 'image/png' }),
        'POST /api/agent/artifacts/a1/share': json({
            share_url: 'https://s/1',
            access_code: 'leaked-code',
            requires_access_code: true
        })
    });
    try {
        const metadata = await artifact.execute({ artifact_id: 'a1' }, exec());
        assert.equal(metadata.response.id, 'a1');
        const shared = await artifact.execute(
            { artifact_id: 'a1', action: 'share', expires_in_minutes: 60, access_code: 'abcdefgh' },
            exec()
        );
        assert.deepEqual(JSON.parse(fetchMock.calls[1].body), { expires_in_minutes: 60, access_code: 'abcdefgh' });
        assert.equal(shared.share.share_url, 'https://s/1');
        assert.doesNotMatch(JSON.stringify(shared), /abcdefgh|leaked-code/);
        await assert.rejects(
            artifact.execute({ artifact_id: 'a1', action: 'share', access_code: 'short' }, exec()),
            /8 到 128/
        );
        await assert.rejects(artifact.execute({ artifact_id: '../x' }, exec()), /格式无效/);
    } finally {
        fetchMock.restore();
    }
});

test('diagnose takes exactly one target and keeps missing requests a normal answer', async () => {
    assert.throws(() => resolveDiagnosticTarget({}), /必须且只能/);
    assert.throws(() => resolveDiagnosticTarget({ request_id: 'r', channel_health: true }), /必须且只能/);
    assert.equal(resolveDiagnosticTarget({ channel_health: true }).path, '/api/agent/diagnostics/channel-health');
    assert.equal(
        resolveDiagnosticTarget({ page_request_id: 'p/1' }).path,
        '/api/agent/diagnostics/page-requests/p%2F1'
    );

    const { tools } = createContext();
    const fetchMock = mockFetch({
        'GET /api/agent/diagnostics/requests': json({ found: false }, 404),
        'GET /api/agent/diagnostics/channel-health': json({ state_initialized: true, channels: [] })
    });
    try {
        const missing = await tools.get(TOOL_NAMES.diagnose).execute({ idempotency_key: 'k' }, exec());
        assert.deepEqual(missing.response, { found: false });
        assert.match(fetchMock.calls[0].url, /idempotency_key=k$/);
        const health = await tools.get(TOOL_NAMES.diagnose).execute({ channel_health: true }, exec());
        assert.equal(health.response.state_initialized, true);
    } finally {
        fetchMock.restore();
    }
});

test('a replayed submission reports no new billing instead of always charging', async () => {
    const { tools } = createContext();
    const fetchMock = mockFetch({
        'GET /api/agent/capabilities': json(CAPABILITIES),
        'POST /api/agent/image-requests': [
            json(finalResponse('req-replay')),
            json(finalResponse('req-replay'), 200, { 'x-idempotent-replay': 'true' })
        ]
    });
    try {
        const fresh = await tools
            .get(TOOL_NAMES.generate)
            .execute({ prompt: 'p', allow_billable: true, idempotency_key: 'r' }, exec());
        assert.equal(fresh.billable, true);
        assert.equal(fresh.idempotency_replayed, false);

        const replayed = await tools
            .get(TOOL_NAMES.generate)
            .execute({ prompt: 'p', allow_billable: true, idempotency_key: 'r' }, exec());
        assert.equal(replayed.billable, false);
        assert.equal(replayed.idempotency_replayed, true);
        assert.equal(replayed.response.request_id, 'req-replay');
    } finally {
        fetchMock.restore();
    }
});
