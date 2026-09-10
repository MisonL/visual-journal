# 变更记录

本文件记录项目的重要变更。

本项目参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 规范维护变更记录，并使用语义化版本管理正式发布版本。

## [未发布]

### 新增

- 增加模型目录 API、渠道模型白名单和 `/models` 主动探测，工作台与 Agent Skill 可读取配置声明并按渠道能力选择模型。
- 增加跨域图片结果的 HTTPS、DNS、代理和响应大小安全校验，并补充内容安全策略和安全响应头。

### 变更

- 统一 `gpt-image-2` 为兼容性默认图片模型；`OPENAI_IMAGE_MODEL`、渠道模型声明和 provider-defined 尺寸继续支持自定义模型。
- DSH 插件改用标准 YAML 配置，支持 `AGENT_API_TOKEN` 与环境 URL 覆盖，并补齐模型、代理、错误和任务轮询说明。
- Agent、页面 API、运行时能力、OpenAPI 与 Skill 脚本的错误分类、鉴权、请求方式和渠道路由契约保持一致。
- 新增渠道能力矩阵的用户确认门禁；四种方式固定实测，默认仅启用 `images-non-stream`，其他通过方式必须显式选择。

### 测试

- 补齐模型目录、CSP、远程图片安全、模型路由、请求错误分类、脚本参数和 DSH 插件回归测试。

## [2.3.0] - 2026-08-13

### 新增

- 强化响应式图片创作工作台，覆盖生成、编辑、批量任务、历史复用、分享、保留策略、成本与耗时摘要、移动端操作和中英文界面契约。
- 扩展 Agent API、OpenAPI 和运行时能力声明，提供服务端编排、任务轮询、产物管理、结果反馈、渠道健康、请求方式和诊断信息。
- 为 Agent 技能增加预演与契约检查、按后端能力校验、批量续跑与尺寸校验、路由诊断和真实上游能力矩阵流程。

### 变更

- 图片渠道路由改为按实际请求方式、凭证健康状态、模型、尺寸、背景、上传和遮罩约束筛选候选渠道。
- 支持混合渠道的离散图片数量范围和 `partial_images` 范围，能力接口、页面、Agent、OpenAPI 和 Skill 保持同一契约。
- 明确 Responses 图片后端的非流式和 SSE 语义：非流式不发送未使用的 `partial_images`，流式仅接受有效预览范围。
- 统一工作台的提示词长度、图片数量、尺寸、源图上传、遮罩、背景和后端兼容性校验，并改善错误提示、状态恢复、历史成本显示和结果操作。
- 完成 Visual Journal 品牌、npm 包名、Agent Skill 路径和 Hugging Face Space 目标迁移，固定 Space 为 `misonL/visual-journal`，并同步运行时 User-Agent、保活工作流和部署脚本。
- 将真实上游服务端渠道冒烟验证默认改为通过 HTTP 访问 Docker 服务，输出实际渠道、请求方式和上游主机，并在 Agent 请求后清理测试产物。
- 将仓库贡献指南、环境变量示例、产品与部署资料、Agent 技能文档统一为中文，清理历史审查、计划和设计过程文档。

### 修复

- 修复非流式图片响应、混合渠道范围不相交和后端默认值处理，避免能力接口 500、合法请求误报 422/503、自动默认值选择错误和冷却渠道误选。
- 修复页面与 Agent 编辑路径遗漏图片数量、源图文件大小、总上传量、遮罩、背景和尺寸限制的问题。
- 修复分享错误、批量提示词超限、历史记录成本与结果操作状态、窄屏布局和本地化文案等工作台回归问题。
- 将 `brace-expansion`、`js-yaml` 和 `nanoid` 更新到安全版本，并通过 npm override 固定受影响依赖版本。
- 补齐版本、文案、路由、能力、上传边界、脚本参数和并发临时目录隔离的回归测试与文档漂移检查。

### 升级提示

- 自动化脚本引用的 Skill 根目录需从 `skills/gpt-image-playground-agent/` 更新为 `skills/visual-journal-image-agent/`；API 路径和环境变量保持兼容。
- Docker Compose 默认仍使用 `images-api` 和 `auto`；Responses 图片后端只有在显式配置 `ENABLE_RESPONSES_IMAGE_BACKEND` 与顶层模型后才会启用。

## [2.2.0] - 2026-07-28

### 新增

- README 增加 Hugging Face 官方复制入口，供其他用户创建独立的私有 Space；复制流程不会继承正式服务的凭证，并明确私人副本不由固定 Space 部署脚本更新。
- 增加工作台生成活动状态播报、短屏布局和 API 设置弹窗的回归测试，覆盖生成、批量、继续编辑和配置草稿生命周期。
- 增加共享 DOM 测试辅助模块以及可转发 Node test runner 参数的脚本测试入口。
- 增加默认关闭的 WebUI 文件系统图片自动清理，可配置保留天数，并通过运行时能力接口查询配置和最近执行摘要。
- 增加 WebUI 文件系统图片的批量永久保存：启用自动清理后可在最近生成中设置或取消自动清理保护，状态跨 Docker 工作进程持久化。

### 变更

- 产品正式名称统一为“图像手记 / Visual Journal”；现有技术标识保持兼容，并同步更新 Space 卡片、浏览器图标、访问码文案、历史下载名和运维标识。
- 默认上游请求和上游能力探针 User-Agent 统一为 `visual-journal` 品牌标识。
- Agent 状态库初始化、请求恢复和测试重置遵循显式资源释放顺序；运行中不允许切换状态库配置。
- 本地部署在启用 WebUI 自动图片清理时要求显式确认，避免发布后立即清理历史图片。
- Prettier 与 Tailwind 格式化插件升级到当前兼容版本，并收敛现有源码格式。
- Node.js 最低版本统一为 `22.15.0`，启动器、诊断脚本、客户说明和部署文档使用同一版本门槛。
- 安装流程会确认 npm 支持 `--strict-allow-scripts`，避免旧 npm 静默忽略 `allowScripts` 白名单。
- 独立启动脚本显式加载 Next.js 运行时环境，测试和版本检查脚本改为支持显式测试文件与 runner 参数。
- 工作台、历史面板和移动端抽屉的可滚动区域与操作可达性按短视口约束收敛。
- 渠道失败冷却默认关闭；需要自动临时移出失败渠道时，必须显式设置 `OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED=true`。
- WebUI 图片清理启用后默认保留 30 天，并在启动时及之后每 6 小时执行；仍由 Agent 状态库登记的产物不会被提前删除。
- 手动删除 WebUI 图片会同步清理永久保存标记；永久保存不改变 Agent 产物的生命周期或手动删除语义。

### 修复

- 非活动生成表单不再显示当前表单之外的高分辨率流式建议。
- 修正生成完成、批量进度和继续编辑之间残留活动状态导致的实时播报错误。
- 修正 API 设置弹窗常驻挂载后的草稿回填、焦点恢复和重复测试生命周期问题。
- 修正移动端运行时状态加载引起的首屏布局位移，并增加键盘跳到主要内容入口。
- 清理本地临时图片日志并将 `tmp` 目录加入忽略规则，避免运行产物进入版本库。
- 修正图片输出目录在进程启动时被冻结的问题，避免运行目录变化时测试或后台任务读写错误的图片目录。
- 规范化清理目录和 Agent 产物的真实路径，避免 macOS 路径别名导致仍在保留期内的 Agent 图片被误删。
- 补充 Images JSON、Images SSE、Responses JSON 和 Responses SSE 四种 Agent 请求方式的产物清理生命周期回归测试。

## [2.1.0] - 2026-06-14

### 新增

- 增加渠道凭证并发队列，超出单凭证容量的请求会按队列等待，并通过运行态能力接口暴露队列容量、等待上限和当前队列状态。
- Agent 技能脚本支持默认 WebP 高质量输出、图像格式转换、Responses image_generation edit 的页面 SSE 路由，以及批量脚本按运行态容量限制有效并发。
- 增加 Matsca upstream profile，支持 Matsca 直连渠道的尺寸、`partial_images`、透明背景和上传限制口径。

### 变更

- 图片默认输出格式调整为 WebP，默认压缩质量为 `100`；需要无损归档或透明边缘复核时可显式选择 PNG。
- 渠道失败冷却默认时间调整为 `30000ms`，并增加 `OPENAI_CHANNEL_FAILURE_COOLDOWN_ENABLED` 以允许关闭渠道或凭证冷却。
- 页面端 `/api/images` 的生成和编辑都支持 `IMAGE_GENERATION_BACKEND` 与 `IMAGE_STREAMING_STRATEGY` 运行时默认值，Responses 编辑仍明确走页面 SSE 路径。
- README、`.env.example` 和 Agent 技能文档补齐渠道队列、默认后端、默认流式策略、WebP 输出和 Responses 编辑路由说明，避免把 Docker Compose 误解为默认 Responses 后端。

### 修复

- 修正移动端提交 footer 的可达性和测试覆盖，避免生成或编辑按钮在窄屏下被遮挡或状态不一致。
- 修正渠道容量队列错误被误计入上游渠道冷却的问题，队列满或等待超时不再污染渠道健康判断。
- 修正 `image_backend` 被图片上传字段解析误判的问题，避免页面 SSE edit 里控制字段被当作源图文件。

## [2.0.0] - 2026-06-06

### 新增

- WebUI 增加 `图像手记` 工作台的显式批量模式：多条提示词逐行形成独立任务，批量进度、暂停、失败项复用和批次历史保持可追溯。
- WebUI 在省心模式和专业模式中展示“并发批量”状态；只有用户手动启用且当前流式策略、任务数量和渠道容量满足条件时，才会把多图或多提示词拆成并发流式任务。
- Agent 技能批量脚本支持 `--concurrency N` 并发执行、追加写入清单、续跑、尺寸校验、失败重试和页面 SSE 原始事件留档。
- 增加 `npm run version:check`，校验 `package.json`、`package-lock.json`、README 版本徽章和 `CHANGELOG.md` 版本链接一致。

### 变更

- API URL 校验允许无凭据、无查询参数和无片段的 `http` 或 `https` OpenAI 兼容根地址；自定义 API URL 仍必须与自定义 API Key 成对提供，避免服务端密钥转发到未知地址。
- WebUI 结果区和最近生成记录补齐连续工作流动作：继续编辑、做变体、复用提示词、对比、收藏和批次折叠，批量模式的底部提示词动作以当前可见批量提示词为准。
- `npm run verify` 和 `npm run verify -- --quick` 默认执行版本元数据一致性检查，防止发布版本、锁文件、README 和变更记录漂移。

## [1.4.0] - 2026-05-27

### 新增

- 增加 API 错误排查建议，针对鉴权失败、限流、上游 5xx 和 Cloudflare 524 返回更明确的用户提示。
- 增加图片请求默认质量、错误建议和批量部分失败明细的单元测试。
- 增加上游图片流事件适配层，兼容官方 OpenAI Images 流式事件和 OtokAPI `image.generation.*` 事件。
- 增加 `/api/images` 流式路由契约测试，覆盖兼容上游 SSE 到前端稳定事件的映射、多图结果、缺图错误和上游断流。
- 增加受 `ENABLE_RESPONSES_IMAGE_BACKEND` 保护的实验 Responses API 图片后端，显式请求 `imageBackend=responses` 且配置独立 Responses 顶层模型时读取 `image_generation_call.result`。
- Agent capabilities 和 OpenAPI 增加机器可读 `routing_rules`、页面 SSE 元数据、运行态启用后端和任务轮询语义，辅助脚本支持 `--page-sse`、`--agent`、`--job` 显式路由。

### 变更

- 图片生成默认质量从 `auto` 调整为 `high`，前端、Agent API 默认值和 OpenAPI 描述保持一致。
- 页面默认不发送流式请求；用户显式开启流式预览后，单图流式失败会显式展示原始错误和建议，不再自动改用非流式请求。
- 抽取服务端流式图片响应处理，生成和编辑共用同一套 SSE 输出、图片保存、上游协议方言诊断和扣费解析逻辑。
- 运行时能力接口增加实验 Responses API 图片后端开关状态，默认关闭且不影响现有 Images API 路径。
- Agent API、图片接口、脚本和文档中的用户可见错误文案统一为中文。
- Agent 技能文档改为先定位服务地址，再按 `/api/agent/*` 契约调用，避免默认假设服务只在 `localhost:4783`。

### 修复

- 收紧 Responses `image_generation` 结果解析，只有标准 base64 或常见位图 `data:image/...;base64,` payload 会被当作可保存图片。

## [1.3.0] - 2026-05-12

### 新增

- 增加服务端运行时能力接口 `/api/runtime-capabilities`，用于返回流式批处理开关、推荐并发和渠道健康状态。
- 增加运行时并发流式批处理能力与 `OPENAI_MAX_STREAMS_PER_CREDENTIAL`，支持在流式模式下把 `n>1` 拆成多个 `n=1` 任务并发执行。
- 增加前端流式批处理执行链路，支持并发调度、SSE 完成事件聚合、预览图索引映射、用量合并和部分失败提示。
- 生成和编辑表单在服务端允许批处理时支持 `n>1` 开启流式预览，并补充中英文提示文案。
- 增加服务端凭证和渠道失败冷却机制，支持按渠道覆盖冷却窗口。
- 运行时能力接口增加健康凭证和渠道数量及最近失败摘要，用于前端刷新并发窗口。
- 增加流式批处理、运行时环境读取、渠道健康状态和失败分类的单元测试。

### 变更

- 前端提交图片请求前会刷新运行时能力，并按用户自填 API Key 或服务端渠道池选择不同并发窗口。
- 图片请求构造、流式响应处理和访问码重试参数改为可复用流程，批处理和单请求共用同一套错误处理。
- README 与 `.env.example` 补充流式批处理、单凭证并发上限和渠道失败冷却配置说明。
- ESLint 配置显式绑定 Next.js 根目录，TypeScript 配置排除 `dist` 构建产物。

### 修复

- 修正 `sticky` 路由下流式批处理推荐并发被渠道数量放大的问题，避免同一亲和键下突破单个凭证的并发上限。
- 修正服务端渠道池全部冷却时前端仍可能按旧推荐并发继续批处理的问题。
- 修正 OpenAI SDK 将连接错误放在嵌套 `cause` 中时未触发 channel 冷却的问题。
- 兼容上游错误中的 `requestID` 和 `requestId` 字段，并确保公开能力接口不返回上游错误消息。
- 修正访问码弹窗重试只保存表单数据、未保存请求模式和流式参数的问题。

## [1.2.0] - 2026-05-11

### 新增

- 通过 `OPENAI_CHANNEL_N_*` 环境变量支持服务端多渠道 API Key 路由。
- 支持 `sticky`、`round_robin`、`random` 三种服务端凭证路由策略。
- 增加渠道解析、路由选择、有效凭证解析的单元测试。
- 增加仓库执行约束文档 `AGENTS.md`。
- 增加服务端运行时工具测试，覆盖访问码哈希校验、请求来源选择、批次 ID 和图片文件名生成。
- 增加应用日志工具测试，覆盖日志等级规范化、默认等级、无效配置回退和上下文透传。

### 变更

- 统一本地服务默认使用 `4783` 端口启动。
- 抽取服务端运行时工具，复用访问码校验、输出目录和文件名生成逻辑。
- 将服务端请求路径日志收敛为可配置日志等级，生产环境默认只输出警告和错误。
- 缓存日志等级解析结果，减少热路径重复计算。

## [1.1.0] - 2026-05-10

### 新增

- 增加中英文界面文案。
- 增加客户交付打包脚本和部署文档。
- 增加主题控制和面向客户的使用说明。

### 变更

- 针对本地化客户版本优化主界面。
- 固定依赖覆盖版本，提升安装可复现性。

### 修复

- 加强图片请求校验和打包行为。
- 加强生成图片文件访问和路径处理。

## [1.0.0] - 2026-05-09

### 新增

- GPT Image Playground 初始公开版本。
- 支持基于 OpenAI 兼容 Images API 的本地图片生成和编辑流程。
- 增加 Docker 部署支持和多平台启动脚本。

[未发布]: https://github.com/MisonL/visual-journal/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/MisonL/visual-journal/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/MisonL/visual-journal/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/MisonL/visual-journal/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/MisonL/visual-journal/compare/v1.4.0...v2.0.0
[1.4.0]: https://github.com/MisonL/visual-journal/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/MisonL/visual-journal/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MisonL/visual-journal/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/MisonL/visual-journal/compare/dc7c8f5855e80cb9507517b5748c718e7155df52...v1.1.0
[1.0.0]: https://github.com/MisonL/visual-journal/commit/dc7c8f5855e80cb9507517b5748c718e7155df52
