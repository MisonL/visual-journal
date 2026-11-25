import { resolveSameOriginUrl } from './client.js';

const INLINE_IMAGE_FIELDS = new Set(['b64_json', 'base64', 'data', 'image_base64']);

/** Drop inline image payloads so base64 never enters tool output or the transcript. */
export function stripInlineImages(response) {
    if (!response || typeof response !== 'object' || !Array.isArray(response.images)) return response;
    return {
        ...response,
        images: response.images.map((image) =>
            image && typeof image === 'object'
                ? Object.fromEntries(Object.entries(image).filter(([key]) => !INLINE_IMAGE_FIELDS.has(key)))
                : image
        )
    };
}

/**
 * Bring generated artifacts into the conversation as durable DSH image
 * attachments, the same mechanism `read_image` and MCP image results use.
 * Every failure degrades to a recorded reason; the generation result itself
 * never fails because an image could not be attached.
 */
export async function attachResultImages(ctx, exec, client, response, { enabled }) {
    const images = Array.isArray(response?.images) ? response.images : [];
    if (!enabled || images.length === 0) return { attached: [], skipped_reason: enabled ? undefined : 'disabled' };
    const attachments = ctx.get?.('attachments');
    if (!attachments) return { attached: [], skipped_reason: 'no_attachment_store' };
    if (!(await routeAcceptsImages(ctx, exec))) return { attached: [], skipped_reason: 'model_without_image_input' };

    const limits = attachments.imageLimits;
    const maxBytes = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes);
    const attached = [];
    for (const image of images.slice(0, limits.maxImagesPerMessage)) {
        const artifactId = typeof image?.id === 'string' ? image.id : undefined;
        try {
            if (typeof image?.content_url !== 'string') throw new Error('产物缺少 content_url');
            const url = resolveSameOriginUrl(client.baseUrl, image.content_url);
            const { data, contentType } = await client.requestBytes(url, maxBytes);
            const mediaType = normalizeMediaType(image.mime_type) ?? normalizeMediaType(contentType);
            if (!mediaType || !limits.mediaTypes.includes(mediaType)) {
                throw new Error(`附件不接受媒体类型 ${mediaType ?? '未知'}`);
            }
            const ref = await attachments.saveImage({ data, mediaType, name: image.filename ?? artifactId });
            attached.push({ artifact_id: artifactId, attachment: toAttachmentValue(ref) });
        } catch (error) {
            if (exec.signal.aborted) throw error;
            attached.push({ artifact_id: artifactId, attachment_error: error.message });
        }
    }
    return { attached };
}

/** Content blocks for a result: the JSON summary, then each attached image. */
export function renderWithImages(value) {
    const blocks = [{ type: 'text', text: JSON.stringify(value, null, 2) }];
    for (const entry of value?.attachments?.attached ?? []) {
        if (entry.attachment) blocks.push({ type: 'image', attachment: { ...entry.attachment } });
    }
    return blocks;
}

/**
 * Attach only when the calling route declares image input, matching the gate
 * DSH applies to `read_image` and MCP image results.
 */
async function routeAcceptsImages(ctx, exec) {
    const llm = ctx.get?.('llm');
    const agent = exec.agent;
    if (!llm || !agent) return false;
    const routed = agent.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? agent.options?.provider;
    const model = routed?.model ?? agent.options?.model;
    if (!provider || !model) return false;
    try {
        const info = await llm.resolveModelInfo(provider, model, exec.signal);
        return info.inputModalities?.includes('image') === true;
    } catch {
        return false;
    }
}

function toAttachmentValue(ref) {
    return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
        ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } })
    };
}

function normalizeMediaType(value) {
    if (typeof value !== 'string') return undefined;
    const type = value.split(';')[0].trim().toLowerCase();
    return type === 'image/jpg' ? 'image/jpeg' : type || undefined;
}
