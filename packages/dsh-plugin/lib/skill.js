/** Runtime skill that carries the operating rules the tools themselves cannot enforce. */
export const SKILL_NAME = 'visual-journal-image-workflow';
export const SKILL_DESCRIPTION = '用 Visual Journal 的 DSH 工具生成、编辑和诊断图片，并遵守计费、幂等与路由边界。';

const CONTENT = `# Visual Journal 图片工作流

使用 \`visual_journal_*\` 工具完成图片生成、编辑和排障。服务端拥有渠道路由、传输方式和上游选择，工具只描述业务意图。

## 顺序

1. 先用 \`visual_journal_capabilities\` 读取当前部署的模型、限额与后端默认值；不要凭记忆假设模型名、尺寸或数量范围。
2. 先做 dry-run：不传 \`allow_billable\`，确认工具回显的 request 与来源文件符合预期。
3. 真实提交必须同时给出 \`allow_billable=true\` 和稳定的 \`idempotency_key\`，并会触发一次审批。
4. 生成成功后结果会以图片附件返回；没有图片附件时读取 \`attachments.skipped_reason\`。

## 幂等

- \`idempotency_key\` 表示"这一个业务操作"。同一个 key 重放返回服务端缓存结果，不会重复计费。
- 已经以 \`failed\` 结束的 key 只会重放失败，\`retryable=false\` 时不要原样重试，改用新 key。
- 不要为"再试一次"生成随机 key；需要重试时明确换一个新 key，并说明原因。

## 编辑

- 只传工作区内的 PNG/JPEG/WebP 路径或已保存的附件路径；工具通过 DSH 文件系统读取，拒绝符号链接。
- \`mask_path\` 必须是带透明区域的 PNG。
- Agent 编辑固定输出 WebP。Responses 后端和页面 SSE 编辑不在工具范围内，需要时在 Visual Journal 工作台操作。

## 批量

- \`visual_journal_batch\` 在一次审批下串行执行，默认每项使用 \`<idempotency_key>:<index>\`。
- 用同一批 key 重跑即可续跑；\`failed\` 的项必须换成新 key。
- 并发和渠道选择由服务端决定，不要把批量拆成并行的多次工具调用。

## 排障

- \`visual_journal_diagnose\` 用 \`request_id\`、\`idempotency_key\` 查 Agent 请求，用 \`page_request_id\` 查页面请求，用 \`channel_health=true\` 查渠道健康。
- 错误对象带有 \`code\`、\`retryable\`、\`retry_after_seconds\`；按这三个字段决策，不要解析错误文案。
- 诊断接口不返回 prompt 全文、密钥、图片 base64 或本机路径。

## 安全

- 服务地址和凭据只来自 profile 配置与进程环境，工具参数不能覆盖。
- 不要把 \`idempotency_key\`、访问码或密钥写进提示词、文件名或提交记录。
`;

/** Register the guide as a runtime skill when a skill registry is mounted. */
export function registerSkill(ctx) {
    if (!ctx.skills) return;
    ctx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: '需要生成、编辑、批量处理或排障 Visual Journal 图片任务时。',
        content: CONTENT,
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true }
    });
}
