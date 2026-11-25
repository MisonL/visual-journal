import { assertGenerateWithinCapabilities, readUploadLimits, requestCapabilities } from './capabilities.js';
import { AGENT_ENDPOINTS, requireIdempotencyKey } from './client.js';
import { attachResultImages, stripInlineImages } from './images.js';
import { inspectEditSources, readEditSources } from './sources.js';

/** Business-intent fields forwarded to the server-orchestrated generate endpoint. */
export const GENERATE_FIELDS = Object.freeze([
    'model',
    'size',
    'quality',
    'n',
    'output_format',
    'output_compression',
    'background',
    'moderation',
    'image_backend',
    'partial_images',
    'responsesModel',
    'thinking',
    'promptOptimization',
    'force_web'
]);

/** Text fields accepted by the Agent multipart edit contract. */
export const EDIT_FIELDS = Object.freeze(['model', 'size', 'quality', 'n', 'partial_images']);

export function buildRequest(args, fields) {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt 不能为空。');
    const request = { prompt: args.prompt };
    for (const field of fields) if (args[field] !== undefined) request[field] = args[field];
    return request;
}

/**
 * Submit one generate request. The server owns transport and channel routing;
 * the plugin validates against capabilities, submits once per idempotency key,
 * and waits for the orchestrated job.
 */
export async function submitGenerate(env, exec, request, idempotencyKey, capabilities) {
    assertGenerateWithinCapabilities(request, capabilities ?? (await requestCapabilities(env.client)));
    const created = await env.client.request(AGENT_ENDPOINTS.generate, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: request,
        withResponse: true
    });
    return finishSubmission(env, exec, created, {
        endpoint: AGENT_ENDPOINTS.generate,
        idempotencyKey
    });
}

/** Submit one Agent multipart edit with workspace sources read through `ctx.fs`. */
export async function submitEdit(env, exec, request, sources, idempotencyKey, capabilities) {
    const resolved = capabilities ?? (await requestCapabilities(env.client));
    const limits = readUploadLimits(resolved);
    const files = await readEditSources(env.ctx, exec, { ...sources, limits });
    const form = new FormData();
    for (const [key, value] of Object.entries(request)) form.append(key, String(value));
    for (const image of files.images)
        form.append(image.field, new Blob([image.data], { type: image.mediaType }), image.name);
    if (files.mask) form.append('mask', new Blob([files.mask.data], { type: files.mask.mediaType }), files.mask.name);
    const created = await env.client.request(AGENT_ENDPOINTS.edit, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: form,
        withResponse: true
    });
    return finishSubmission(env, exec, created, {
        endpoint: AGENT_ENDPOINTS.edit,
        idempotencyKey,
        sources: [...files.images, ...(files.mask ? [files.mask] : [])].map(({ field, name, mediaType, data }) => ({
            field,
            name,
            media_type: mediaType,
            size_bytes: data.byteLength
        }))
    });
}

/** Describe an edit without reading bytes or contacting the service. */
export async function planEdit(env, exec, request, sources) {
    const inspected = env.ctx.fs ? await inspectEditSources(env.ctx, exec, sources) : undefined;
    return { request, sources: inspected ?? { image_paths: sources.imagePaths, mask_path: sources.maskPath } };
}

async function finishSubmission(env, exec, created, { endpoint, idempotencyKey, sources }) {
    // `created.replayed` means the server answered from its idempotency record:
    // nothing new ran, so the operation was neither re-submitted nor re-billed.
    const replayed = created.replayed === true;
    let response = created.data ?? created;
    let jobId;
    if (response?.job) {
        jobId = response.job.id;
        response = await env.client.waitForJob(response.job);
    } else if (!response?.request_id && !Array.isArray(response?.images)) {
        throw new Error('Visual Journal 响应既没有 job，也没有最终结果。');
    }
    const cleaned = stripInlineImages(response);
    const attachments = await attachResultImages(env.ctx, exec, env.client, cleaned, { enabled: env.attachImages });
    return {
        ok: true,
        billable: !replayed,
        idempotency_replayed: replayed,
        service_base_url: env.client.baseUrl,
        endpoint,
        idempotency_key: idempotencyKey,
        ...(jobId === undefined ? {} : { job_id: jobId }),
        ...(sources === undefined ? {} : { sources }),
        response: cleaned,
        attachments
    };
}

export function dryRunEnvelope(env, endpoint, plan, idempotencyKey) {
    return {
        ok: true,
        billable: false,
        dry_run: true,
        service_base_url: env.client.baseUrl,
        endpoint,
        ...plan,
        idempotency_key: idempotencyKey ?? null,
        guardrails: {
            billable_request_sent: false,
            requires: ['allow_billable=true', 'idempotency_key']
        }
    };
}

export { requireIdempotencyKey };
