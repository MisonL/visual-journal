export const TOOL_NAMES = Object.freeze({
    capabilities: 'visual_journal_capabilities',
    generate: 'visual_journal_generate',
    edit: 'visual_journal_edit',
    batch: 'visual_journal_batch',
    artifact: 'visual_journal_artifact',
    diagnose: 'visual_journal_diagnose'
});

const BILLABLE_TOOLS = new Set([TOOL_NAMES.generate, TOOL_NAMES.edit, TOOL_NAMES.batch]);

/**
 * Describe why one call needs a human decision, or return undefined when it
 * does not. Dry-runs and read-only calls never ask.
 */
export function approvalReason(name, args) {
    if (BILLABLE_TOOLS.has(name) && args?.allow_billable === true) {
        const count = name === TOOL_NAMES.batch && Array.isArray(args.items) ? args.items.length : 1;
        const operation = name === TOOL_NAMES.edit ? '编辑' : name === TOOL_NAMES.batch ? '批量' : '生成';
        return {
            reason: `需要用户批准：Visual Journal 将发起 ${count} 个计费图片${operation}请求（idempotency_key=${args.idempotency_key ?? '缺失'}）。`,
            en: `Approval required: Visual Journal will submit ${count} billable image ${name === TOOL_NAMES.edit ? 'edit' : 'generation'} request(s).`
        };
    }
    if (name === TOOL_NAMES.artifact && args?.action === 'share') {
        return {
            reason: `需要用户批准：Visual Journal 将为产物 ${args.artifact_id ?? ''} 创建可在浏览器打开的分享链接。`,
            en: `Approval required: Visual Journal will create a browser-openable share link for artifact ${args.artifact_id ?? ''}.`
        };
    }
    return undefined;
}

/**
 * Route billable and sharing calls through DSH's own approval pipeline: the
 * registry turns `ask` into an approval prompt with audit events, and fails
 * closed when no answerer exists. Earlier denials are never overridden.
 */
export function installApprovalGate(ctx) {
    if (typeof ctx.on !== 'function') return;
    ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision.kind !== 'allow') return decision;
        const ask = approvalReason(exec.name, exec.arguments);
        if (!ask) return decision;
        return { kind: 'ask', reason: ask.reason, displayReason: { en: ask.en, zh: ask.reason } };
    });
}
