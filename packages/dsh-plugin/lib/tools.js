import { TOOL_NAMES } from './approval.js';
import { requestCapabilities, requestModels } from './capabilities.js';
import { AGENT_ENDPOINTS, createClient, normalizeNonEmpty, requireIdempotencyKey, resolveBaseUrl } from './client.js';
import { renderWithImages } from './images.js';
import {
    EDIT_FIELDS,
    GENERATE_FIELDS,
    buildRequest,
    dryRunEnvelope,
    planEdit,
    submitEdit,
    submitGenerate
} from './operations.js';
import { defineTool } from '@deepseek-ai/dsh-tools';

const READ_TIMEOUT_MS = 60_000;
const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
};
const IMAGE_OUTPUT = { schema: { type: 'json' }, render: (_args, value) => renderWithImages(value) };

const billableParameters = {
    allow_billable: {
        type: 'boolean',
        description: 'Set true to submit a real, billable request. Omit for a dry-run.'
    },
    idempotency_key: {
        type: 'string',
        description: 'Stable key for this operation. Reuse it to resume; a key that failed only replays the failure.'
    }
};

const generateParameters = {
    prompt: { type: 'string', required: true, description: 'Image generation prompt.' },
    model: { type: 'string', description: 'Image model declared by capabilities.' },
    size: { type: 'string', description: 'Requested size, e.g. 1024x1024 or auto.' },
    quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    n: { type: 'integer', description: 'Image count within capabilities limits.generate_images.' },
    output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    output_compression: { type: 'integer', description: 'Compression for jpeg/webp output.' },
    background: { type: 'string', enum: ['auto', 'transparent', 'opaque'] },
    moderation: { type: 'string', enum: ['auto', 'low'] },
    image_backend: { type: 'string', description: 'Backend business intent; the server still owns routing.' },
    partial_images: { type: 'integer', description: 'Preview count within capabilities limits.partial_images.' },
    responsesModel: { type: 'string', description: 'Top-level Responses model for the Responses image backend.' },
    thinking: { type: 'string', description: 'Reasoning level for the Responses image backend.' },
    promptOptimization: { type: 'boolean' },
    force_web: { type: 'boolean' },
    ...billableParameters
};

const editParameters = {
    prompt: { type: 'string', required: true, description: 'Edit instruction.' },
    image_paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'PNG/JPEG/WebP source images in the workspace, or saved attachment paths.'
    },
    mask_path: { type: 'string', description: 'Optional PNG mask with transparent edit regions.' },
    model: { type: 'string' },
    size: { type: 'string' },
    quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    n: { type: 'integer', description: 'Image count within capabilities limits.edit_images.' },
    partial_images: { type: 'integer' },
    ...billableParameters
};

const batchItem = {
    type: 'object',
    additionalProperties: false,
    properties: {
        prompt: { type: 'string', required: true },
        image_paths: { type: 'array', items: { type: 'string' }, description: 'Present for an edit item.' },
        mask_path: { type: 'string' },
        model: { type: 'string' },
        size: { type: 'string' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
        n: { type: 'integer' },
        output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        background: { type: 'string', enum: ['auto', 'transparent', 'opaque'] },
        idempotency_key: { type: 'string', description: 'Per-item key; defaults to <idempotency_key>:<index>.' }
    }
};

export function registerTools(ctx, settings) {
    const env = (exec, timeoutMs = settings.timeoutMs) => ({
        ctx,
        attachImages: settings.attachImages,
        client: createClient({ baseUrl: resolveBaseUrl(settings.baseUrl), timeoutMs, signal: exec.signal })
    });
    const register = (definition) => ctx.tools.register(defineTool(definition));

    register({
        name: TOOL_NAMES.capabilities,
        description:
            'Read Visual Journal capabilities: models, limits, defaults, and auth requirements. Never generates images.',
        parameters: { include_models: { type: 'boolean', description: 'Also read the model directory.' } },
        output: JSON_OUTPUT,
        timeoutMs: READ_TIMEOUT_MS,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const { client } = env(exec, READ_TIMEOUT_MS);
            const capabilities = await requestCapabilities(client);
            const models = args.include_models === true ? await requestModels(client) : undefined;
            return {
                ok: true,
                service_base_url: client.baseUrl,
                capabilities,
                ...(models === undefined ? {} : { models })
            };
        }
    });

    register({
        name: TOOL_NAMES.generate,
        description:
            'Generate images with Visual Journal. Dry-run by default; allow_billable=true plus idempotency_key submits a real request after approval. Results return as image attachments.',
        parameters: generateParameters,
        output: IMAGE_OUTPUT,
        timeoutMs: settings.timeoutMs,
        async execute(args, exec) {
            const runtime = env(exec);
            const request = buildRequest(args, GENERATE_FIELDS);
            if (args.allow_billable !== true) {
                return dryRunEnvelope(runtime, AGENT_ENDPOINTS.generate, { request }, args.idempotency_key);
            }
            return submitGenerate(runtime, exec, request, requireIdempotencyKey(args.idempotency_key));
        }
    });

    const registerEdit = (scope) =>
        scope.tools.register(
            defineTool({
                name: TOOL_NAMES.edit,
                description:
                    'Edit workspace images with Visual Journal (Agent multipart edit, WebP output). Dry-run by default; allow_billable=true plus idempotency_key submits after approval.',
                parameters: editParameters,
                output: IMAGE_OUTPUT,
                timeoutMs: settings.timeoutMs,
                async execute(args, exec) {
                    const runtime = { ...env(exec), ctx: scope };
                    const request = buildRequest(args, EDIT_FIELDS);
                    const sources = { imagePaths: args.image_paths, maskPath: args.mask_path };
                    if (args.allow_billable !== true) {
                        const plan = await planEdit(runtime, exec, request, sources);
                        return dryRunEnvelope(runtime, AGENT_ENDPOINTS.edit, plan, args.idempotency_key);
                    }
                    return submitEdit(runtime, exec, request, sources, requireIdempotencyKey(args.idempotency_key));
                }
            })
        );
    if (typeof ctx.inject === 'function') ctx.inject(['fs', 'workingDirectory'], registerEdit);
    else if (ctx.fs) registerEdit(ctx);

    register({
        name: TOOL_NAMES.batch,
        description: `Run up to ${settings.maxBatchItems} generate or edit items serially under one approval. Item keys default to <idempotency_key>:<index>, so rerunning the same batch resumes from cached results.`,
        parameters: {
            items: { type: 'array', required: true, items: batchItem },
            ...billableParameters
        },
        output: IMAGE_OUTPUT,
        timeoutMs: settings.timeoutMs,
        async execute(args, exec) {
            return runBatch(env(exec), exec, args, settings.maxBatchItems);
        }
    });

    register({
        name: TOOL_NAMES.artifact,
        description: 'Read Visual Journal artifact metadata, or create a browser share link (share asks for approval).',
        parameters: {
            artifact_id: { type: 'string', required: true },
            action: { type: 'string', enum: ['metadata', 'share'], default: 'metadata' },
            expires_in_minutes: { type: 'integer', description: 'Share lifetime; omit for the server default.' },
            access_code: { type: 'string', description: 'Optional 8-128 character share access code.' }
        },
        output: JSON_OUTPUT,
        timeoutMs: READ_TIMEOUT_MS,
        isConcurrencySafe: (args) => args.action !== 'share',
        async execute(args, exec) {
            const { client } = env(exec, READ_TIMEOUT_MS);
            const artifactId = requireIdentifier(args.artifact_id, 'artifact_id');
            if (args.action !== 'share') {
                const response = await client.request(AGENT_ENDPOINTS.artifact(artifactId));
                return { ok: true, service_base_url: client.baseUrl, artifact_id: artifactId, response };
            }
            const body = {};
            if (args.expires_in_minutes !== undefined) body.expires_in_minutes = args.expires_in_minutes;
            if (args.access_code !== undefined) {
                if (args.access_code.length < 8 || args.access_code.length > 128) {
                    throw new Error('access_code 长度必须在 8 到 128 个字符之间。');
                }
                body.access_code = args.access_code;
            }
            const response = await client.request(AGENT_ENDPOINTS.artifactShare(artifactId), {
                method: 'POST',
                body
            });
            // The access code is a user secret; it never returns through tool output.
            const share = { ...(response ?? {}) };
            delete share.access_code;
            return { ok: true, service_base_url: client.baseUrl, artifact_id: artifactId, share };
        }
    });

    register({
        name: TOOL_NAMES.diagnose,
        description:
            'Read Visual Journal diagnostics. Provide exactly one of request_id, idempotency_key, page_request_id, or channel_health=true.',
        parameters: {
            request_id: { type: 'string', description: 'Agent request_id.' },
            idempotency_key: { type: 'string', description: 'Idempotency-Key of an Agent request.' },
            page_request_id: { type: 'string', description: 'Page workbench clientRequestId.' },
            channel_health: { type: 'boolean', description: 'Read the current channel health snapshot.' }
        },
        output: JSON_OUTPUT,
        timeoutMs: READ_TIMEOUT_MS,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const { client } = env(exec, READ_TIMEOUT_MS);
            const target = resolveDiagnosticTarget(args);
            const response = await client.request(target.path, { allowNotFound: target.allowNotFound });
            return { ok: true, service_base_url: client.baseUrl, target: target.label, response };
        }
    });
}

/** Exactly one diagnostic target; each maps to a read-only Agent endpoint. */
export function resolveDiagnosticTarget(args) {
    const targets = [
        ['request_id', normalizeNonEmpty(args.request_id)],
        ['idempotency_key', normalizeNonEmpty(args.idempotency_key)],
        ['page_request_id', normalizeNonEmpty(args.page_request_id)],
        ['channel_health', args.channel_health === true ? true : undefined]
    ].filter(([, value]) => value !== undefined);
    if (targets.length !== 1) {
        throw new Error('必须且只能提供 request_id、idempotency_key、page_request_id 或 channel_health=true 之一。');
    }
    const [[type, value]] = targets;
    if (type === 'channel_health') return { label: { type }, path: AGENT_ENDPOINTS.channelHealth };
    if (type === 'page_request_id') {
        return { label: { type, value }, path: AGENT_ENDPOINTS.pageRequestDiagnostics(value), allowNotFound: true };
    }
    return {
        label: { type, value },
        path: `${AGENT_ENDPOINTS.requestDiagnostics}?${type}=${encodeURIComponent(value)}`,
        allowNotFound: true
    };
}

/**
 * Serial batch: one approval, one capability read, independent item outcomes.
 * Failed items keep their structured error and are never retried here.
 */
export async function runBatch(runtime, exec, args, maxItems) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) throw new Error('items 至少需要一项。');
    if (items.length > maxItems) throw new Error(`items 最多 ${maxItems} 项，当前为 ${items.length} 项。`);
    const planned = items.map((item, index) => {
        const isEdit = Array.isArray(item.image_paths) && item.image_paths.length > 0;
        return {
            index,
            operation: isEdit ? 'edit' : 'generate',
            request: buildRequest(item, isEdit ? EDIT_FIELDS : GENERATE_FIELDS),
            sources: isEdit ? { imagePaths: item.image_paths, maskPath: item.mask_path } : undefined,
            key: item.idempotency_key
        };
    });
    if (args.allow_billable !== true) {
        return {
            ...dryRunEnvelope(runtime, AGENT_ENDPOINTS.generate, {}, args.idempotency_key),
            endpoint: undefined,
            items: planned.map(({ index, operation, request, sources }) => ({
                index,
                operation,
                request,
                ...(sources === undefined ? {} : { image_paths: sources.imagePaths, mask_path: sources.maskPath }),
                idempotency_key: null
            }))
        };
    }
    const baseKey = requireIdempotencyKey(args.idempotency_key);
    const keys = planned.map((item) =>
        requireIdempotencyKey(item.key ?? `${baseKey}:${item.index}`, `items[${item.index}].idempotency_key`)
    );
    if (new Set(keys).size !== keys.length) throw new Error('批量项的 idempotency_key 不能重复。');
    const capabilities = await requestCapabilities(runtime.client);
    const results = [];
    const attached = [];
    let charged = 0;
    for (const item of planned) {
        const key = keys[item.index];
        try {
            runtime.client.remainingMs();
            const outcome =
                item.operation === 'edit'
                    ? await submitEdit(runtime, exec, item.request, item.sources, key, capabilities)
                    : await submitGenerate(runtime, exec, item.request, key, capabilities);
            attached.push(...(outcome.attachments?.attached ?? []));
            charged += outcome.billable === true ? 1 : 0;
            results.push({
                index: item.index,
                operation: item.operation,
                status: 'succeeded',
                idempotency_key: key,
                replayed: outcome.idempotency_replayed === true,
                request_id: outcome.response?.request_id ?? null,
                artifact_ids: (outcome.response?.images ?? []).map((image) => image?.id).filter(Boolean)
            });
        } catch (error) {
            if (exec.signal.aborted) throw error;
            const notStarted = error?.code === 'deadline';
            results.push({
                index: item.index,
                operation: item.operation,
                status: notStarted ? 'not_started' : 'failed',
                idempotency_key: key,
                error: {
                    code: error?.code ?? 'error',
                    message: error.message,
                    retryable: error?.retryable === true
                }
            });
        }
    }
    const count = (status) => results.filter((result) => result.status === status).length;
    return {
        ok: count('failed') === 0 && count('not_started') === 0,
        billable: charged > 0,
        service_base_url: runtime.client.baseUrl,
        idempotency_key: baseKey,
        summary: {
            total: results.length,
            succeeded: count('succeeded'),
            failed: count('failed'),
            not_started: count('not_started'),
            replayed: results.filter((result) => result.replayed === true).length,
            billable: charged
        },
        items: results,
        attachments: { attached },
        next_action:
            count('failed') + count('not_started') === 0
                ? null
                : '失败项需要使用新的 idempotency_key 重新提交；未开始的项可用相同 idempotency_key 重跑本批次续跑。'
    };
}

function requireIdentifier(value, label) {
    const normalized = normalizeNonEmpty(value);
    if (!normalized) throw new Error(`${label} 不能为空。`);
    if (normalized.length > 200 || /[\u0000-\u001f\u007f/?#]/.test(normalized)) throw new Error(`${label} 格式无效。`);
    return normalized;
}
