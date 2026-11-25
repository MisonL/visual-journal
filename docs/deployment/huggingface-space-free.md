# Hugging Face Space 部署指南

本文档描述如何把本项目部署到 Hugging Face Docker Space，用作公网图片生成服务。Docker Space 的创建和更新权限取决于 Hugging Face 的当前账户政策；固定目标已存在且元数据标识为 Docker，部署脚本会直接使用认证 Git 推送，避免 `hf upload` 触发创建接口的已知 `402`。这不绕过新建 Docker Space 的账户限制。

## 目标形态

- 手机浏览器可以访问 Space 网页并正常生图。
- 电脑上的 Agent 可以通过 `/api/agent/*` 调用同一个 Space 生图。
- 首战场景是中文内容运营者为小红书笔记、商品详情页或活动海报生成首版视觉稿，不是公开软件即服务平台。
- 状态后端使用 `memory`，不依赖 SQLite、PostgreSQL 或外部数据库。
- 图片网页结果优先保存在浏览器 IndexedDB，减少服务端临时磁盘依赖。

## Space README 元数据

本仓库顶层 `README.md` 已包含 Hugging Face Space 元数据。如果你维护的是单独的 Space 仓库，确认它的 `README.md` 顶部使用 Docker SDK，并暴露本项目端口：

```yaml
---
sdk: docker
app_port: 4783
---
```

官方依据：

- Docker Space 配置、变量/密钥和权限说明：https://huggingface.co/docs/hub/main/spaces-sdks-docker
- Space 硬件与计费政策：https://huggingface.co/docs/hub/main/spaces-gpus
- Hugging Face CLI 安装和登录说明：https://huggingface.co/docs/huggingface_hub/en/guides/cli

## 全新电脑前置条件

全新用户、全新电脑需要先准备系统级工具。没有 Node.js 和 npm 时，仓库内 npm 脚本无法运行；没有 HF CLI 登录时，脚本无法把密钥写到远端 Space。

先检查：

```bash
node --version
npm --version
hf --help
hf auth whoami
```

要求：

- Node.js >=22.15.0。
- npm 随 Node.js 一起可用。
- Hugging Face CLI 使用当前官方 `hf` 命令。
- `hf auth login` 使用 Hugging Face 访问令牌，不是账号密码。
- Docker 仅在本地 Space 近似容器冒烟验证（推荐 `npm run smoke:hf-space-local`，兼容别名 `npm run smoke:hf-space`）和本地容器验证时必需；远端部署由 `npm run deploy:space` 统一执行。

安装 Hugging Face CLI 时，以官方文档为准。不要把远程安装脚本直接管道到 shell；如需使用官方脚本，先下载、核对来源和内容后再执行。

第一次拉取仓库后安装依赖：

```bash
npm run install-scripts:check
npm run npm-install-policy:check
npm ci --strict-allow-scripts
npm run dependencies:check
```

项目支持 Node.js >=22.15.0；本地先校验锁文件中的安装脚本白名单，并确认 npm 支持 `--strict-allow-scripts`，完成确定性安装后核对直接依赖。旧 npm 会被安装门禁明确拒绝，升级 npm 后再重试。GitHub Actions 和 Docker 使用 Node 26，并额外启用 npm 的 `--strict-allow-scripts`。

如果不确定当前机器缺什么，运行只读诊断：

```bash
npm run doctor
```

`doctor` 会检查 Node、npm、`hf` CLI、HF 登录状态、`node_modules`、git、Docker、固定 Space 目标、远端变量和远端密钥。该命令不会写远端密钥、不会重启 Space、不会打印密钥值。

## 管理员命令中心

本仓库只保留一组稳定管理员入口：

```bash
npm run status
npm run doctor
npm run verify
npm run deploy:local
npm run deploy:space
npm run agent:doctor
```

- `status`：只读输出 git、Node、固定 Space 目标、Agent 能力声明路径和 Skill 入口。
- `doctor`：统一诊断入口，默认包含 HF Space 只读远端检查，并校验当前 npm 是否支持严格安装脚本策略、本地 `node_modules` 隐藏锁文件和直接依赖版本是否与根锁文件一致。
- `verify`：提交前基线，先核对锁文件安装脚本与 `allowScripts` 白名单、当前 npm 严格安装策略能力和已安装直接依赖，再执行测试、静态检查、脚本语法、构建和 `git diff --check`；需要真实 PostgreSQL 门禁时加 `--postgres`。
- `deploy:local`：拒绝脏工作区后重建本地 Docker 服务，等待健康检查、核验镜像版本并探测真实 HTTP 端点；加 `--memory` 会断言 memory/indexeddb 覆盖配置生效，加 `--postgres` 会断言 postgres/fs 覆盖配置生效且要求通过 Shell 或 Compose `.env` 提供 `GPT_IMAGE_POSTGRES_PASSWORD`。默认 Compose 只绑定 `127.0.0.1:4783`；需要非回环发布时必须显式设置 `VJ_BIND_HOST` 和 `APP_PASSWORD`。
- `deploy:space`：上传当前干净 git HEAD 到固定 HF Space，并做只读公网验证；已存在 Docker Space 根据远端元数据直接使用认证 Git 推送，其他类型才优先尝试 `hf upload`。
- `agent:doctor`：通过仓库 Skill 脚本执行只读 Agent API 契约检查，不触发真实生图。

HF Space 交互使用官方 `hf` CLI。不要维护本机访问文件，不要把 `APP_PASSWORD`、`AGENT_API_TOKEN`、OpenAI 密钥或 Hugging Face 令牌写入仓库文件。

部署当前干净的 git HEAD 到固定 Space：

```bash
npm run deploy:space
```

该脚本会：

- 使用 `git status --porcelain` 拒绝脏工作区。
- 使用 `git archive HEAD` 生成临时源码目录，只上传已跟踪源码。
- Space 发布包会排除根目录 `readme-images/` 中的 README 文档截图，以兼容 Hugging Face Git 的二进制文件门禁；Space README 会改用对应 GitHub 提交的不可变图片地址。
- 读取远端 Space 元数据；当前固定 Docker Space 直接克隆、同步已跟踪源码并使用认证 Git 推送。
- 非 Docker Space 才优先使用 `hf upload`；仅当它命中既有 Docker Space 创建政策 `402` 时才回退到认证 Git 推送，其他错误不会自动回退。
- 等待新 Space 提交进入 `RUNNING`。
- 检查 `/api/auth-status`、`/api/agent/capabilities` 和 `/api/runtime-capabilities`，不触发真实生图。

配置或轮换变量/密钥时，直接使用官方 `hf` CLI：

```bash
hf spaces variables add misonL/visual-journal -e AGENT_STATE_BACKEND=memory
hf spaces variables add misonL/visual-journal -e NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb
hf spaces variables add misonL/visual-journal -e APP_LOG_LEVEL=warn
hf spaces secrets add misonL/visual-journal -s APP_PASSWORD=<page-access-code>
hf spaces secrets add misonL/visual-journal -s AGENT_API_TOKEN=<long-random-agent-token>
```

源码部署、远端诊断、变量和密钥都由仓库命令与 `hf` CLI 协同完成；部署回退只使用现有 Git 凭据，不维护第二套访问文件或密钥同步流程。

## Space 变量

在 Space Settings 中添加这些变量：

```dotenv
AGENT_STATE_BACKEND=memory
NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb
APP_LOG_LEVEL=warn
```

`NEXT_PUBLIC_IMAGE_STORAGE_MODE` 是构建期和运行期都需要的值。Dockerfile 已声明构建参数，Hugging Face Docker Space 会把同名变量作为构建参数传入构建，并在运行期注入环境变量。

如果不使用 `memory`，再按实际状态后端追加可选变量：

```dotenv
AGENT_SQLITE_PATH=generated-images/.agent-state/agent.sqlite
AGENT_DATABASE_URL=postgres://...
AGENT_DB_PASSWORD=<database-password>
AGENT_DB_PASSWORD_FILE=/path/to/password-file
```

`AGENT_DATABASE_URL`、`AGENT_DB_PASSWORD` 和 `AGENT_DB_PASSWORD_FILE` 是 PostgreSQL 配置路径，不需要在 `memory` 模式下设置为空值。

可选：

```dotenv
AGENT_PUBLIC_BASE_URL=https://<user>-<space>.hf.space
```

`AGENT_PUBLIC_BASE_URL` 影响 OpenAPI `servers[0].url`，也用于 `POST /api/agent/artifacts/{id}/share` 返回用户可打开的分享外链。必须填写绝对 `http`/`https` URL，不能包含凭据、查询参数或片段；Agent skill 仍应以 `GPT_IMAGE_PLAYGROUND_URL` 指向实际 Space 地址。

## Space 密钥

在 Space Settings 中添加密钥，不要写入仓库文件：

```dotenv
OPENAI_API_KEY=<你的 API 密钥>
OPENAI_API_BASE_URL=https://api.openai.com/v1
# 可选：仅服务端到上游的无认证 HTTP(S) 代理。
OPENAI_UPSTREAM_PROXY_URL=http://proxy.internal:8080
APP_PASSWORD=<page-access-code>
AGENT_API_TOKEN=<足够长的随机 Agent 令牌>
```

`OPENAI_API_BASE_URL` 和 `OPENAI_CHANNEL_N_BASE_URL` 必须是无凭据、无查询参数和无片段的 `http` 或 `https` 绝对地址，通常以 `/v1` 结尾。公网 Space 推荐使用 `https` 上游；只有内网、专用代理或已确认的兼容渠道需要 `http` 时才配置 `http`。

`OPENAI_UPSTREAM_PROXY_URL` 只影响 Space 服务端到上游 API 的出站连接，不影响用户浏览器访问 Space。它仅接受无认证、无路径、无查询参数和无片段的 `http://` 或 `https://` 根代理地址，不支持 SOCKS。多渠道部署可用 `OPENAI_CHANNEL_N_PROXY_URL` 覆盖全局代理，渠道级值优先。代理地址即使不含凭据也建议作为 Space Secret 管理；修改后需要重新启动或重新部署 Space。运行态和 Agent 诊断只公开是否配置及协议，不公开主机或端口。

公网部署建议至少设置访问码 `APP_PASSWORD` 和 `AGENT_API_TOKEN`。如果不设置 `APP_PASSWORD`，任何人都可以打开网页并消耗服务端 API 密钥。

如果要把这个 Space 当成客户可见的公网服务，`npm run doctor:hf-space` 的 `remote-secrets` 必须通过，且应同时看到 `APP_PASSWORD` 和 `AGENT_API_TOKEN` 已配置。没有这两个值时，只适合本地或受控内网试用，不适合直接给客户公开。

如果使用服务端渠道池，改用 `OPENAI_CHANNEL_N_*` 密钥：

```dotenv
OPENAI_ROUTING_STRATEGY=round_robin
OPENAI_CHANNEL_1_ID=official
OPENAI_CHANNEL_1_BASE_URL=https://api.openai.com/v1
OPENAI_CHANNEL_1_API_KEYS=<key-a>,<key-b>
# 可选：仅覆盖此渠道的全局上游代理。
OPENAI_CHANNEL_1_PROXY_URL=http://channel-proxy.internal:8080
```

## 手机网页使用

1. 打开 Space 地址，例如 `https://<user>-<space>.hf.space`。
2. 如果配置了 `APP_PASSWORD`，输入页面访问码。
3. 直接填写提示词并生图。若 Space 没有配置服务端 API Key，也可以在右上角 `API 设置` 中填写自己的 API Key 和 API URL。
4. `NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb` 时，图片结果保存在当前浏览器 IndexedDB。换设备、清理浏览器数据或隐私模式退出后，本地历史可能消失。

## 电脑端 Agent API 使用

先做只读契约检查，不触发真实生图：

```bash
GPT_IMAGE_PLAYGROUND_URL=https://<user>-<space>.hf.space \
GPT_IMAGE_AGENT_TOKEN=<agent-token> \
GPT_IMAGE_AGENT_CONTRACT_CHECK=1 \
node skills/visual-journal-image-agent/scripts/generate-image.mjs
```

真实文生图请求：

```bash
GPT_IMAGE_PLAYGROUND_URL=https://<user>-<space>.hf.space \
GPT_IMAGE_AGENT_TOKEN=<agent-token> \
node skills/visual-journal-image-agent/scripts/generate-image.mjs \
  --allow-billable \
  "木桌上的陶瓷杯产品照片"
```

脚本会先读取 `GET /api/agent/capabilities`，再调用 Agent API。成功响应会保留相对 `content_url`，同时补充 `absolute_content_url` 和 `absolute_metadata_url`，便于在桌面环境直接下载产物。

远端 Agent 调用不要硬编码路径。普通文生图默认提交业务意图到能力声明的 `orchestration.endpoint`，由服务端选择内部执行路径、上游请求方式和轮询方式；Agent 客户端不按尺寸、远端 HTTPS 或流式参数自行选择 Images、Responses、SSE 或非流式路径。显式 page_sse 诊断、默认 WebP 编辑、高分辨率编辑和复杂批量仍按 Skill 规则使用页面端 `/api/images` SSE；页面流式失败或不可用时，先诊断结构化错误，再用新的 `Idempotency-Key` 显式选择 Agent JSON、Agent 编辑或任务路径对照。任务轮询只在显式选择时使用。需要诊断对照时可用 `--agent` 或 `--streaming-strategy off` 强制 Agent JSON，也可用 `--page-sse` 或 `--job` 显式选择路径。

如果 Space 同时配置了 `APP_PASSWORD` 和 `AGENT_API_TOKEN`，Agent JSON 端点用 `GPT_IMAGE_AGENT_TOKEN` 发送 Bearer token；页面端 `/api/images` SSE 仍按 capabilities 的 `agent_streaming.page_sse.auth` 判断，可能需要额外设置 `GPT_IMAGE_APP_PASSWORD_HASH`，并通过 form-data `passwordHash` 发送页面访问码哈希。页面 SSE 会把业务 key 写入 `clientRequestId`，长度上限以 capabilities 中的 `agent_streaming.page_sse.client_request_id.max_length` 为准。

## 本地 HF 近似冒烟验证

提交前运行：

```bash
npm run smoke:hf-space-local
```

该命令会：

- 使用 `NEXT_PUBLIC_IMAGE_STORAGE_MODE=indexeddb` 构建 Docker 镜像。
- 以 `AGENT_STATE_BACKEND=memory` 启动临时容器。
- 用手机 User-Agent 检查首页可访问。
- 检查 `/api/agent/capabilities` 返回 `state_backend=memory` 和 `image_storage_mode=indexeddb`。
- 默认等待容器 HTTP ready 最多 45 秒；慢机器可设置 `HF_SPACE_SMOKE_READY_TIMEOUT_MS=90000`。
- 执行 Agent 生成和编辑脚本的契约检查，不触发真实上游生图。

## 平台与运行限制

- Docker Space 的创建、更新和可用硬件受 Hugging Face 当前账户政策约束。`hf upload` 对已存在 Space 的创建接口检查收到 `402` 时，脚本会尝试认证 Git 推送；新建 Docker Space 仍需要满足平台账户要求。
- CPU Basic 适合公开演示和轻量使用，不适合长期高并发；长时间无访问后可能休眠。需要真正永不休眠或自定义休眠时间时，应使用满足平台要求的付费硬件。
- Docker Space 重启后容器磁盘写入会丢失。`memory` 状态后端的 Agent 幂等记录、回放状态和分享元数据也会丢失。
- Agent API 仍会把产物图片写入容器临时文件系统，以便提供 `content_url` 下载。重启后这些链接不保证继续有效。
- 需要长期保存图片、分享链接或 Agent 回放状态时，不应使用纯内存模式。应切换到 PostgreSQL 加持久卷或外部对象存储。

## 公网客户门槛

如果把 Space 对外提供给客户使用，至少要满足以下门槛：

- 先执行 `npm run deploy:space`，确保当前干净 git HEAD 已上传到固定 Space。
- 再用真实浏览器打开 Space，确认页面能进入并完成一次真实的浏览器检查。
- 仅有 `npm run doctor:hf-space` 的远端可达与密钥检查，不足以证明客户可见上线。
- `APP_PASSWORD` 已设置，网页不会裸露给匿名访问者。
- `AGENT_API_TOKEN` 已设置，自动化调用不会回退到页面访问码哈希。
- `npm run doctor:hf-space` 的 `remote-secrets` 检查通过。
- 共享链接明确保留访问码和有效期的默认控制，不把无访问码永久链接当成默认发布形态。
- Space 重启丢失分享元数据和 Agent replay 的前提已被客户知晓。

## Space 保活

本仓库提供 GitHub Actions 定时保活，降低 CPU Basic 因长时间无访问进入休眠的概率：

- 工作流文件：`.github/workflows/hf-space-keepalive.yml`
- 默认频率：每 6 小时一次，可手动触发 `workflow_dispatch`
- 默认目标：`https://misonl-visual-journal.hf.space/api/auth-status`
- GitHub Actions 使用 Node 26，并在最多 4 次请求中按 5 秒、10 秒、20 秒退避重试；每次超时 30 秒。失败日志会记录 HTTP 状态、响应类型和下一次等待时间，不把失败伪装成成功，也不会输出上游响应正文。
- 行为边界：只访问只读鉴权状态端点，不携带 `APP_PASSWORD`、`AGENT_API_TOKEN` 或 OpenAI Key，不触发生图、不访问 Agent 生成接口。

如果 Space 地址变化，在 GitHub 仓库 Variables 中设置：

```text
HF_SPACE_KEEPALIVE_URL=https://<user>-<space>.hf.space
```

本地手动验证：

```bash
HF_SPACE_KEEPALIVE_URL=https://<user>-<space>.hf.space \
HF_SPACE_KEEPALIVE_EXPECT_PASSWORD_REQUIRED=true \
HF_SPACE_KEEPALIVE_MAX_ATTEMPTS=4 \
HF_SPACE_KEEPALIVE_RETRY_DELAY_MS=5000 \
HF_SPACE_KEEPALIVE_RETRY_MAX_DELAY_MS=20000 \
npm run keepalive:hf-space
```

注意：保活是尽力而为机制，不能保证绕过 Hugging Face 平台维护、重启或政策限制。若需要平台级保证，应使用满足平台要求的硬件并设置永不休眠。

## 验证门禁

GitHub Actions 的 `.github/workflows/ci.yml` 会在 Pull Request、`main` 分支推送和手动触发时先核对锁文件安装脚本与 `allowScripts` 白名单、npm 的严格安装脚本能力，再以严格白名单模式安装依赖并核对直接依赖完整性，随后执行版本元数据检查、完整依赖审计、测试、源码静态检查、脚本语法检查、生产构建、工作流静态检查、Dockerfile 与基础 Compose 加 memory/PostgreSQL 覆盖配置检查。它还会构建和启动生产镜像后验证 `/api/auth-status`，并在独立任务中运行真实 PostgreSQL 状态契约。

最小验证：

```bash
npm run install-scripts:check
npm run npm-install-policy:check
npm run dependencies:check
npm test
npm run lint
npm run lint:scripts
npm run build
npm run keepalive:hf-space
npm run smoke:hf-space-local
git diff --check
```

真实 Hugging Face 门禁：

1. 提交代码后执行 `npm run deploy:space`，等待 Space 新提交进入 `RUNNING`。
2. 用真实浏览器打开 Space，确认页面可进入并至少完成一次页面检查。
3. 电脑执行 `GPT_IMAGE_AGENT_CONTRACT_CHECK=1` 契约检查。
4. 如有可用测试额度，再执行一次真实 Agent 生成。
5. 重启 Space 后确认旧 Agent 回放状态和旧临时产物丢失符合预期。
6. 如果未执行第 1 步和第 2 步，必须在门禁报告里明确标注残余外部门禁未验证。
