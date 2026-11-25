import { approvalReason, installApprovalGate, TOOL_NAMES } from './approval.js';
import {
    assertGenerateWithinCapabilities,
    assertRangeValue,
    intersectRanges,
    readNumericRange,
    readUploadLimits,
    resolveBackendRange
} from './capabilities.js';
import {
    AGENT_ENDPOINTS,
    authHeaders,
    createClient,
    DEFAULT_TIMEOUT_MS,
    requireIdempotencyKey,
    resolveBaseUrl,
    resolveSameOriginUrl,
    VisualJournalError
} from './client.js';
import { renderWithImages, stripInlineImages } from './images.js';
import { buildRequest, EDIT_FIELDS, GENERATE_FIELDS } from './operations.js';
import { registerSkill, SKILL_NAME } from './skill.js';
import { registerTools, resolveDiagnosticTarget, runBatch } from './tools.js';
import z from '@deepseek-ai/schemastery';

export const name = 'visual-journal-dsh-plugin';
export const inject = ['tools'];

export const Config = z.object({
    baseUrl: z.string().description('Visual Journal service URL; defaults to GPT_IMAGE_PLAYGROUND_URL.'),
    timeoutMs: z.number().min(1).default(DEFAULT_TIMEOUT_MS).description('Budget for one billable tool call.'),
    approval: z
        .union([z.const('ask'), z.const('off')])
        .default('ask')
        .description('ask: billable and share calls go through DSH approval; off: rely on allow_billable only.'),
    attachImages: z.boolean().default(true).description('Return generated images as DSH image attachments.'),
    maxBatchItems: z.natural().min(1).max(16).default(8).description('Upper bound for one batch call.')
});

export function apply(ctx, config = {}) {
    const settings = {
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        approval: config.approval ?? 'ask',
        attachImages: config.attachImages ?? true,
        maxBatchItems: config.maxBatchItems ?? 8
    };
    if (settings.approval === 'ask') installApprovalGate(ctx);
    registerTools(ctx, settings);
    if (typeof ctx.inject === 'function') ctx.inject(['skills'], registerSkill);
}

/** Pure helpers exposed for tests; not part of the plugin contract. */
export const internals = Object.freeze({
    AGENT_ENDPOINTS,
    DEFAULT_TIMEOUT_MS,
    EDIT_FIELDS,
    GENERATE_FIELDS,
    SKILL_NAME,
    TOOL_NAMES,
    VisualJournalError,
    approvalReason,
    assertGenerateWithinCapabilities,
    assertRangeValue,
    authHeaders,
    buildRequest,
    createClient,
    intersectRanges,
    readNumericRange,
    readUploadLimits,
    renderWithImages,
    requireIdempotencyKey,
    resolveBackendRange,
    resolveBaseUrl,
    resolveDiagnosticTarget,
    resolveSameOriginUrl,
    runBatch,
    stripInlineImages
});
