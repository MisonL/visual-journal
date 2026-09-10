---
title: 图像手记 / Visual Journal
short_description: 本地优先的 AI 图片创作工作台
sdk: docker
app_port: 4783
---

# 图像手记 / Visual Journal

![版本](https://img.shields.io/badge/version-2.3.0-blue)
![许可证](https://img.shields.io/badge/license-MIT-green)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.15.0-339933)

图像手记（Visual Journal）是本地优先的 AI 图片创作工作台，支持 `gpt-image-2`、配置的自定义图片模型与 OpenAI 兼容图片接口。提供文生图、图生图、遮罩编辑、批量任务、历史复用、费用追踪、多渠道路由和 Agent API。

对外产品名称、npm 包名和 Agent Skill 标识均为“图像手记 / Visual Journal”（`visual-journal`、`visual-journal-image-agent`）。HF Space 已使用 `visual-journal` 名称；为保持已有部署和自动化客户端兼容，Docker 服务、环境变量和 API 路径继续使用 `gpt-image-playground` 相关技术名称。

<p align="center">
  <img src="./readme-images/interface.jpg" alt="图像手记主界面" width="900"/>
</p>

## 快速开始

基础要求是 Node.js >=22.15.0 和 npm；使用容器部署时还需要 Docker Desktop 或 Docker Engine。

### Docker 部署

先执行只读检查，再构建并启动本地服务：

```bash
npm run first-run
npm run deploy:local
```

打开 [http://localhost:4783](http://localhost:4783)，在页面右上角的 `API 设置` 中填写 API 密钥和兼容接口地址即可使用。

也可以复制环境变量模板，配置服务端默认上游：

```bash
cp .env.example .env.local
```

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_API_BASE_URL=https://api.openai.com/v1
```

### 开发模式

```bash
npm run install-scripts:check
npm run npm-install-policy:check
npm ci --strict-allow-scripts
npm run dependencies:check
npm run dev
```

Windows、macOS 和 Linux 也可分别使用 `start-windows.bat`、`start-macos.sh`、`start-linux.sh`。

## 核心能力

- 图片创作：文生图、图生图、遮罩编辑、单图和多图输出。
- 输出控制：尺寸、质量、格式、压缩率、透明背景和流式策略。
- 批量生产：多提示词任务、并发控制、失败续跑和清单记录。
- 工作台体验：灵感相册、历史复用、继续编辑、变体、下载、分享和反馈。
- 费用与诊断：耗时、令牌用量、估算费用、实际扣费和脱敏日志摘要。
- 上游路由：单密钥、多渠道、多密钥、渠道队列、失败冷却和代理支持。
- 自动化接口：幂等请求、异步任务、产物追踪、分享和请求诊断。
- 存储选择：文件系统、IndexedDB、SQLite、PostgreSQL 和内存状态。

## 界面预览

<p align="center">
  <img src="./readme-images/mask-creation.jpg" alt="遮罩编辑界面" width="49%"/>
  <img src="./readme-images/history.jpg" alt="历史与费用面板" width="49%"/>
</p>

## 配置

完整配置、默认值和高级示例见 [.env.example](./.env.example)。常用变量如下：

| 场景               | 变量                                                             | 说明                                                                                          |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 默认上游           | `OPENAI_API_KEY`、`OPENAI_API_BASE_URL`                          | 配置服务端默认 OpenAI 或兼容接口。页面 `API 设置` 优先级更高。                                |
| 默认模型           | `OPENAI_IMAGE_MODEL`                                             | 设置页面、Agent 和模型目录在省略 `model` 时使用的默认图片模型；未设置时为 `gpt-image-2`。     |
| 多渠道             | `OPENAI_CHANNEL_N_*`                                             | 配置多个渠道、多个 key、请求方式白名单和渠道级覆盖。                                          |
| 上游代理           | `OPENAI_UPSTREAM_PROXY_URL`、`OPENAI_CHANNEL_N_PROXY_URL`        | 仅代理服务端到图片上游的 HTTP(S) 请求。                                                       |
| 主机 TUN/fake DNS  | `OPENAI_TUN_MODE`、`OPENAI_ALLOW_SYNTHETIC_DNS_IPS`              | 默认关闭；TUN 主机可使用 `OPENAI_TUN_MODE=synthetic-dns`，仅放行明确受限的合成 DNS 地址。       |
| 页面访问码         | `APP_PASSWORD`                                                   | 设置后，页面生图和受保护图片需要访问码。公网部署建议开启。                                    |
| Agent 鉴权         | `AGENT_API_TOKEN`                                                | 设置后，`/api/agent/*` 需要 Bearer 令牌。                                                     |
| Agent 客户端 token | `GPT_IMAGE_AGENT_TOKEN`                                          | Skill 独立脚本使用的本机 token 别名；DSH 插件优先读取 `AGENT_API_TOKEN`，未设置时回退此变量。 |
| Agent 状态         | `AGENT_STATE_BACKEND`                                            | 支持 `memory`、`sqlite` 和 `postgres`；Compose 默认使用 SQLite。                              |
| 图片存储           | `NEXT_PUBLIC_IMAGE_STORAGE_MODE`                                 | 支持 `fs` 和 `indexeddb`；Compose 默认使用文件系统。                                          |
| 图片清理           | `WEBUI_IMAGE_AUTO_CLEANUP_ENABLED`、`WEBUI_IMAGE_RETENTION_DAYS` | 默认关闭；启用后默认保留 30 天。                                                              |

配置优先级：

```text
页面 API 设置 > OPENAI_CHANNEL_N_* 渠道池 > OPENAI_API_KEY 默认配置
```

多渠道最小示例：

```dotenv
OPENAI_ROUTING_STRATEGY=round_robin

OPENAI_CHANNEL_1_ID=official
OPENAI_CHANNEL_1_BASE_URL=https://api.openai.com/v1
OPENAI_CHANNEL_1_API_KEYS=your-primary-key
OPENAI_CHANNEL_1_REQUEST_MODES=images-non-stream,images-sse

OPENAI_CHANNEL_2_ID=backup
OPENAI_CHANNEL_2_BASE_URL=https://your-compatible-api.example.com/v1
OPENAI_CHANNEL_2_API_KEYS=your-backup-key
OPENAI_CHANNEL_2_REQUEST_MODES=images-non-stream
```

请求方式白名单只能填写已通过真实上游冒烟验证、且结果能被本服务消费的模式。未配置时默认只允许 `images-non-stream`；显式流式或 Responses 请求失败时不会静默降级。

代理 URL 仅支持无认证、无路径的 `http://` 或 `https://` 根地址，不支持 SOCKS。代理只影响服务端出站请求，不改变浏览器到本服务的连接。

如果部署主机启用了 TUN/fake DNS，且上游域名在主机或 Docker 内解析到 RFC 2544 `198.18.0.0/15`，请使用专用 Compose 覆盖：

```bash
npm run deploy:local -- --tun
```

该覆盖等价于设置 `OPENAI_TUN_MODE=synthetic-dns`。它不会把 Docker 容器加入主机网络、不会关闭 DNS 校验，也不会放行普通私网、回环、链路本地或字面量保留地址。若 TUN 服务使用真实 HTTP(S) 代理而不是 fake DNS，请配置 `OPENAI_UPSTREAM_PROXY_URL` 或渠道级 `OPENAI_CHANNEL_N_PROXY_URL`，不要启用 `--tun`。

安全要求：

- 自定义 API URL 必须和自定义 API 密钥成对配置，避免服务端密钥被发送到未知地址；如果服务端配置了 `OPENAI_UPSTREAM_PROXY_URL`，请求级自定义 URL 会被拒绝，因为代理端无法复用服务端的 DNS 安全校验。需要通过代理访问自定义渠道时，请把它配置为 `OPENAI_CHANNEL_N_BASE_URL` 和对应的渠道凭证。
- 不要把真实 API 密钥、访问码、令牌或数据库密码提交到仓库。
- 非回环地址部署必须同时设置 `APP_PASSWORD`，否则容器会拒绝启动。
- 非回环地址应使用 HTTPS；页面访问码哈希和访问 cookie 在明文 HTTP 上可能被重放。
- 分享访问码失败限流是单进程内存状态，多实例部署需在入口代理或共享状态层提供额外限流。

## 部署

### 本地 Docker

| 模式       | 命令                                 | 适用场景                    |
| ---------- | ------------------------------------ | --------------------------- |
| SQLite     | `npm run deploy:local`               | 本地单实例和长期运行。      |
| 内存       | `npm run deploy:local -- --memory`   | 临时演示或模拟 Space 环境。 |
| PostgreSQL | `npm run deploy:local -- --postgres` | 集中状态库或多实例部署。    |

部署脚本会拒绝脏工作区，并核对 Docker 健康状态、真实 HTTP 端点和镜像版本。Compose 默认只发布到 `127.0.0.1:4783`；需要局域网访问时先设置 `APP_PASSWORD`，再执行：

```bash
GIP_BIND_HOST=0.0.0.0 npm run deploy:local
```

文件系统图片保存在 `generated-images/`。若 `.env.local` 将 `WEBUI_IMAGE_AUTO_CLEANUP_ENABLED` 设为 `1`、`true`、`yes` 或 `on`，部署脚本会先拒绝运行，避免服务启动后立即清理历史图片；确认可以执行时显式添加 `--allow-image-auto-cleanup`。自动清理、永久保留和 Agent 产物生命周期配置见 [.env.example](./.env.example)。

### Hugging Face Space

#### 创建私人 Space

可直接进入 Hugging Face 的新建 Space 页面，复制官方 Space 到自己的账号或组织中，创建独立服务：

[![在 Hugging Face 复制此 Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-md.svg)](https://huggingface.co/new-space?duplicate=misonL%2Fvisual-journal)

登录 Hugging Face 后，创建页会预填本 Space 作为复制来源。请在创建页选择 Private；复制不会带出本服务的 API 密钥、访问码或 Agent 令牌。创建后必须在新 Space 的 Settings 中配置 `APP_PASSWORD`、`AGENT_API_TOKEN` 和自己的上游凭证；Docker Space 的创建资格仍受 Hugging Face 当前账户政策约束。

#### 维护本项目固定 Space

下列命令只用于维护固定目标 `misonL/visual-journal`。复制出的私人 Space 在 Hugging Face Settings 中配置 Variables 和 Secrets；`npm run deploy:space` 不会自动定位或更新该私人副本。

```bash
npm run doctor:hf-space
npm run deploy:space
```

部署前必须保持工作区干净，并在 Space 中配置 `APP_PASSWORD`、`AGENT_API_TOKEN` 和上游凭证。完整步骤见 [Hugging Face Space 部署指南](./docs/deployment/huggingface-space-free.md)。

## Agent API

Agent API 是供自动化客户端调用的机器接口，不是自治 Agent 平台。客户端应先读取能力声明，再向服务端提交业务意图，由服务端决定渠道和请求方式。

| 接口                                        | 用途                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/agent/capabilities`               | 查询能力、限制、鉴权和路由规则。                                                                |
| `GET /api/agent/openapi.json`               | 获取 OpenAPI 描述。                                                                             |
| `GET /api/agent/models`                     | 读取模型目录；`?probe=true` 主动探测已配置渠道的 `/models`，需要 Agent 或已验证工作台会话鉴权。 |
| `POST /api/agent/image-requests`            | 提交统一图片生成请求。                                                                          |
| `GET /api/agent/jobs/{id}`                  | 查询异步任务状态。                                                                              |
| `GET /api/agent/diagnostics/requests`       | 按请求 ID 或幂等键查询诊断。                                                                    |
| `GET /api/agent/diagnostics/channel-health` | 读取当前进程的只读渠道健康快照。                                                                |

首次接入可复制 `.env.agent.local.example`，然后执行结构化就绪检查和合同检查：

```bash
npm run first-run -- --json --base-url http://localhost:4783

node skills/visual-journal-image-agent/scripts/generate-image.mjs \
  --contract-check \
  --base-url http://localhost:4783 \
  "capability check"
```

仓库内置脚本默认执行预演（dry-run），不触发真实生图。只有用户明确允许计费后，才添加 `--allow-billable`。

首次添加或更换上游渠道时，先执行非计费 `/models` 检查并向用户说明四种请求方式测试范围。得到明确同意后，运行 `channel-capability-matrix.mjs --allow-billable --confirm-billable`；远程非 loopback HTTP 还需显式添加 `--allow-plain-http`，否则脚本会在任何探针前拒绝。矩阵固定测试 Images/Responses 的非流式和 SSE 方式，但默认只启用通过验证的 `images-non-stream`。其他通过方式必须用 `--enable-request-modes` 显式选择，不能把测试通过当作自动启用；`smoke:image-upstream-real` 仅用于已有配置的定向诊断，不能替代首次接入矩阵。

新增探针、诊断或路由可观测能力时，先落 API、能力声明和 OpenAPI 契约，再让 Skill 脚本做薄封装。完整参数、批量任务、编辑、分享、诊断、真实冒烟验证和边界矩阵见：

- [Agent Skill](./skills/visual-journal-image-agent/SKILL.md)
- [Agent API 参考](./skills/visual-journal-image-agent/references/api.md)

渠道健康快照只读取当前进程内存状态，不触发上游探测或图片生成，也不替代页面 `/api/runtime-capabilities`。

## 验证与运维

| 命令                                 | 用途                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `npm run status`                     | 只读查看 Git、Node、部署目标和真实冒烟验证配置状态。 |
| `npm run doctor`                     | 运行本机和部署诊断。                                 |
| `npm run env:summary`                | 安全汇总环境变量来源，不输出密钥值。                 |
| `npm run agent:doctor`               | 执行非计费 Agent 分层诊断。                          |
| `npm test`                           | 运行单元测试和契约测试。                             |
| `npm run lint`                       | 检查 `src/` 代码。                                   |
| `npm run format:check`               | 检查 TypeScript 和 TSX 格式。                        |
| `npm run build`                      | 执行生产构建。                                       |
| `npm run verify`                     | 运行提交前完整基线。                                 |
| `npm run smoke:image-upstream-local` | 运行本地非计费上游兼容最终门禁。                     |

真实上游冒烟验证必须显式传入 `--allow-billable`。`npm run status` 和默认诊断只检查配置与合同，不会产生图片费用。

## 常见问题

| 问题              | 处理                                                               |
| ----------------- | ------------------------------------------------------------------ |
| 未检测到 Node.js  | 安装 Node.js >=22.15.0。                                           |
| 依赖安装失败      | 依次运行安装策略检查、`npm ci --strict-allow-scripts` 和依赖核对。 |
| API 返回 HTML     | API URL 填成了网页地址；应填写 OpenAI 兼容 `/v1` 根地址。          |
| 提示需要 API 密钥 | 在 `.env.local` 或页面 `API 设置` 中配置。                         |
| 端口被占用        | 检查占用 `4783` 的旧进程或旧容器。                                 |

## 项目文档

- [产品边界](./docs/product/product-contract.md)
- [用户验证脚本](./docs/product/user-validation-script.md)
- [图片上游清单](./docs/product/image-provider-manifest.md)
- [Hugging Face Space 部署](./docs/deployment/huggingface-space-free.md)
- [Agent Skill](./skills/visual-journal-image-agent/SKILL.md)
- [Agent API 参考](./skills/visual-journal-image-agent/references/api.md)
- [版本记录](./CHANGELOG.md)

## 技术栈

Next.js 16、React 19、OpenAI JavaScript SDK、Tailwind CSS 4、Radix UI、Dexie IndexedDB。

## 许可证

MIT
