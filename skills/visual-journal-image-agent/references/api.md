# 图像手记（Visual Journal）Agent API 参考

Agent API 是给自动化客户端使用的机器接口，不是自治 Agent 平台。

它不替代首战场景验证，也不替代页面工作台上的真实发布任务、结果下载、继续编辑、复用和结果反馈证据。

## 目录

- [辅助脚本](#辅助脚本)
- [能力查询](#能力查询)
- [任务轮询](#任务轮询)
- [生成图片](#生成图片)
- [编辑图片](#编辑图片)
- [产物元数据](#产物元数据)
- [结果反馈与诊断](#结果反馈与诊断)
- [页面 API 边界](#页面-api-边界)
- [错误](#错误)

## 辅助脚本

脚本位于当前 Skill 目录的 `scripts/` 下。不要硬编码本机安装路径或仓库 checkout 路径；由运行环境按当前 `SKILL.md` 所在目录解析脚本路径。
脚本必须通过 `node "<skill-root>/scripts/..."` 调用，以兼容 Windows、Linux 和 macOS；示例不要依赖 bash、sh、chmod、可执行位、POSIX inline env 或反斜杠续行。
生成、编辑、批量和上游诊断都应先使用这些内置脚本；不要临时编写 Node、Python 或 shell 脚本、curl 命令或手写 fetch/FormData 来重复实现同一套 API 调用。

- `scripts/generate-image.mjs`：JSON 文生图调用。
- `scripts/edit-image.mjs`：multipart 编辑调用；固定尺寸任务可添加 `--dimension-check` 验收真实产物尺寸。
- `scripts/batch-images.mjs`：JSONL 批量 generate/edit 调用。
- `scripts/convert-image-format.mjs`：本地 PNG/JPEG/WebP 互转。
- `scripts/diagnose-request.mjs`：按页面 `clientRequestId` 只读查询结果反馈和脱敏日志诊断摘要，也可按 Agent `request_id` 或 `idempotency_key` 查询 Agent 状态请求诊断，支持 `--base-url` 固定目标服务。
- `scripts/diagnose-channel-health.mjs`：通过 capabilities 声明的 Agent 端点读取当前服务进程的渠道健康快照，支持 `--base-url` 和 `--output`。
- `scripts/probe-upstream-image.mjs`：上游图片接口连通性探针。
- `scripts/channel-capability-matrix.mjs`：首次接入渠道时固定串行验证四种上游图片请求方式；用户明确确认后才允许真实矩阵，远程非 loopback HTTP 还必须显式传 `--allow-plain-http`，默认只启用通过验证的 `images-non-stream`，其他方式需显式选择后再生成私有渠道 env 配置。

生成、编辑和批量脚本默认只做预演（dry-run），不触发真实生图或编辑。预演输出的 `verification_scope.mode=local_planning_only` 表示只完成本地请求构造、参数归一化和静态路由规划；它不会读取远端能力声明，不会验证远端鉴权、渠道容量或清单写入。generate 可添加 `--check-remote` 做只读远端检查，输出 `verification_scope.mode=remote_contract_and_local_planning`，仅访问 `/api/agent/capabilities` 和 `/api/runtime-capabilities`，不会发送真实生图请求。必须显式添加 `--allow-billable` 才会调用真实端点。generate 默认提交到 `/api/agent/image-requests` 服务端编排入口；`--agent`、`--job`、`--page-sse` 才会显式改用 `/api/agent/images/generate`、`/api/agent/jobs/images/generate` 或页面端 `/api/images` SSE。
上游探针默认只检查 DNS、TLS 和 `/models`，必须显式添加 `--allow-billable` 才会调用上游 `/images/generations`。
脚本支持 `GPT_IMAGE_AGENT_CONTRACT_CHECK=1` 或 `--contract-check` 做只读契约检查，会覆盖服务声明的默认编排入口和页面 SSE 边界，不触发真实生图或编辑。
位于仓库根目录且是首次配置、换机器、服务地址不确定或 token 不确定时，先运行 `npm run first-run`。它只读、非计费、不写 env 文件，默认输出中文摘要，并报告 `service_base_url_source`、`interactive_confirmation_required`、服务可达性、当前进程鉴权、页面 SSE 鉴权和下一步动作。
自动化消费时使用 `npm run first-run -- --json`。
Agent 端点鉴权以 capabilities 的 `auth.schemes` 为准。配置 `AGENT_API_TOKEN` 时机器客户端使用 Bearer token；Skill 独立脚本优先读取本机环境中的 `GPT_IMAGE_AGENT_TOKEN`，未设置时兼容读取 `AGENT_API_TOKEN`。DSH 插件优先读取服务端约定的 `AGENT_API_TOKEN`，未设置时回退 `GPT_IMAGE_AGENT_TOKEN`。仅配置 `APP_PASSWORD` 时使用访问码哈希 `GPT_IMAGE_APP_PASSWORD_HASH`。工作台已验证的 `gptImageAccess` cookie 也可用于同源模型目录请求，即使同时配置了 Agent token。页面端 `/api/images` SSE 另看 `agent_streaming.page_sse.auth`；当其声明 `required=true` 时，form-data 必须包含 `passwordHash`。Agent token 不能替代页面 SSE 表单鉴权。非回环部署应使用 HTTPS，避免访问码哈希在传输中被重放。
subagent 或自动化任务如果用户指定 Space、云服务或内网服务，调用 `generate-image.mjs`、`edit-image.mjs`、`batch-images.mjs`、`diagnose-request.mjs`、`diagnose-channel-health.mjs` 或 `npm run agent:doctor -- --base-url <url>` 时显式传服务地址；不要依赖默认 localhost。
Hugging Face Space Secrets 只能写入和列出名称，不能从 CLI 读回 secret 值。远端配置 `AGENT_API_TOKEN` 后，本机 Agent 可通过不入库的 shell 环境、keychain 或本地私有 env 文件注入 `GPT_IMAGE_AGENT_TOKEN` 或 `AGENT_API_TOKEN`；Agent CLI 默认读取当前仓库根目录的 `.env.agent.local`，shell 环境变量优先。不要把 token 写进仓库、README、任务 JSONL、manifest、命令参数或日志。仓库根目录的 `.env.agent.local.example` 只作私有本机配置模板，真实 `.env.agent.local` 不入库。
排查环境配置时不要直接输出 `.env.local`、`.env*.local`、secret 文件或原始 `docker inspect .Config.Env`。Codex 会话日志会持久保存命令输出；优先运行仓库脚本 `npm run env:summary`，或在命令中先把 `API_KEY`、`TOKEN`、`PASSWORD`、`SECRET` 值替换为 `<redacted>`。

```text
npm run env:summary
npm run env:summary -- --file .env.local --container gpt-image-playground-customer
```

当服务返回相对 `content_url`、`metadata_url` 或页面 SSE `path` 时，辅助脚本会额外输出 `absolute_content_url`、`absolute_metadata_url` 或 `absolute_path`。
同一个 `Idempotency-Key` 如果已经进入终态 `failed`，再次调用 generate/edit 或 job result/status 只会回放该失败，且 `retryable=false`。需要重新尝试时应创建新的业务操作和新的 `Idempotency-Key`。
页面端 `/api/images` SSE 会把同一个业务 key 复用到 `clientRequestId`，因此脚本使用的 `Idempotency-Key` 不能超过 capabilities 中 `agent_streaming.page_sse.client_request_id.max_length` 声明的字符数；超长时会直接报错，不会静默截断。
脚本会在 dry-run 和真实请求前前置校验 `--size` 或 JSONL `size`。`gpt-image-2` 和 `gpt-image-2-1k` 支持 `auto` 或正整数 `WIDTHxHEIGHT`；默认 OpenAI-compatible 上游的更严格尺寸边界由服务端 profile 或真实上游显式报错。项目声明的 legacy 模型 `gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5` 只接受 `auto`、`1024x1024`、`1536x1024` 或 `1024x1536`。已配置或 `/models` 探测到的其他自定义模型遵循 provider-defined 语义，同样接受 `auto` 或正整数 `WIDTHxHEIGHT`，实际支持的尺寸以 `/api/agent/models` 响应中 `known_models[].size_policy`、渠道 provider manifest 和上游响应为准，不要按模型名称猜测能力；服务端和脚本都会拒绝超过单边 8192px 或总像素 67,108,864（64MP）的目标，确保本地图片归一化有固定资源上限。管理员确认要让真实上游决定尺寸或透明背景支持时，显式添加 `--force-request` 或在 JSONL/API 中设置 `force_request=true`；它只跳过本服务本地 upstream profile 尺寸/背景限制，不能绕过上述本地资源预算。鉴权、幂等键、`--allow-billable`、API URL 安全、渠道 request mode 白名单、legacy 模型尺寸白名单、正整数尺寸语法、图片数量、`partial_images`、文件大小和 mask 完整性校验仍然生效。生成、页面编辑、批量和上游探针默认请求 `output_format=webp`、`output_compression=100`。
真实执行输出会包含机器可读 `summary`。成功摘要包含 `ok`、`billable`、`request_id`、`idempotency_key`、`artifact_ids`、`content_urls`、`absolute_content_urls`、`share_urls`、`direct_content_urls`、`image_dimensions`、`actual_dimensions`、`cached`、`started_at`、`completed_at`、`elapsed_ms`、`server_elapsed_ms`、`elapsed_source`、`elapsed_breakdown`、`transport`、`endpoint`、`route_mode`、`image_backend`、`stream_mode`、`streaming_strategy`、`channel_request_mode`、`channel_request_mode_fallback_applied`、`route_decision`、`selected_channel_id`、`upstream_host`、脱敏 `request_headers` 和 `next_action`。`transport` 表示 Agent 对外访问的服务端端点形态，`route_mode` 表示 Agent/job/page SSE 路径，`channel_request_mode` 表示服务端实际调用上游的 Images/Responses 与 SSE/非流式组合，`route_decision` 记录 requested backend、candidate request modes、request mode priority、preferred/fallback/selected request mode、fallback 是否发生、选中渠道、上游 host 或 no-channel 原因。`share_urls` 只在显式 `--share` 后出现，用于给用户浏览器打开分享页；`direct_content_urls` 只在显式 `--share` 后出现，用于分享后的内容直链；公开分享可直接打开 `direct_content_urls`，设置访问码时优先给用户 `share_urls`；`content_urls` 仍是需要 Agent 鉴权的产物下载路径。失败摘要也稳定包含空数组或 `null` 形式的产物、路由、渠道和尺寸字段，便于自动化客户端按同一模板汇报；尺寸门禁失败属于“上游已生成但本地验收失败”，失败摘要会保留已生成产物的 `artifact_ids`、`content_urls`、`absolute_content_urls` 和 `image_dimensions`。失败摘要还包含 `route_decision`、`transport_error_kind`、`retry_after_ms`、`cooldown_until`、`cooldown_target`、`retryable`、`dimension_check_failed`、`expected_dimensions`、`actual_dimensions`、`agent_diagnostics_checked`、`agent_diagnostics_found`、`agent_diagnostics_unavailable_reason`、`agent_diagnostics_http_status` 和 `next_action`；渠道与路由诊断优先读取 `error.diagnostics`，没有对应诊断字段时才回退到响应里的 `execution`。Agent JSON 失败时脚本会按幂等键只读查询 Agent 状态；若命中，会把 `request_id`、`channel_request_mode`、`channel_request_mode_fallback_applied`、`route_decision`、`selected_channel_id`、`upstream_host`、`transport_error_kind` 合并进首次失败摘要，并输出 `agent_failure_diagnostics`。回答耗时问题时优先读取 `summary.elapsed_ms`；需要区分脚本等待和上游耗时时读取 `summary.elapsed_breakdown`。

生成脚本参数：

- `--model`：默认使用服务端能力声明中的 `defaults.model`；服务端未配置 `OPENAI_IMAGE_MODEL` 时为 `gpt-image-2`。
- `--size`：默认 `1024x1024`。
- `--quality`：默认 `high`。
- `--n`：默认 `1`，范围以 capabilities 的 `limits.generate_images` 为准。
- `--format`：默认 `webp`，`jpg` 会规范化为 `jpeg`。
- `--output-compression`：默认 `100`，仅适用于 `jpeg` 或 `webp`。
- `--response-mode`：默认 `path`。
- `--image-backend`：可选，显式选择 `images-api`、`images`、`responses` 或 `responses-image-generation`。
- `--responses-model` / `--gpt-model`：生成意图字段，覆盖本次请求的 Responses 顶层模型；未传时使用服务端 `OPENAI_RESPONSES_API_MODEL`。必须同时设置 `--image-backend responses-image-generation` 或兼容别名 `responses`。该字段只影响本项目的 `responses-image-generation` 路径，不改变兼容上游自身 Images API 桥接层内部选择的模型。
- `--thinking`：生成意图字段，可选值为 `minimal`、`none`、`low`、`medium`、`high` 或 `xhigh`。
- `--prompt-optimization`：生成意图字段，必须是 `true` 或 `false`。
- `--force-web`：生成意图字段，服务端在 Images API 路径发送为 `force_web=true`。
- `--force-request`：生成意图字段，服务端在 Agent JSON、job 和页面 SSE 路径解释为 `force_request=true`，跳过本地 upstream profile 尺寸/背景限制，让真实上游接受或拒绝请求；鉴权、幂等键、费用确认、API URL 安全、渠道白名单、非 `gpt-image-2` 尺寸白名单、正整数尺寸语法、图片数量、`partial_images`、上传文件和 mask 完整性仍由本服务校验。
- `--stream-mode`：可选，显式选择 `auto`、`stream` 或 `non_stream`。
- `--streaming-strategy`：可选，显式选择 `off`、`auto`、`openai-sse`、`newapi-keepalive-sse`、`responses-sse` 或 `force-sse`。
- `--partial-images`：可选，显式设置上游 SSE partial image 数量。generate 或页面 SSE 请求包含 `image_backend` 时优先按 capabilities 的 `limits.partial_images_by_backend[image_backend]` 校验；缺少 backend 专属范围时才使用 `limits.partial_images`。省略该参数时，脚本不会把 `defaults.partial_images` 写入请求，由服务端在确定健康且满足 `n`、背景、尺寸和 request mode 的最终渠道后计算默认值；非流式请求不会把该字段发送给上游。
- `--share`：真实生图成功后，为每个 Agent 产物调用 `POST /api/agent/artifacts/{id}/share` 创建用户可打开的分享链接，并在顶层 `shares`、`summary.share_urls` 和 `summary.direct_content_urls` 输出结果。
- `--share-expires-minutes`：可选，设置分享有效期分钟数；省略时使用服务端默认值。
- `--dimension-check`：读取响应 `b64_json` 或同 origin `absolute_content_url`/`content_url`/`absolute_path`/`path`，校验 PNG/JPEG/WebP 尺寸等于 `--size`；通过时 summary 写入实际尺寸，失败时写入 `error.code=dimension_check_failed`、`validation_failure_kind=generated_artifact_failed_dimension_check`、产物 URL、`expected_dimensions` 和 `actual_dimensions`。这个失败表示上游已生成但本地验收未通过，不等于上游请求失败。
- `GPT_IMAGE_SHARE_ACCESS_CODE`：可选，创建需要访问码的分享链接；访问码不会出现在返回 URL 中，也不会出现在命令行参数里。
- `--timeout-ms`：未显式指定时，脚本先用 `420000ms` 读取 capabilities；真实请求会采用 `420000ms` 与 `capabilities.image_transport.upstream_timeout_ms` 中较大的值。
- `--prompt-file`：从文本文件读取 prompt。
- `--idempotency-key`：指定稳定幂等键。
- `--page-sse`：诊断或兼容开关，强制使用页面端 `/api/images` form-data SSE。
- `--agent`：诊断或兼容开关，强制使用 `/api/agent/images/generate` 非流式 JSON。
- `--job`：诊断或兼容开关，强制使用 Agent 任务轮询。
- `--dry-run`：只输出将要发送的 JSON。
- `--allow-billable`：允许真实调用生图端点。
- `--preset`：常用 dry-run/真实调用参数集，当前包括 `1k-smoke-agent`、`4k-agent-nonstream`、`4k-page-sse` 和 `4k-upstream-sse-newapi`。dry-run 会展开真实请求字段，不触发计费。

普通单次文生图默认提交到 `/api/agent/image-requests` 服务端编排入口；脚本不再按 `max_edge>2048`、公网 HTTPS 或 `--streaming-strategy off` 自行选择 page SSE、Agent JSON 或 job endpoint。需要对照时显式使用 `--page-sse`、`--agent` 或 `--job`。
单张 generate 脚本使用 `--responses-model`/`--gpt-model`、`--thinking`、`--prompt-optimization` 或 `--force-web` 时仍默认提交到 `/api/agent/image-requests`。服务端会在内部决定使用 Responses image_generation、Images API、SSE 或非流式路径；Agent 客户端不应因为这些字段自行选择 `/api/images`。
当服务端默认 `IMAGE_STREAMING_STRATEGY=off` 且请求未覆盖 `streaming_strategy` 时，运行时默认策略为 `off`；WebUI 会把 server-default 流式请求切到 `non_stream`，并发批量开关不可用。generate 脚本显式传 `--streaming-strategy off` 时仍提交给服务端编排入口，除非同时显式使用 `--agent`。

编辑脚本参数：

- `--model`
- `--size`
- `--quality`
- `--response-mode`
- `--format`
- `--output-compression`
- `--moderation`
- `--image-backend`
- `--responses-model`
- `--thinking`
- `--prompt-optimization`
- `--force-web`
- `--force-request`
- `--stream-mode`
- `--streaming-strategy`
- `--partial-images`
- `--sse-log`
- `--timeout-ms`
- `--idempotency-key`
- `--dimension-check`
- `--page-sse`
- `--agent`
- `--dry-run`
- `--allow-billable`

图片路径可以用位置参数 `<image-path> <prompt>`，也可以用 `--image <path> <prompt>`；两者不能同时设置。
默认 WebP edit 走页面端 `/api/images` form-data SSE，因为 Agent edit 不接收输出格式字段。显式 `--format`、`--output-compression`、`--image-backend responses-image-generation`、页面高级字段或 `--page-sse` 也会走页面 SSE；失败后脚本输出结构化失败和备用端点建议，不会在同一次请求里静默二次调用。
显式 `--page-sse` 会强制页面流式；显式 `--agent` 会走 Agent edit 最终 JSON。Agent edit 不接受 `image_backend`、`output_format` 或 `output_compression`；强制 Agent edit 时由服务端固定使用 WebP 输出契约，`partial_images` 按默认 Images API/profile 范围校验。Agent edit 只是页面 SSE 失败后的显式对照路径，不保证与页面 SSE 的像素尺寸完全一致；尺寸敏感任务必须使用生成/编辑/批量 `--dimension-check` 或下载后校验。编辑 `--dimension-check` 会读取响应 `b64_json` 或同 origin `content_url`，通过时在图片和 summary 写入实际尺寸，失败时输出结构化 `dimension_check_failed`、`generated_artifact_failed_dimension_check`、产物 URL 和服务端选路摘要。Responses image_generation edit 必须走页面 SSE，可显式设置 `--page-sse --image-backend responses-image-generation --streaming-strategy responses-sse`。如果运行时已显式配置 `IMAGE_GENERATION_BACKEND=responses-image-generation` 或兼容别名 `responses`，且 `IMAGE_STREAMING_STRATEGY=responses-sse`，也可依赖服务端默认值；Docker compose 本身不设置这两个默认值，未配置 `.env.local` 时仍是 `images-api` 和 `auto`。默认 WebP edit 与 `stream_mode=non_stream` / `streaming_strategy=off` 冲突时脚本会前置拒绝；需要 Agent JSON 对照时必须显式添加 `--agent`，并使用新的 `Idempotency-Key`。

批量脚本参数：

- `--input`：JSONL 任务文件路径，也可作为唯一位置参数。
- `--manifest`：追加写入 JSONL 清单路径，默认 `<input>.manifest.jsonl`。
- `--resume`：读取清单中已 `succeeded` 的 `id` 或 `idempotency_key` 并跳过。
- `--ordered-prefix`：未显式提供 `idempotency_key` 时构造稳定有序 key 的前缀，默认 `batch`。
- `--dimension-check`：读取响应 `b64_json` 或同 origin `absolute_content_url`/`content_url`/`absolute_path`/`path`，校验 PNG/JPEG/WebP 尺寸等于任务 `size`；通过时 summary 写入实际尺寸，失败时写入 `error.code=dimension_check_failed`、`validation_failure_kind=generated_artifact_failed_dimension_check`、产物 URL、`expected_dimensions` 和 `actual_dimensions`。这个失败表示上游已生成但本地验收未通过，不等于上游请求失败。
- `--max-attempts`：失败任务最大尝试次数。第二次及后续尝试会追加新的 attempt 级 `Idempotency-Key`，避免复用终态失败 key。
- `--concurrency`：并发执行窗口，默认 `1`。大于 `1` 时会先读取 `/api/runtime-capabilities` 的 `streamingBatch.recommendedConcurrency` 和 `channelQueue.capacityPerCredential`，把有效并发限制到服务端建议值后按输入顺序输出结果；适合已确认渠道容量的批量生产。
- `--max-consecutive-failures`：顺序执行下的连续失败熔断阈值，默认 `0` 表示不熔断。只能与 `--concurrency 1` 同用。
- `--timeout-ms`：未显式指定时，真实请求会采用 `420000ms` 与 `capabilities.image_transport.upstream_timeout_ms` 中较大的值。
- `--dry-run`
- `--allow-billable`

批量 dry-run 不写清单，输出会声明 `manifest_written=false`、`manifest_write_reason=dry_run` 和 `guardrails`。`guardrails.ordered_prefix` 是本次 dry-run 用于自动生成幂等键的前缀，真实执行应复用同一个 `--ordered-prefix`；`guardrails.dimension_check_recommended=true` 表示输入包含固定尺寸但未启用 `--dimension-check`。只有真实执行时清单才作为追加写入的续跑记录写入；Agent JSON 失败时清单会同时保存增强后的 `summary` 和 `agent_failure_diagnostics`。尺寸门禁失败同样写入结构化 summary 和可审查产物 URL，避免只能从中文错误文本解析期望和实际尺寸。批量总摘要会输出 `failure_summary.validation_failure_count` 和 `failure_summary.request_failure_count`，用于区分“上游已生成但本地验收失败”和“请求未成功完成”。当 `validation_failure_count>0` 而 `request_failure_count=0` 时，要按验收失败处理，不能当成上游不可用。

批量 JSONL 每行字段按 `mode` 区分。`background` 只适用于 `generate`；`image_path`、`image_paths`、`mask_path` 只适用于 `edit`。批量 generate 默认提交到 `/api/agent/image-requests`，`responsesModel`/`gptModel`/`gpt_model`、`thinking`、`promptOptimization`/`prompt_optimization`、`force_web`/`forceWeb` 会随 JSON 业务意图提交给服务端编排入口。默认 WebP edit 任务走页面 SSE；SSE 熔断或需要多参考图 Agent multipart 时，可在 edit 任务显式设置 `transport: "agent_json"`，此时使用固定 WebP Agent edit 合同。`output_format`、`format`、`output_compression`、`moderation`、`image_backend`、Responses 控制字段和 `sse_log_path` 仍只适用于页面 SSE edit，不得与 `transport: "agent_json"` 同用。edit 任务设置 `image_backend=responses-image-generation` 时会走页面 SSE；不要把它改成 Agent edit。`responsesModel` 必须同时设置 `image_backend=responses-image-generation` 或兼容值 `responses`。JSONL 字段名必须使用 `streaming_strategy`；`image_streaming_strategy` 是页面 form-data 字段名，不是 batch JSONL 字段，会被脚本在真实请求前拒绝。PNG 搭配 `output_compression` 会在 dry-run 标记 normalization，真实请求不会发送压缩字段。`page_sse`、`complex_ui`、`long_image`、`resume_or_recover` 必须是 JSON 布尔值；`transport` 可为 `page_sse`，或仅在 edit 任务中为 `agent_json`，且不能与 `page_sse=true` 同时设置。脚本会在 dry-run 阶段显式拒绝跨模式字段、未知字段和无效路由控制字段，避免参数被真实接口忽略。

Responses edit JSONL 正例：

```jsonl
{
    "id": "edit-responses",
    "mode": "edit",
    "prompt": "替换背景",
    "image_path": "source.png",
    "image_backend": "responses-image-generation",
    "streaming_strategy": "responses-sse",
    "partial_images": 1
}
```

dry-run 预期：`routing.transport=page_sse`、`endpoint=/api/images`、`request.image_backend=responses-image-generation`。

缺少 `image_backend` 的反例：

```jsonl
{
    "id": "edit-responses-missing-backend",
    "mode": "edit",
    "prompt": "替换背景",
    "image_path": "source.png",
    "responsesModel": "gpt-4.1"
}
```

dry-run 预期退出码为 `2`，错误包含 `responsesModel 必须同时设置 image_backend=responses-image-generation`。

并发批量示例：

```text
node "<skill-root>/scripts/batch-images.mjs" --allow-billable --input tasks.jsonl --manifest runs/product-set.manifest.jsonl --resume --dimension-check --max-attempts 2 --concurrency 3
```

连续失败熔断需要严格顺序语义，不能与并发窗口大于 `1` 的批量执行同时使用。不要手动并行启动多个单张脚本来绕过 `capacity_feedback`；如果服务端建议并发为 `1`，同一渠道批量任务应保持串行。复杂 UI、长 prompt、高质量图生图遇到上游 503、5 分钟级超时或 `channel_capacity_queue_aborted` 时，先诊断 summary，再用新 key 显式尝试压缩 prompt 或 `quality=medium` 对照请求。

上游探针脚本参数：

- `--base-url`
- `--model`
- `--responses-model`
- `--prompt`
- `--size`
- `--quality`
- `--format`
- `--output-compression`
- `--timeout-ms`
- `--request-mode` / `--request-modes`
- `--allow-billable`

上游探针默认只做非计费 `/models` 检查。添加 `--allow-billable` 后才会按 `--request-mode` 真实请求图片路径；可选值为 `images-non-stream`、`images-sse`、`responses-non-stream`、`responses-sse`，也支持别名 `images-json`、`images-sse`、`responses-json`、`responses-sse` 和 `all`。探测 Responses 路径时必须提供 `--responses-model` 或配置 `OPENAI_RESPONSES_API_MODEL`，它是 `/responses` 顶层模型，不是图片模型。`request_modes.passed` 和 `request_modes.suggested_channel_config` 只是管理员写入 `OPENAI_CHANNEL_N_REQUEST_MODES` 的候选值；远程 URL-only、pending/poll_url、失败或未实测的 mode 不应写入。直接探针只自动下载内联或同源 URL，跨域 URL 会保守标记为 `url_only_result`；部署服务会在 HTTPS、公共 DNS 且未配置代理时安全下载跨域结果，实际是否可消费仍以服务端安全策略和真实请求为准。写入白名单后，默认按费用更少优先选择 `images-non-stream`、`images-sse`、`responses-non-stream`、`responses-sse`；只有实测证明需要改变顺序时，才写入 `OPENAI_CHANNEL_N_REQUEST_MODE_PRIORITY` 或全局 `OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY`。上游探针默认使用 `User-Agent: visual-journal/probe`，可用 `OPENAI_UPSTREAM_USER_AGENT` 或 `UPSTREAM_USER_AGENT` 覆盖；输出的 `summary.request_headers` 只暴露脱敏摘要。

上游探针读取 `GPT_IMAGE_UPSTREAM_BASE_URL` 或 `OPENAI_API_BASE_URL` 作为上游地址，读取 `GPT_IMAGE_UPSTREAM_API_KEY` 或 `OPENAI_API_KEY` 作为上游鉴权。base URL 必须是无凭据、无查询参数和无片段的 `http`/`https` 绝对 URL。输出不会包含 key，也不会输出完整 base64。

## 渠道能力矩阵和私有配置

```text
node "<skill-root>/scripts/channel-capability-matrix.mjs" --base-url https://upstream.example.com/v1 --responses-model gpt-5.4 --allow-billable --confirm-billable --write-env-file /private/path/channel.env
```

首次接入时应先完成非计费发现并向用户说明将进行最多四次真实图片请求、可能产生上游费用和不会自动部署，得到明确同意后再运行该命令。真实矩阵必须同时传 `--allow-billable --confirm-billable`；缺少任一参数都不会发起矩阵图片请求。脚本固定串行调用 `images-non-stream`、`images-sse`、`responses-non-stream`、`responses-sse`，不会把未测、失败、pending/poll 或探针无法确认安全下载的远程 URL-only 结果记为通过。

`tested_request_modes` 表示本次真实通过的方式，`enabled_request_modes` 表示准备写入 `OPENAI_CHANNEL_N_REQUEST_MODES` 的方式。默认启用列表只有 `images-non-stream`；需要启用其他已通过方式时传 `--enable-request-modes <逗号或空格分隔列表>`，例如 `--enable-request-modes images-non-stream,images-sse`。启用列表中的每个方式都必须出现在 `tested_request_modes` 中；如果默认方式未通过，脚本不会静默切换到 Responses，必须显式选择已通过方式。

机器输出的 `onboarding.test_request_modes` 是固定的四种测试计划，`onboarding.tested_request_modes` 是本次实际通过的方式，`onboarding.enabled_request_modes` 是准备写入配置的白名单；三者故意分开，避免把“计划测试”或“测试通过”误当成“自动启用”。

`--write-env-file` 必须与 `--allow-billable --confirm-billable` 一起使用；写入还要求 `/models` 成功、四种模式都有报告、至少一个启用方式返回本服务可消费的最终图片、API Key 有效，且启用 Responses 时有可用顶层模型。任何条件不满足时只输出脱敏矩阵报告，不创建目标文件。

写入的独立私有 env 配置包含 `OPENAI_CHANNEL_N_*`、显式启用的模式和优先级、`IMAGE_GENERATION_BACKEND`、`IMAGE_STREAMING_STRATEGY=auto`，以及仅在启用 Responses 时的 `ENABLE_RESPONSES_IMAGE_BACKEND` 和 `OPENAI_RESPONSES_API_MODEL`。默认启用 `images-non-stream` 时后端为 `images-api`；只有管理员显式启用 Responses 且没有 Images 模式时，后端才为 `responses-image-generation`。远程非 loopback HTTP 必须在命令中显式传 `--allow-plain-http`，脚本才会额外写入精确的 `OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS`；未传时在任何探针前拒绝，loopback HTTP 不需要该参数。目标文件使用原子写入和权限 `0600`，默认拒绝覆盖或符号链接；标准输出只提供脱敏 `configuration.env_preview`。脚本不会合并或自动写入 `.env.local`，不会重启服务或部署。

## 能力查询

```http
GET /api/agent/capabilities
```

返回 API 版本、支持的模型、通用限制、模型级限制、Agent 流式边界、鉴权方式、存储模式、状态后端、幂等设置和端点路径。响应不会公开服务端本地 SQLite 文件路径。

关键字段：

- `auth.required`：Agent 端点是否需要鉴权。
- `auth.schemes`：Agent 端点当前实际接受的鉴权方案。`AGENT_API_TOKEN` 优先于 `APP_PASSWORD`，两者同时配置时只返回 `bearer`。
- `image_transport.upstream_timeout_ms`：当前服务端图片上游请求超时，脚本未显式传 `--timeout-ms` 时会用它延长默认超时。
- `image_transport.stream_data_interval_timeout_ms`：已建立图片流的单次数据空闲超时；`0` 表示服务端禁用该空闲计时器。
- `image_transport.upstream_max_retries`：OpenAI SDK 图片请求自动重试次数；默认 `0`，避免长耗时图片请求被 SDK 自动重试后重复计费。
- `image_transport.upstream_proxy`：全局服务端上游代理摘要，只包含 `configured` 和可选的 `protocol`（`http` 或 `https`）；不会返回代理主机、端口、认证信息或完整 URL。代理由部署管理员通过 `OPENAI_UPSTREAM_PROXY_URL` 配置，只影响服务端到图片上游的出站连接。

透明代理或 fake DNS 环境下，如果已确认上游域名会解析到 RFC 2544 `198.18.0.0/15`，部署管理员可以设置
`OPENAI_TUN_MODE=synthetic-dns`（旧变量 `OPENAI_ALLOW_SYNTHETIC_DNS_IPS=true` 仍兼容）。默认模式为
`disabled`，只对非字面量上游主机名的合成 DNS 结果生效；普通私网、回环、链路本地和字面量保留地址仍被拒绝，也不会放宽跨域图片 URL 的 SSRF 校验。配置变更需重启服务，主动模型探测和实际图片请求会使用同一策略。使用本地 Docker 部署时可执行 `npm run deploy:local -- --tun` 自动加载对应 Compose 覆盖文件。

- `model_limits.gpt-image-2.max_edge`：最大单边像素，当前为 `3840`。
- `model_limits.gpt-image-2.max_pixels`：最大总像素，当前为 `8294400`。
- `model_limits.gpt-image-2.edge_multiple`：宽高必须是该值的倍数，当前为 `16`。
- `model_limits.gpt-image-2.max_aspect`：最大长短边比例，当前为 `3`。
- `model_limits.gpt-image-2.min_pixels`：最小总像素，当前为 `655360`。
- `model_limits.gpt-image-2.recommended_presets`：推荐尺寸预设。
- `model_limits.gpt-image-2.large_image_risk`：大尺寸请求的长耗时风险说明，当前适用于 `max_edge>2048`。
- `model_limits.provider_defined`：所有自定义/provider-defined 模型共享的本地资源预算；当前单边最大 `8192` 像素、总像素最大 `67,108,864`（64MP）。即使使用 `force_request` 也不能绕过该预算。
- `agent_streaming.generate.mode`：当前为 `non_streaming_only`。
- `agent_streaming.edit.mode`：当前为 `non_streaming_only`。
- `agent_streaming.upstream_sse`：Agent generate/edit 内部消费上游 SSE 的能力，客户端响应仍是最终 `AgentImageResponse` JSON。
- `agent_streaming.upstream_sse.supported`：布尔值；当服务端支持 Agent 内部上游 SSE 消费时为 `true`，否则为 `false`。客户端只在为 `true` 时发送上游流式控制字段。这个字段只代表“声明支持”，不代表当前渠道每次实测都能成功。
- `agent_streaming.upstream_sse.request_fields`：兼容旧客户端的字段合集，当前为 `image_backend`、`stream_mode`、`streaming_strategy`、`partial_images`。
- `agent_streaming.upstream_sse.request_fields_by_mode.generate`：generate 可发送的上游 SSE 控制字段，当前为 `image_backend`、`stream_mode`、`streaming_strategy`、`partial_images`。
- `agent_streaming.upstream_sse.request_fields_by_mode.edit`：edit 可发送的上游 SSE 控制字段，当前为 `stream_mode`、`streaming_strategy`、`partial_images`。
- `agent_streaming.upstream_sse.image_backends`：支持 `images-api`、`responses-image-generation`。
- `agent_streaming.upstream_sse.enabled_image_backends`：当前运行时可直接使用的 Agent 上游 SSE 后端；`responses-image-generation` 只有在所需环境变量齐备时才出现。
- `agent_streaming.upstream_sse.streaming_strategies`：支持 `off`、`auto`、`openai-sse`、`newapi-keepalive-sse`、`responses-sse`、`force-sse`。
- `agent_streaming.upstream_sse.stream_modes`：支持 `auto`、`stream`、`non_stream`。
- `agent_streaming.upstream_sse.activation_strategies`：会真正向上游发送 `stream=true` 的策略，当前包含 `auto`、`openai-sse`、`newapi-keepalive-sse`、`responses-sse`、`force-sse`。
- `agent_streaming.page_sse`：页面端 `/api/images` 的 form-data SSE 能力，不代表 Agent generate/edit 支持流式。即使该字段为 `supported=true`，页面 SSE 仍可能在当前渠道返回 `503`、断流或没有选中渠道；这时应先诊断，再显式选择诊断路径，不自动回退。
- `agent_streaming.page_sse.auth`：页面 SSE 的独立表单鉴权。`APP_PASSWORD` 已配置时为 `required=true`、`schemes=["form-password-hash"]`、`form_field="passwordHash"`。
- `agent_streaming.page_sse.client_request_id`：页面 SSE 的请求 ID 契约。脚本会把 `Idempotency-Key` 写入 form-data `clientRequestId`，最大长度以 `max_length` 为准，当前为 `128`。
- 页面 SSE 或 Responses 路径失败时，如果 `selected_channel_id`、`upstream_host` 为空，通常表示请求没有真正落到可执行渠道；先诊断结构化错误，再用新的 `Idempotency-Key` 显式改路由。
- `supported.request_modes`：服务端支持的上游请求方式枚举，当前为 `images-non-stream`、`images-sse`、`responses-non-stream`、`responses-sse`。该字段描述服务端能力全集，不代表每个管理员渠道都已真实 smoke 通过。
- `upstream_request_headers.default`：默认上游请求头摘要，包含 `user_agent_effective`、`has_extra_headers`、`allowed_header_names` 和 `configured_header_names`。
- 每个 `upstream_request_headers.channels[]` 还包含按渠道脱敏的 `constraints`，声明生成/编辑数量、按 backend 的数量与 `partial_images` 范围、编辑上传数量和大小、`gpt-image-2` 背景与尺寸策略；存在已初始化路由健康状态时提供 `healthy_request_modes`，表示当前至少有一个凭证健康的 request mode。数量范围可能带 `allowedValues`，表示不连续的离散可用值，不能按 min/max 中间的整数扩展。
- `upstream_request_headers.channels`：每个服务端渠道的脱敏请求头摘要，包含该渠道有效 `request_modes` 和按白名单过滤后的 `request_mode_priority`。该字段不包含 API key、Authorization 值、Matsca app secret 值或任意 header value。
- `upstream_request_headers.channels[].upstream_proxy`：该渠道的有效上游代理摘要。`OPENAI_CHANNEL_N_PROXY_URL` 优先于 `OPENAI_UPSTREAM_PROXY_URL`；摘要只返回 `configured` 和 `protocol`，不返回代理地址或端口。
- `request_mode_controls`：管理员 request mode 白名单和优先级控制面，声明 `OPENAI_UPSTREAM_REQUEST_MODES`、`OPENAI_CHANNEL_N_REQUEST_MODES`、`OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY`、`OPENAI_CHANNEL_N_REQUEST_MODE_PRIORITY`、默认低费用优先顺序、真实冒烟验证门禁和 `agent_client_policy=diagnostics_only`；Agent 客户端只能用于解释执行结果，不应据此自行选择上游请求方式。首次接入新渠道时，先用 `scripts/probe-upstream-image.mjs` 做非计费 `/models` 检查并取得用户明确授权，再用 `scripts/channel-capability-matrix.mjs --allow-billable --confirm-billable` 固定验证四种方式；远程非 loopback HTTP 还必须传 `--allow-plain-http`。`npm run smoke:image-upstream-real -- --allow-billable` 仅用于已有配置的定向诊断，不能替代首次接入矩阵；它可按 `--case images-json`、`--case images-sse`、`--case responses-json`、`--case responses-sse` 筛选场景。矩阵输出的 `tested_request_modes` 是实测结果，`enabled_request_modes` 才是准备写入 `OPENAI_CHANNEL_N_REQUEST_MODES` 的列表；默认只启用 `images-non-stream`，其他模式必须显式选择。未通过、未实测、探针无法确认安全下载的远程 URL-only 或只返回 pending/poll_url 的 mode 不应写入。服务端会在 HTTPS、公共 DNS 且未配置代理时安全下载跨域图片 URL；只有内联 `b64_json`、Responses `result`、同源 URL 或已按该安全策略验证的跨域 URL 才算可消费。如果 `/v1/responses` 返回 `403 Image generation is not enabled for this group`，或 HTTP 200 但只返回文本 output、没有 `image_generation_call.result`/`url`，就把对应 `responses-*` mode 从白名单里删掉，只保留通过的模式。需要覆盖默认排序时，再把通过的 mode 按期望顺序写入 `OPENAI_CHANNEL_N_REQUEST_MODE_PRIORITY`。
- `providerManifests[].manifest.executionSupport`：`implemented` 表示当前执行器可按现有 Images/Responses 路径执行；`declared_only` 表示 manifest 声明了 async-poll，但当前执行器不会自动轮询 provider `poll` 配置。pending/poll_url 只能作为诊断线索，不是可写入 request mode 白名单的通过证明。
- `routing_rules.high_resolution_edit`：`edit` 且最大边大于 `2048` 时默认优先使用页面端 `/api/images` SSE，页面流式有问题时显式回退。
- `routing_rules.complex_ui_batch`：复杂 UI 批量出图推荐使用页面端 `/api/images` SSE。
- `routing_rules.long_image_recovery`：长图恢复或续跑锚点场景推荐使用页面端 `/api/images` SSE。
- `orchestration.supported`：当前为 `true`，表示普通 generate 默认由服务端编排。
- `orchestration.endpoint`：当前为 `POST /api/agent/image-requests`，客户端只提交业务意图，不选择内部传输路径。
- `orchestration.transport_selection`：当前为 `server_owned`，表示 Agent 客户端不应按尺寸、远端 HTTPS 或流式参数自行选择 page SSE、Agent JSON 或 job endpoint。
- `orchestration.result_mode`：当前为 `job_polling`，脚本会轮询 `job.result_url` 并输出标准 `AgentImageResponse`。
- `routing_rules.agent_generate_small_smoke`：`strength=explicit`，兼容旧客户端和显式 `--agent` 诊断路径；不是普通 generate 默认入口。
- `routing_rules.page_sse_generate_diagnostics`：`strength=explicit`，显式 page SSE 诊断和页面工作台路径的参考规则；普通 generate 默认仍走 `orchestration.endpoint`。
- `routing_rules.retry_recovery`：终态失败不会用同一 `Idempotency-Key` 重新执行，必须诊断后创建新的业务操作和新的 key。
- 批量 JSONL 路由控制字段：`page_sse`、`complex_ui`、`long_image`、`resume_or_recover` 必须是 JSON 布尔值；`transport` 可为 `page_sse`，或仅在 edit 任务中为 `agent_json`。`agent_json` 不能与 `page_sse=true` 或页面 SSE 高级字段同时使用；脚本会在 dry-run 阶段拒绝字符串布尔值、未知 transport 和跨模式路由。
- `GET /api/runtime-capabilities` 不属于 Agent capabilities。它是页面工作台读取的运行态能力摘要，用于展示流式默认值、图片上游传输配置、渠道健康、渠道队列、并发建议、Responses 后端 enablement 和缺失环境变量，不进入 Agent OpenAPI。

## 模型目录

```http
GET /api/agent/models
GET /api/agent/models?probe=true
```

模型目录端点的声明读取与主动探测使用不同强度的保护：不论是否配置 Agent token，声明读取都不触发出站请求且只返回脱敏渠道信息；配置 Bearer token 时机器客户端使用 `Authorization: Bearer <token>`，仅配置页面访问码时使用 `X-App-Password-Hash`，已登录工作台也可以使用有效的 `gptImageAccess` cookie（即使同时配置了 Agent token）。`probe=true` 必须通过 Agent 或已验证页面会话鉴权，才会由服务端向已配置渠道请求 `/models`；它可能产生出站网络请求但不触发图片生成或计费。

响应中的 `known_models[]` 是模型目录条目，`channels[]` 是按渠道分组的探测结果。`channels[].declared_models` 和 `channels[].model_allowlist_configured` 表示管理员配置的渠道白名单，`channels[].model_allowlist_state` 进一步区分 `unrestricted`、`restricted`、凭证混用的 `mixed` 和匿名脱敏兼容标记 `redacted`；`channels[].models` 表示当前声明或探测后可用的模型。`mixed` 和 `redacted` 不能被当作完整白名单，否则会错误隐藏未限制凭证可用的通用模型。未鉴权目录会清除具体白名单字段；当同一匿名渠道同时包含受限和不受限凭证时保留 `redacted`，仅用于让客户端保留通用模型选项。白名单渠道探测为空时也不会恢复通用模型选项。只有 `status=verified_usable` 的条目表示该次探测确认渠道返回了模型；`status=declared` 只表示项目或配置声明，不能当作真实可用性证明。`size_policy` 为 `legacy_allowlist` 时使用旧版四种尺寸白名单；`provider_defined` 时使用 `auto` 或正整数 `WIDTHxHEIGHT` 语法，最终能力仍由渠道 provider manifest 和上游响应决定。

新增探针、诊断或健康摘要时，先把机器契约放进 capabilities、OpenAPI 或明确的 Agent 只读端点，再让脚本消费这些字段；不要让脚本自己拼 page API、runtime API 和 Agent API 的边界逻辑。

- `defaults.image_backend`：Agent generate 默认 `images-api`。
- `defaults.stream_mode`：Agent generate 默认 `auto`。auto 会先尝试内部上游 SSE；无法产出最终图时显式回退并暴露可观测标记。
- `defaults.streaming_strategy`：Agent generate 默认 `auto`。
- `defaults.partial_images`：兼容旧客户端的默认提示值。自动模式省略 `partial_images` 时，服务端会在确定健康且满足当前 `n`、背景、尺寸和 request mode 的最终渠道后重新计算；客户端不应把该字段强行写入请求。非流式请求会校验公开的 `0..4` 输入边界，但不会向上游发送该字段。
- `upstream_profile`：当前运行时的上游能力摘要，包含 `activeProfile`、`serverProfile`、`serverProfileMixed`、`requestProfile` 与三组约束对象。
- `limits.generate_images` / `limits.edit_images` / `limits.upload_images`：当前运行时分别允许的默认生成张数、默认编辑输出张数和编辑源图数量范围。
- `limits.generate_images_by_backend` / `limits.edit_images_by_backend`：按图片后端覆盖生成或页面 SSE 编辑的输出数量范围。请求带 `image_backend` 时必须优先读取对应操作的按后端范围；旧 capabilities 未提供该字段时才退回 `limits.generate_images` 或 `limits.edit_images`。`responses-image-generation` 当前两种操作都只允许 `n=1`。
- `limits.partial_images`：当前运行时默认 profile 允许的 `partial_images` 范围。OpenAI-compatible 通常为 `1..3`，Matsca Images API 通常为 `0..4`；Agent 必须以 capabilities 返回值为准。
- `limits.partial_images_by_backend`：按图片后端覆盖 `partial_images` 范围。选择 `responses-image-generation` 或兼容别名 `responses` 时必须优先使用该字段中的 `responses-image-generation` 范围，当前通常为 `1..3`。
- `supported.image_backends`：机器可读的图片后端枚举。
- `supported.enabled_image_backends`：当前运行时可直接使用的图片后端。
- `supported.image_backend_requirements`：每个图片后端的 required env、missing env 和 enabled 状态；Responses 后端需要 `ENABLE_RESPONSES_IMAGE_BACKEND` 与 `OPENAI_RESPONSES_API_MODEL`。
- `supported.streaming_strategies`：机器可读的流式兼容策略枚举。
- `supported.stream_modes`：机器可读的 `auto`、`stream`、`non_stream` 枚举。
- `agent_jobs.supported`：当前为 `true`，表示可使用任务轮询。
- `agent_jobs.mode`：当前为 `job_polling`。
- `agent_jobs.endpoints`：路径为 `POST /api/agent/jobs/images/generate`、`GET /api/agent/jobs/{id}`、`GET /api/agent/jobs/{id}/result`。
- `agent_jobs.states`：状态机为 `queued`、`running`、`succeeded`、`failed`、`expired`。
- `agent_request_diagnostics`：Agent state 请求诊断能力。`endpoints.lookup` 支持 `request_id` 或 `idempotency_key` 查询参数；`endpoints.single` 支持按 `request_id` 路径查询；`retention.ttl_seconds` 与 Agent request TTL 一致。

普通生成默认使用 `orchestration.endpoint`，不是客户端直接选择任务端点。`agent_jobs.supported=true` 且 `mode=job_polling` 表示服务端编排和显式 `--job` 诊断路径可使用同一套任务状态机。高分辨率编辑和复杂 UI 批量生产仍按页面/批量规则使用页面端 `/api/images` SSE；页面流式有问题时，先诊断再显式选择 Agent JSON、Agent 编辑或任务路径。当前任务轮询是同一服务实例内的后台任务，结果和错误写入 Agent 状态后端；它不是跨实例持久队列。

上游请求头策略由服务端统一执行。默认 `User-Agent` 是 `visual-journal/<package-version>`；可用 `OPENAI_UPSTREAM_USER_AGENT` 或 `UPSTREAM_USER_AGENT` 覆盖全局 UA，也可用 `OPENAI_CHANNEL_N_USER_AGENT` 和 `OPENAI_CHANNEL_N_UPSTREAM_HEADERS_JSON` 覆盖单渠道安全 header。`Authorization`、`Accept`、`Content-Type`、`Content-Length` 和 `Host` 等协议头不可由 extra headers 覆盖；固定业务头和鉴权头始终由调用路径设置。

上游代理同样由服务端统一执行：`OPENAI_UPSTREAM_PROXY_URL` 为全局默认值，`OPENAI_CHANNEL_N_PROXY_URL` 可覆盖单个渠道。它们只接受无认证、无路径、无查询参数和无片段的 `http://` 或 `https://` 根代理地址，不支持 SOCKS；配置变更需重启或重新部署服务。代理适用于服务端上游 API、SSE、同源结果图下载、渠道恢复探测和 new-api 用量日志，不影响 Agent 客户端到 Playground 的连接。页面请求携带自定义 `apiBaseUrl` 时不能同时使用服务端全局代理，因为代理端无法复用请求目标的 DNS 安全校验；需要经代理访问自定义渠道时，请改为配置 `OPENAI_CHANNEL_N_BASE_URL` 和对应渠道凭证。非 loopback 的明文 API 仍必须加入 `OPENAI_ALLOWED_PLAIN_HTTP_API_BASE_URLS`；渠道恢复探测会复用同一白名单，不会因为探测路径不同而绕过或误拒绝该安全门禁。

## 任务轮询

```http
POST /api/agent/jobs/images/generate
Authorization: Bearer <token>
Idempotency-Key: <stable-key>
Content-Type: application/json
```

请求体与 `POST /api/agent/image-requests` / `POST /api/agent/images/generate` 相同。创建成功后返回：

```json
{
    "job": {
        "id": "job-request-uuid",
        "request_id": "job-request-uuid",
        "idempotency_key": "stable-key",
        "mode": "generate",
        "state": "running",
        "created_at": "2026-05-20T00:00:00.000Z",
        "updated_at": "2026-05-20T00:00:00.000Z",
        "expires_at": "2026-05-21T00:00:00.000Z",
        "result_url": "/api/agent/jobs/job-request-uuid/result",
        "retry_after_seconds": 5
    }
}
```

轮询状态：

```http
GET /api/agent/jobs/{id}
```

读取结果：

```http
GET /api/agent/jobs/{id}/result
```

`/result` 在运行中返回 `request_in_progress` 和 `Retry-After`；成功后返回标准 `AgentImageResponse`；失败时返回结构化 `AgentError`。失败 job 是终态，`error.retryable` 固定为 `false`，但保留原始错误的 `code`、`message`、`upstream_status` 和 `diagnostics` 用于排查。不存在返回 `job_not_found`，过期返回 `job_expired`。

`GET /api/agent/jobs/{id}` 在 `state=failed` 时，`job.error` 也会返回 `retryable=false`，并携带同样的 `code`、`message`、`upstream_status` 和 `diagnostics` 排障字段；`request_id` 已在 `job.request_id` 中提供。

如果服务进程在 job 结束前重启，客户端应按 `GET /api/agent/jobs/{id}` 返回的状态继续处理；必要时使用相同 `Idempotency-Key` 重新创建同一 job，避免重复业务操作。同一个 key 命中终态 failed job 时只会返回该失败状态，不会触发新执行；需要重新尝试时应创建新的业务操作和新的 `Idempotency-Key`。

## 生成图片

默认服务端编排入口：

```http
POST /api/agent/image-requests
Authorization: Bearer <token>
Idempotency-Key: <stable-key>
Content-Type: application/json
```

该入口返回 `AgentJobStatusResponse`，脚本会继续轮询 `job.result_url` 并输出标准 `AgentImageResponse`。显式诊断或兼容旧流程时才直连 Agent JSON：

```http
POST /api/agent/images/generate
Authorization: Bearer <token>
Idempotency-Key: <stable-key>
Content-Type: application/json
```

请求：

```json
{
    "prompt": "一张陶瓷杯的产品照片",
    "model": "gpt-image-2",
    "n": 1,
    "size": "1024x1024",
    "quality": "high",
    "output_format": "webp",
    "output_compression": 100,
    "background": "auto",
    "moderation": "auto",
    "response_mode": "path",
    "image_backend": "images-api",
    "stream_mode": "auto",
    "streaming_strategy": "auto",
    "partial_images": 2
}
```

Agent JSON 生成端点对外始终返回最终 JSON，不会对客户端返回 SSE。普通客户端默认不直接调用它，而是使用 `/api/agent/image-requests`。不要向该端点发送 `stream: true`。

- 页面 SSE 使用独立的 `POST /api/images` form-data 路径。
- 若 capabilities 中 `agent_streaming.upstream_sse.supported=true`，generate 可通过 `request_fields_by_mode.generate` 声明的字段控制服务端内部上游 SSE 消费。Agent JSON 的 `image_backend=responses-image-generation` 当前只支持 generate；Responses backend edit 使用页面端 `/api/images` form-data SSE。
- 不要把 `responsesModel`、`gptModel`、`gpt_model`、`thinking`、`promptOptimization`、`prompt_optimization`、`force_web`、`forceWeb`、`force_request` 或 `forceRequest` 当成选择端点的理由。脚本默认把它们交给服务端编排入口处理；显式 `--agent` 时 Agent 生成端点也接受这些字段中的 Agent JSON generate 契约字段，只有显式 `--page-sse` 才会进入 `/api/images` SSE。
- `/api/agent/image-requests` 的最终轮询结果和 Agent JSON 生成端点最终响应都使用 `AgentImageResponse`。
- `stream_mode=stream` 强制流式并直接暴露失败。
- `stream_mode=non_stream` 直接非流式。
- `stream_mode=auto` 允许显式可观测回退。

响应：

```json
{
    "request_id": "uuid",
    "idempotency_key": "stable-key",
    "cached": false,
    "images": [
        {
            "id": "artifact-uuid",
            "filename": "1715400000000-abcdef1234567890-0.webp",
            "content_url": "/api/agent/artifacts/artifact-uuid/content",
            "metadata_url": "/api/agent/artifacts/artifact-uuid",
            "output_format": "webp",
            "mime_type": "image/webp",
            "size_bytes": 12345,
            "width": 1024,
            "height": 1024
        }
    ],
    "usage": {},
    "created_at": "2026-05-12T00:00:00.000Z",
    "timing": {
        "started_at": "2026-05-12T00:00:00.000Z",
        "completed_at": "2026-05-12T00:01:04.000Z",
        "elapsed_ms": 64000,
        "server_elapsed_ms": 64000
    },
    "execution": {
        "transport": "agent_job_polling",
        "endpoint": "/api/agent/image-requests",
        "route_mode": "job",
        "operation": "generate",
        "image_backend": "images-api",
        "stream_mode": "non_stream",
        "streaming_strategy": "off",
        "selected_channel_id": "default",
        "upstream_host": "api.example.test",
        "request_headers": {
            "user_agent_effective": "visual-journal/2.3.0",
            "has_extra_headers": false,
            "allowed_header_names": ["user-agent", "x-app-id", "x-app-secret"],
            "configured_header_names": []
        }
    }
}
```

## Agent JSON 编辑图片

本节只描述 `/api/agent/images/edit`。如果需求是 Responses image_generation edit，或运行时已显式配置 `IMAGE_GENERATION_BACKEND=responses-image-generation` 或兼容别名 `responses` 且 `IMAGE_STREAMING_STRATEGY=responses-sse`，不要调用本端点；使用 `edit-image.mjs --page-sse` 或依赖页面 SSE 默认路径走 `/api/images`。Docker compose 本身不设置这两个默认值，未配置 `.env.local` 时仍是 `images-api` 和 `auto`。

```http
POST /api/agent/images/edit
Authorization: Bearer <token>
Idempotency-Key: <stable-key>
Content-Type: multipart/form-data
```

字段：

- `prompt`：必填。
- `model`：默认 `gpt-image-2`。
- `n`：默认 `1`，范围以 `GET /api/agent/capabilities` 的 `limits.edit_images` 为准。
- `size`：`auto` 或支持的尺寸。
- `quality`：`low`、`medium`、`high` 或 `auto`。
- `response_mode`：`path`、`base64` 或 `both`。
- `stream_mode`：可选，`auto`、`stream` 或 `non_stream`。
- `streaming_strategy`：可选，`off`、`auto`、`openai-sse`、`newapi-keepalive-sse`、`responses-sse` 或 `force-sse`。
- `partial_images`：可选，范围以 `GET /api/agent/capabilities` 的 `limits.partial_images` 为准。Agent edit 不接受 `image_backend`；需要 Responses backend edit 字段时必须使用页面端 `/api/images` form-data SSE 路径。
- `image_0..image_N`：源图片，`N = limits.upload_images.max - 1`。超出当前 profile 上限、跳号、`image_01` 或 `image_foo` 的图片字段会被显式拒绝。
- `mask`：可选 PNG 遮罩。

Agent edit 不接收 `image_backend`、`output_format` 或 `output_compression`。也不接受 `imageBackend`、`outputFormat`、`format`、`outputCompression`、`responses_model`/`responsesModel`、`background` 或 `moderation`。强制 Agent edit 时编辑输出格式固定为 WebP；默认 WebP 或显式页面输出字段使用页面端 `/api/images` form-data SSE。Responses image_generation 后端仅在页面 SSE `/api/images` 中支持编辑功能，Agent JSON 端点暂不支持。

当 `size` 的最大边大于 `2048` 时，默认按 `routing_rules.high_resolution_edit` 使用页面端 `/api/images` form-data SSE 路径；如果页面流式不可用或失败，可显式回退到 Agent edit 最终 JSON 路径进行诊断或执行。

## 产物元数据

```http
GET /api/agent/artifacts/{id}
GET /api/agent/artifacts/{id}/content
POST /api/agent/artifacts/{id}/share
DELETE /api/agent/artifacts/{id}
```

所有产物端点都需要和生成接口相同的鉴权。

`GET /api/agent/artifacts/{id}` 返回 Agent 产物元数据；`GET /content` 返回产物图片二进制；`POST /share` 为已有 Agent 产物复制出独立分享产物，返回 `share_url`、`direct_content_url`、过期时间和是否需要访问码；`DELETE /api/agent/artifacts/{id}` 会删除 Agent 产物文件和状态库元数据，并把关联请求标记为 `artifact_not_found`。不存在的产物返回 `artifact_not_found`。页面端 `POST /api/image-delete` 是按文件名删除页面图片文件的 WebUI API，使用页面访问码哈希和 `filenames` JSON，不等同于 Agent 产物删除。

Agent 创建分享链接的请求示例：

```http
POST /api/agent/artifacts/{id}/share
Content-Type: application/json
Authorization: Bearer <token>

{"expires_in_minutes":1440,"access_code":"optional-code"}
```

公开分享可直接打开返回的 `share_url` 或 `direct_content_url`。设置访问码的分享需要用户访问 `share_url` 并输入访问码；不要把访问码或 Agent Bearer token 拼进图片 URL。

## 结果反馈与诊断

```http
POST /api/agent/page-requests/feedback
GET /api/agent/page-requests/{id}/feedback
POST /api/agent/diagnostics/page-requests
GET /api/agent/diagnostics/page-requests/{id}
GET /api/agent/diagnostics/requests?request_id={request_id}
GET /api/agent/diagnostics/requests?idempotency_key={idempotency_key}
GET /api/agent/diagnostics/requests/{request_id}
GET /api/agent/diagnostics/channel-health
```

这些端点使用 Agent 鉴权，只读返回页面请求反馈、页面请求脱敏日志摘要、Agent state 请求诊断或当前进程的渠道健康快照。

页面请求 `{id}` 是页面端 `/api/images` SSE 的 `clientRequestId`；skill 脚本走页面 SSE 时会把 `Idempotency-Key` 写入该字段，因此通常可以用同一个业务 key 查询。页面诊断摘要来自本地 bounded app log，不是 Agent state 后端的无限历史；`GET /api/agent/capabilities` 的 `page_request_diagnostics.retention` 和诊断 API 响应的 `diagnostics_retention` 会声明当前 `APP_LOG_MAX_ENTRIES` 窗口和可能的日志丢失模式。

Agent request diagnostics 来自 Agent state 后端，适用于 `/api/agent/images/generate`、`/api/agent/images/edit` 和 Agent job 产生的请求。响应包含 `request`、`timeline`、`artifacts`、成功 `response`、失败 `error`、可选 `feedback`、`state_backend`、`diagnostics_retention` 和 `diagnostics_boundary`。该接口不会返回完整 prompt、API key、图片 base64 或本地文件路径。

渠道健康诊断来自当前服务进程已初始化的 `channel-router` 内存状态，返回渠道、凭证和请求方式的状态、冷却时间、恢复探测门禁和脱敏失败元数据。它不返回 API key、base URL、错误原文或完整上游响应；`state_initialized=false` 表示当前进程尚无可读取的路由状态，`channels` 为空，不代表未配置渠道；`healthy` 表示至少有一个有效 request mode 可用，`probe_pending` 表示恢复探测门禁仍未解除，因此可以与尚未到期的 `cooldown_until` 同时出现。`GET /api/agent/diagnostics/channel-health` 是非计费只读接口，不会为了读取而初始化路由或启动恢复探测，不触发上游探测或图片生成，也不替代页面 `/api/runtime-capabilities` 的运行态与并发配置摘要。

调用示例：

```text
node "<skill-root>/scripts/diagnose-channel-health.mjs" --base-url https://your-space.hf.space --output runs/channel-health.json
```

反馈响应形态：

```json
{
    "target": { "type": "page_request", "id": "stable-operation-key" },
    "feedback": {
        "target_type": "page_request",
        "target_id": "stable-operation-key",
        "value": "usable",
        "source": "webui",
        "updated_at": "2026-05-12T00:00:00.000Z",
        "note": "approved"
    }
}
```

尚无反馈时 `feedback` 为 `null`。诊断端点返回 `scope`、`matched_log_count` 和最多 30 条脱敏事件；事件 `diagnostics` 只包含白名单字段（如 `providerDialect`、`reason`、`image_backend`、`operation`、`upstream_status`、`upstream_event_type`、`transport_error`）且按字段类型过滤，不返回完整日志上下文。可重复传 `filename` 查询参数扩大匹配范围。

批量反馈请求用于脚本和 Agent 客户端一次查询多个页面请求 ID：

```json
{
    "ids": ["stable-operation-key", "stable-operation-key-2"]
}
```

返回 `targets` 和已存在的 `feedback` 数组；尚无反馈的目标只出现在 `targets` 中。该端点不会写入或删除反馈。

批量诊断请求用于一次查询多个页面请求 ID 的脱敏日志摘要：

```json
{
    "ids": ["stable-operation-key", "stable-operation-key-2"],
    "filenames": ["output.png"]
}
```

返回 `targets`、`diagnostics_retention` 和 `diagnostics` 数组。每个诊断项都包含 `client_request_id`、`scope`、`matched_log_count`、`diagnostics_retention` 和最多 30 条脱敏事件。`matched_log_count=0` 时诊断项会额外包含 `diagnostics_note`；它只表示当前保留窗口内没有匹配日志，可能是日志被窗口淘汰、被 `APP_LOG_LEVEL` 过滤，或本地日志文件被清理，不要把它直接解释为请求未发生。

单条无匹配日志响应示例：

```json
{
    "scope": {
        "request_ids": ["stable-operation-key"],
        "filenames": ["output.png"],
        "filename_matched_request_ids": [],
        "copy_text": "requestIds=stable-operation-key filename=output.png"
    },
    "matched_log_count": 0,
    "events": [],
    "diagnostics_retention": {
        "storage": "bounded_local_jsonl",
        "max_entries": 300,
        "default_max_entries": 300,
        "min_entries": 100,
        "max_configured_entries": 5000,
        "configured_by": "APP_LOG_MAX_ENTRIES",
        "persisted_across_process_restart": true,
        "loss_modes": ["entry_evicted_by_max_entries", "log_level_filter", "local_log_file_missing_or_cleared"],
        "bounded": true,
        "not_agent_state_backend": true
    },
    "diagnostics_note": {
        "code": "no_matching_logs_in_retention_window",
        "message": "matched_log_count=0 表示当前保留窗口内没有匹配日志；可能已被保留条数淘汰、被 APP_LOG_LEVEL 过滤，或本地日志文件被清理。",
        "retention": {
            "storage": "bounded_local_jsonl",
            "max_entries": 300,
            "default_max_entries": 300,
            "min_entries": 100,
            "max_configured_entries": 5000,
            "configured_by": "APP_LOG_MAX_ENTRIES",
            "persisted_across_process_restart": true,
            "loss_modes": ["entry_evicted_by_max_entries", "log_level_filter", "local_log_file_missing_or_cleared"],
            "bounded": true,
            "not_agent_state_backend": true
        }
    }
}
```

优先使用内置脚本：

```text
node "<skill-root>/scripts/diagnose-request.mjs" --client-request-id stable-operation-key --filename output.png
node "<skill-root>/scripts/diagnose-request.mjs" --manifest runs/product-set.manifest.jsonl --filename output.png
node "<skill-root>/scripts/diagnose-request.mjs" --manifest runs/product-set.manifest.jsonl --output runs/diagnosis.json
node "<skill-root>/scripts/diagnose-request.mjs" --agent-request-id req_abc
node "<skill-root>/scripts/diagnose-request.mjs" --idempotency-key stable-operation-key
```

固定服务地址时加 `--base-url`：

```text
node "<skill-root>/scripts/diagnose-request.mjs" --base-url https://your-space.hf.space --idempotency-key stable-operation-key
```

远程 Space、云服务或内网服务必须显式传 `--base-url`，不要让诊断脚本误查默认本地服务。

脚本输出会包含 `diagnostics_retention`。当某个请求的 `matched_log_count=0` 时，该请求会额外包含 `diagnostics_note`，说明无匹配日志的保留窗口边界。

首次配置和诊断输出字段速查：

| 字段                                                                                         | 出现位置                                                                                   | 判断口径                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service_base_url` / `verification_scope.service_base_url`                                   | `first-run`、`agent:doctor`、诊断脚本为顶层；skill 脚本 dry-run 在 `verification_scope` 下 | 当前脚本准备访问的 Playground 服务地址。                                                                                                                                                                                                                                                                        |
| `service_base_url_source` / `verification_scope.service_base_url_source`                     | `first-run`、`agent:doctor`、诊断脚本为顶层；skill 脚本 dry-run 在 `verification_scope` 下 | `user_provided` 表示用户或命令行明确指定；`GPT_IMAGE_PLAYGROUND_URL` 表示来自环境变量；`default_local_probe` 表示默认本地探测。                                                                                                                                                                                 |
| `interactive_confirmation_required` / `verification_scope.interactive_confirmation_required` | `first-run`、`agent:doctor`、诊断脚本为顶层；skill 脚本 dry-run 在 `verification_scope` 下 | 交互式任务中为 `true` 时，应先向用户确认是否使用该地址再发起真实请求。                                                                                                                                                                                                                                          |
| `agent_auth_process.has_token`                                                               | `first-run --json`                                                                         | 当前进程是否已经拿到 `GPT_IMAGE_AGENT_TOKEN` 或兼容的 `AGENT_API_TOKEN`。                                                                                                                                                                                                                                       |
| `page_sse_auth_available_to_process`                                                         | `first-run --json`                                                                         | 目标服务要求页面 SSE `passwordHash` 时，当前进程是否已加载 `GPT_IMAGE_APP_PASSWORD_HASH`。                                                                                                                                                                                                                      |
| `summary.page_sse_auth_ready`                                                                | `agent:doctor`                                                                             | 页面 SSE 鉴权是否已满足；为 `false` 时不要运行 `--page-sse` 真实计费请求。                                                                                                                                                                                                                                      |
| `page_sse_real_smoke_status`                                                                 | `first-run --json`                                                                         | 结构化说明 `first-run` 未执行真实 `/api/images` smoke；`state=not_run` 且 `billable=false` 表示它只是只读就绪检查。                                                                                                                                                                                             |
| `responses_image_backend_real_smoke_status`                                                  | `first-run --json`                                                                         | 结构化说明 `first-run` 未执行真实 Responses image_generation smoke；不要把声明支持当作实测通过。                                                                                                                                                                                                                |
| `summary.page_sse_real_smoke`                                                                | `agent:doctor`                                                                             | Page SSE 真实 smoke 的兼容聚合状态；任一 Page SSE smoke 失败为 `failed`，任一通过且无失败为 `passed`，全部跳过为 `skipped`；精确判断优先看 `summary.real_smoke_checks`。                                                                                                                                        |
| `summary.orchestration_generate_smoke`                                                       | `agent:doctor`                                                                             | `--allow-billable` 时默认 generate 主链 `/api/agent/image-requests` 的真实 smoke 状态；这是普通 generate 在 server-owned orchestration 下的主编排口径。                                                                                                                                                         |
| `summary.agent_generate_smoke`                                                               | `agent:doctor`                                                                             | `--allow-billable` 时显式 `--agent` 的 Agent JSON 文生图 smoke 状态；用于诊断直连 Agent JSON，不代表默认主链。                                                                                                                                                                                                  |
| `summary.responses_page_sse_generate_smoke`                                                  | `agent:doctor`                                                                             | `--allow-billable` 时对 `responses-image-generation` + page SSE + `responses-sse` 这条文生图路径的真实 smoke 状态；非计费时为 `skipped`。                                                                                                                                                                       |
| `summary.responses_agent_generate_smoke`                                                     | `agent:doctor`                                                                             | `--allow-billable` 时对 `responses-image-generation` + Agent JSON + `responses-non-stream` 这条文生图路径的真实 smoke 状态；非计费时为 `skipped`。                                                                                                                                                              |
| `summary.real_smoke_checks`                                                                  | `agent:doctor`                                                                             | 各真实 smoke 的状态汇总，包含 `orchestration_generate_1k`、`agent_generate_1k`、`responses_page_sse_generate_1k`、`responses_agent_generate_1k`、`agent_edit_1k` 和 `page_sse_edit_2k`。                                                                                                                        |
| `summary.request_modes`                                                                      | `agent:doctor`                                                                             | 管理员 request mode 的配置和真实 smoke 摘要，包含 `supported`、`configured`、`effective`、`admin_whitelist_by_channel`、`effective_by_channel`、带 `severity` 的 `gaps`、`suggested_channel_env_key`、`suggested_effective_value` 和 `next_action`；`billable=false` 时只能证明配置可见，不能当作真实上游通过。 |
| `request_mode_controls`                                                                      | `capabilities`                                                                             | 管理员 request mode 白名单和优先级控制面；包含 `OPENAI_UPSTREAM_REQUEST_MODES`、`OPENAI_CHANNEL_N_REQUEST_MODES`、`OPENAI_UPSTREAM_REQUEST_MODE_PRIORITY`、`OPENAI_CHANNEL_N_REQUEST_MODE_PRIORITY`、默认低费用优先顺序、真实 smoke gate 和 `agent_client_policy=diagnostics_only`。                            |
| `private_agent_env.exists`                                                                   | `first-run --json`                                                                         | 本机是否存在 `.env.agent.local` 私有配置；Agent CLI 默认从当前仓库根目录读取该文件。                                                                                                                                                                                                                            |
| `capabilities.ok`                                                                            | `first-run --json`、`agent:doctor`                                                         | 目标地址是否返回 Agent capabilities；失败时先看 HTTP 状态、鉴权提示和服务地址。                                                                                                                                                                                                                                 |
| `diagnostics_retention`                                                                      | `diagnose-request.mjs`                                                                     | 页面日志诊断的保留窗口；无匹配日志不等于请求一定没发生。                                                                                                                                                                                                                                                        |

单条 Agent state 诊断响应示例：

```json
{
    "found": true,
    "diagnostics": {
        "request": {
            "request_id": "req_abc",
            "idempotency_key": "stable-operation-key",
            "mode": "generate",
            "status": "succeeded",
            "cached": false,
            "created_at": "2026-05-12T00:00:00.000Z",
            "updated_at": "2026-05-12T00:01:04.000Z",
            "expires_at": "2026-05-13T00:00:00.000Z"
        },
        "response": {
            "image_count": 1,
            "artifact_ids": ["artifact-uuid"],
            "content_urls": ["/api/agent/artifacts/artifact-uuid/content"],
            "timing": {
                "elapsed_ms": 64000,
                "server_elapsed_ms": 64000
            },
            "execution": {
                "transport": "agent_json",
                "endpoint": "/api/agent/images/generate",
                "request_headers": {
                    "user_agent_effective": "visual-journal/2.3.0",
                    "has_extra_headers": false,
                    "allowed_header_names": ["user-agent", "x-app-id", "x-app-secret"],
                    "configured_header_names": []
                }
            }
        },
        "state_backend": "sqlite",
        "diagnostics_retention": {
            "storage": "agent_state",
            "ttl_seconds": 86400,
            "bounded": true,
            "loss_modes": ["request_expired_by_ttl", "artifact_deleted_or_purged", "state_backend_reset"]
        }
    }
}
```

## 页面 API 边界

这些端点服务页面工作台，不属于 Agent JSON API，也不进入 `GET /api/agent/openapi.json`：

- `POST /api/images`：页面 form-data 图片端点。它支持 `mode=generate|edit`、`stream=true` 的页面 SSE、`clientRequestId`、页面 `passwordHash` 表单鉴权，以及 `responsesModel`、`gptModel`、`thinking`、`promptOptimization`、`force_web` 等页面高级字段。skill 脚本只在 capabilities 的 `agent_streaming.page_sse` 或路由规则需要时使用它。
- `PUT /api/feedback`：页面结果反馈写入端点。页面把最近生成的可用性标记和备注写入服务端状态；Agent 只读查询使用 `/api/agent/page-requests/{id}/feedback` 或 `/api/agent/page-requests/feedback`。
- `DELETE /api/feedback`：页面结果反馈清理端点。页面删除历史时按 `clientRequestId` 清理对应服务端反馈；该端点不接受 Agent Bearer token。
- `GET /api/runtime-capabilities`：页面运行态能力摘要。它暴露流式默认值、图片上游传输配置、渠道健康、渠道队列、并发建议和 Responses 后端 enablement，不返回 API key 或本地密钥。它不替代也不被 Agent 的 `/api/agent/diagnostics/channel-health` 替代。
- `POST /api/shares`：页面分享上传创建端点。配置 `APP_PASSWORD` 时要求页面访问 cookie；请求是 form-data `image`、`sourceFilename`、`expiresInMinutes` 和可选 `accessCode`。Agent 客户端不要用它上传产物；应使用 `/api/agent/artifacts/{id}/share`。
- `GET /api/shares/{token}`、`GET /api/shares/{token}/content` 和 `POST /api/shares/{token}/content`：分享元数据和图片内容端点。公开分享支持浏览器直接 GET 内容；私密分享的内容读取通过分享页 POST JSON `accessCode` 校验，并有访问码失败限流；这不是 Agent 产物下载。
- `GET /api/logs`：页面日志 SSE。必须配置 `APP_PASSWORD`，并在 `Authorization: Bearer <sha256(APP_PASSWORD)>` 中发送访问码哈希；查询参数中的哈希会被拒绝。它不接受 `AGENT_API_TOKEN`。Agent 只读诊断使用 `/api/agent/diagnostics/page-requests/{id}`。
- `POST /api/image-delete`：页面图片文件删除端点。请求 JSON 为 `filenames` 和可选 `passwordHash`，按页面生成文件名删除 `generated-images/` 中的图片；它不删除 Agent 状态库产物记录。

灵感相册和历史复用属于页面工作台和浏览器本地体验。当前没有对应的 Agent capabilities 字段，也不作为机器 API 契约承诺。

### 边界矩阵

| 前端能力或端点                                                                                                                                                          | 归属契约                   | 进入 Agent OpenAPI | 自动化口径                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agent/image-requests`、`POST /api/agent/images/generate`、`POST /api/agent/images/edit`、Agent jobs、Agent artifacts、`POST /api/agent/artifacts/{id}/share` | Agent API                  | 是                 | 普通 generate 默认用 image-requests；其他 Agent 端点通过 skill 脚本和 Agent 鉴权调用。分享创建需要 Agent 鉴权，返回的分享 URL 给用户浏览器访问。                                                                     |
| `GET /api/agent/diagnostics/channel-health`                                                                                                                             | Agent 只读渠道健康诊断 API | 是                 | 只返回当前服务进程的路由内存快照，不触发上游探测或图片生成；需 Agent 鉴权，不能证明真实上游可用，也不替代页面 runtime capabilities。                                                                                 |
| `POST /api/images`                                                                                                                                                      | 页面 form-data SSE API     | 否                 | 仅在默认 WebP edit、复杂 UI 批量、页面高级字段或显式 `--page-sse` 诊断时由 skill 选择。                                                                                                                              |
| `GET /api/runtime-capabilities`                                                                                                                                         | 页面运行态能力 API         | 否                 | 页面展示运行态默认值、图片上游传输配置、渠道健康和后端 enablement；不是 Agent capabilities。                                                                                                                         |
| `PUT/DELETE /api/feedback`                                                                                                                                              | 页面结果反馈写入和清理 API | 否                 | 页面写入最近生成的结果反馈；删除历史时清理对应反馈。                                                                                                                                                                 |
| `POST /api/agent/page-requests/feedback`                                                                                                                                | Agent 结果反馈批量只读 API | 是                 | 按多个页面 `clientRequestId` 批量查询最新反馈。                                                                                                                                                                      |
| `GET /api/agent/page-requests/{id}/feedback`                                                                                                                            | Agent 结果反馈只读 API     | 是                 | 按页面 `clientRequestId` 查询最新反馈。                                                                                                                                                                              |
| `POST /api/agent/diagnostics/page-requests`                                                                                                                             | Agent 日志诊断批量只读 API | 是                 | 按多个页面 `clientRequestId` 批量查询脱敏日志摘要。                                                                                                                                                                  |
| `GET /api/agent/diagnostics/page-requests/{id}`                                                                                                                         | Agent 日志诊断摘要 API     | 是                 | 按页面 `clientRequestId` 查询脱敏日志摘要，不直接读取 `/api/logs` SSE。                                                                                                                                              |
| `POST /api/shares`、`GET /api/shares/{token}`、`GET/POST /api/shares/{token}/content`                                                                                   | 分享访问 API               | 否                 | `POST /api/shares` 是页面上传创建端点，不进入 Agent OpenAPI；`GET/POST /content` 使用分享 token 或访问码服务用户浏览器，不复用 Agent 产物下载契约。Agent 只通过 `/api/agent/artifacts/{id}/share` 创建这类分享记录。 |
| `GET /api/logs`                                                                                                                                                         | 页面日志 SSE API           | 否                 | 使用页面访问码哈希的 Bearer 头，不接受 `AGENT_API_TOKEN`。                                                                                                                                                           |
| `POST /api/image-delete`                                                                                                                                                | 页面图片文件删除 API       | 否                 | 按页面文件名删除 `generated-images/` 文件，不删除 Agent 状态库产物。                                                                                                                                                 |
| 灵感相册                                                                                                                                                                | 浏览器本地工作台状态       | 否                 | 只服务页面提示词复用，不作为 Agent capabilities。                                                                                                                                                                    |
| 历史复用                                                                                                                                                                | 浏览器本地历史状态         | 否                 | 只服务页面继续编辑、做变体和复用提示词。                                                                                                                                                                             |

## 错误

错误使用结构化格式：

```json
{
    "error": {
        "code": "validation_error",
        "message": "请求校验失败。",
        "retryable": false,
        "details": {
            "fields": {
                "n": "必须是 1 到 10 之间的整数"
            }
        },
        "diagnostics": {
            "elapsed_ms": 1234,
            "selected_channel_id": "default",
            "upstream_host": "api.example.test",
            "upstream_status": 524,
            "upstream_event_type": "image_generation.partial_image",
            "partial_image_count": 1,
            "transport_error": false,
            "transport_error_kind": "upstream_timeout",
            "retry_after_seconds": 15,
            "retry_after_ms": 15000,
            "cooldown_until": "2026-05-20T00:00:15.000Z",
            "cooldown_target": {
                "channel_id": "default",
                "request_mode": "images-sse"
            },
            "channel_cooldown_scope": "channel",
            "response_headers": {
                "date": "Wed, 20 May 2026 00:00:00 GMT",
                "cf-ray": "example"
            }
        },
        "request_id": "uuid"
    }
}
```

`diagnostics` 只包含脱敏诊断字段和白名单响应头，不包含 API key、token、完整上游响应体或图片 base64。SDK/网络层只有 `Connection error.` 时，`transport_error` 会是 `true`，但不会伪造 `upstream_status`。`diagnostics.route_decision` 与成功响应的 `execution.route_decision` 同口径，用于解释服务端为何选择或未能选择某个上游请求方式。如果页面 SSE 请求返回 `page_sse_failed`、`503`、断流，且 `summary.selected_channel_id` 与 `summary.upstream_host` 为空，按页面流式路径未跑通处理；先用 `diagnose-request.mjs` 读取结构化摘要，再用新的 `Idempotency-Key` 显式选择 Agent JSON 或 job，不自动回退。

常见错误码：

- `validation_error`
- `unauthorized`
- `configuration_error`
- `idempotency_key_required`
- `idempotency_conflict`
- `request_in_progress`
- `artifact_not_found`
- `job_not_found`
- `job_expired`
- `upstream_rate_limited`
- `upstream_auth_failed`
- `upstream_unavailable`
- `unexpected_error`
