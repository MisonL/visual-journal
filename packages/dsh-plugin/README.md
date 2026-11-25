# Visual Journal DSH 插件

把 Visual Journal 的 Agent API 接入 DeepSeek Harness（DSH）。插件是一层薄适配：渠道路由、传输方式和上游选择仍由 Visual Journal 服务端决定，插件只把业务意图交给服务端，再把结果接回 DSH 的原生机制。

适用 DSH `>=0.2.1-rc.5 <0.3.0-0`（含 `0.3.0` 的预发布版一律不支持）。实测通过的组合：`dsh-tools` 0.2.1-alpha.1 … 0.2.3-alpha.2 逐一 × `schemastery` 3.18.5 / 3.19.0，另加 0.2.3-alpha.2 自带的 3.20.0-alpha.1。

## 工具

| 工具                          | 作用                                                                                    | 计费 |
| ----------------------------- | --------------------------------------------------------------------------------------- | ---- |
| `visual_journal_capabilities` | 读取模型、限额、默认值和鉴权要求；`include_models=true` 时附带模型目录                  | 否   |
| `visual_journal_generate`     | 通过 `/api/agent/image-requests` 生成图片，等待服务端编排的 job                         | 是   |
| `visual_journal_edit`         | 读取工作区源图，通过 Agent multipart 编辑，输出固定为 WebP                              | 是   |
| `visual_journal_batch`        | 一次审批下串行执行最多 `maxBatchItems` 个生成或编辑项                                   | 是   |
| `visual_journal_artifact`     | 读取产物元数据，或创建浏览器分享链接                                                    | 否   |
| `visual_journal_diagnose`     | 按 `request_id`、`idempotency_key`、`page_request_id` 或 `channel_health=true` 读取诊断 | 否   |

插件还会注册运行时 skill `visual-journal-image-workflow`，向模型说明调用顺序、幂等和排障规则。

## 与 DSH 的衔接

- **计费确认**：生成、编辑、批量的真实提交必须传 `allow_billable=true` 和 `idempotency_key`。默认 `approval: ask` 时，插件在 `tools/pre-execute` 返回 `ask`，由 DSH 弹出审批并写入会话审计；没有可用审批时 DSH 直接拒绝调用。创建分享链接同样需要审批。不传 `allow_billable` 时只做 dry-run，不发起任何网络请求。
- **结果图片**：产物以 DSH 图片附件返回，模型可以直接看到，会话历史中也能复用。当前模型不支持图片输入、没有挂载附件服务或图片超出附件限额时，结果照常返回，由 `attachments.skipped_reason` 或 `attachment_error` 说明原因。
- **源图读取**：编辑工具通过 DSH 文件系统读取源图，遵守当前工作目录和沙箱规则；拒绝符号链接，并按 capabilities 的 `upload_images.max`、`max_upload_mb`、`max_total_upload_mb` 限制数量和大小。对话中附加的图片会保存为只读路径，也可以直接作为源图。没有挂载文件系统的组合不会出现编辑工具。
- **超时与取消**：每个工具声明自己的 `timeoutMs`，由 DSH 统一执行；网络请求绑定调用方的取消信号，创建请求、job 轮询和下载产物共用一个时间预算。
- **并发**：计费工具不声明并发安全，DSH 会串行执行；只读工具可以并行。

## 安装

本包尚未发布到 npm 注册表，用打包文件安装到 profile：

```bash
cd packages/dsh-plugin
npm pack --pack-destination /tmp
dsh plugin --profile web add file:/tmp/visual-journal-dsh-plugin-0.2.0.tgz
```

不要用目录路径或 `link:` 安装：pnpm 不会为链接目录安装依赖，如果该目录还没有 `node_modules`，DSH 加载时会报告找不到 `@deepseek-ai/schemastery`。在插件目录先执行 `npm install` 后再链接，可以正常工作。

安装后检查组合结果，插件行的 `status` 应为 `schema`：

```bash
dsh --profile web --dump-config-schema
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件行：

```yaml
- id: visual-journal-dsh-plugin
  config:
      baseUrl: https://your-space.hf.space
      approval: ask
      attachImages: true
      maxBatchItems: 8
      timeoutMs: 900000
```

| 字段            | 默认值                                                   | 说明                                                                   |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `baseUrl`       | `GPT_IMAGE_PLAYGROUND_URL`，否则 `http://localhost:4783` | 服务地址。远程服务必须使用 HTTPS，HTTP 只允许回环地址                  |
| `timeoutMs`     | `900000`                                                 | 一次计费调用的总预算                                                   |
| `approval`      | `ask`                                                    | `ask` 走 DSH 审批；`off` 只依赖 `allow_billable`，适合无人值守 profile |
| `attachImages`  | `true`                                                   | 是否把产物作为图片附件返回                                             |
| `maxBatchItems` | `8`                                                      | 单次批量的项数上限，取值 1 到 16                                       |

鉴权只从进程环境读取：优先 `AGENT_API_TOKEN`，其次 `GPT_IMAGE_AGENT_TOKEN`（均以 Bearer 发送），最后 `GPT_IMAGE_APP_PASSWORD_HASH`（以 `X-App-Password-Hash` 发送）。DSH 启动时按「继承环境 > 启动目录 `.env` > `~/.dsh/.env`」的顺序装载，所以把 `AGENT_API_TOKEN=<token>` 写进 `~/.dsh/.env`（权限 600）即可让所有 profile 使用，不必写进 profile 目录。非回环部署应使用 HTTPS，避免访问码哈希被重放。

## 幂等与批量

- 同一个 `idempotency_key` 重放返回服务端缓存结果，不会重复计费。已经以 `failed` 结束的 key 只会重放失败，重试时请换新 key。
- 批量项默认使用 `<idempotency_key>:<index>`，也可以为单项指定 `idempotency_key`。用同一批 key 重跑即可续跑；失败项需要换新 key，插件不会自动重试。
- 每一项单独记录 `status`、`request_id`、`artifact_ids` 或结构化错误（`code`、`retryable`），互不影响；超出时间预算的项标记为 `not_started`。
- 单次调用返回 `billable` 与 `idempotency_replayed`：服务端以 `X-Idempotent-Replay` 应答时说明这次没有执行新任务，`billable` 为 `false`；批量的 `summary.billable` 统计真正提交的项数。

## 本机 Docker 联调

```bash
# 1. 起服务（容器内绑定 127.0.0.1:4783）
docker compose up -d --build
curl -s http://127.0.0.1:4783/api/auth-status

# 2. 服务端与客户端共用同一个 Agent token
#    .env.local 由 compose 注入容器；~/.dsh/.env 供 DSH 里的插件读取
grep -q '^AGENT_API_TOKEN=' .env.local || echo "AGENT_API_TOKEN=$(openssl rand -base64 32)" >> .env.local
grep '^AGENT_API_TOKEN=' .env.local > ~/.dsh/.env && chmod 600 ~/.dsh/.env

# 3. 装插件并配置服务地址
npm pack --pack-destination /tmp
dsh plugin --profile web add file:/tmp/visual-journal-dsh-plugin-0.2.0.tgz
```

然后在 profile 的 `cordis.patch.yml` 里把 `baseUrl` 指向 `http://127.0.0.1:4783`，重开 DSH 会话后即可用 `visual_journal_*` 工具。

三处容易踩的点：

- **质量档按模型族区分。** `auto`/`low`/`medium`/`high` 适用于所有模型；`xhigh` 与 `max` 仅 `gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 支持，其他模型传 `xhigh`/`max` 会被服务端以 `validation_error` 拒绝。
- **尺寸语义按模型族区分。** `gpt-image-1` 系只接受预设尺寸；`gpt-image-2` 系与 `gpt-image-2.5` 系按 16 倍数、1:3~3:1、单边 ≤3840 校验；其余模型（Gemini 图像、FLUX、Seedream、Qwen-Image、SD/SDXL、Recraft、Ideogram、Midjourney、NovelAI 及未登记的自定义模型）按 provider-defined 处理，服务端只保留单边 8192px、总像素 67,108,864 的本地预算，实际边界以 `/api/agent/models` 的 `known_models[]`（`family`、`family_label`、`size_policy`、`supports_edit`、`allow_transparent_background`、`recommended_presets`）和上游响应为准。
- **模型名必须与渠道实际支持的一致。** 默认 `gpt-image-2` 在部分第三方网关下不可用，`/api/agent/models` 只回显声明，不代表上游接受；遇到 `validation_error` + `upstream_status 400` 时用 `visual_journal_diagnose --idempotency_key` 看 `route_decision`，再逐个直接打上游确认参数兼容性（例如某些 Gemini 通道拒绝 `moderation` 和 `partial_images`）。
- **容器与 DSH 的 token 必须同一个值。** 服务端 `assertAgentAuthorized` 先看 `AGENT_API_TOKEN`，客户端凭据不匹配时所有 `/api/agent/*` 都会 401，页面端仍能打开，容易误判成"插件没装上"。
- **编辑只能用支持 `/images/edits` 的模型。** 生成能用的模型不一定能编辑，例如部分 NAI 通道的编辑请求会被上游以 `nai_policy_required` 拒绝。编辑输出固定为 WebP。

## 安全边界

- 服务地址只来自 profile 配置和进程环境，工具参数不能改写；服务端返回的 job 或产物 URL 必须与服务地址同源，否则在携带鉴权头之前拒绝。
- 输出中不包含密钥、分享访问码、图片 base64 或本机绝对路径；编辑来源只回显文件名。
- 服务端拥有的传输控制（`stream_mode`、`streaming_strategy`、`force_request`）不出现在工具参数中。
- 错误保留服务端的 `code`、`retryable` 和 `retry_after_seconds`，模型按这些字段决策，而不是解析错误文案。

## 不在范围内

- 页面工作台的 `/api/images` SSE，以及 Responses 后端的编辑；需要时在 Visual Journal 工作台操作。
- 删除产物、写入页面反馈、修改渠道或上游配置。

## 开发

本目录是独立 npm 包，不属于根项目的依赖树：

```bash
npm install
npm test
npm pack --dry-run
```

测试使用 `node:test`，覆盖鉴权、地址校验、能力范围、job 轮询、审批门禁、图片附件、源图读取、批量和诊断，并校验 `engines.dsh` 与 DSH 安装期兼容性检查一致。
