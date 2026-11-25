# 图像模型族

模型族登记表 `src/lib/image-model-family.ts` 是图片尺寸语义、透明背景和编辑能力的唯一声明处。新增模型不再需要修改 `size-utils`、`cost-utils` 或 `agent-model-directory` 的判定分支，只需要在 `IMAGE_MODEL_FAMILIES` 里加一条。

## 为什么需要登记表

早期实现把模型名散落在多个模块里：`GPT_IMAGE_MODELS` 同时承担“有哪些模型”和“哪些模型只能选预设尺寸”两种含义，导致每接入一个新模型都要在四五处同步改动，而且很容易把新模型误判进 legacy 尺寸白名单。登记表把这些判断收敛为一处声明。

## 三种尺寸语义

| `sizePolicy`        | 含义                                 | 本地校验                 |
| ------------------- | ------------------------------------ | ------------------------ |
| `legacy_allowlist`  | 只接受族内固定预设尺寸               | 必须命中 `legacySizes`   |
| `openai_compatible` | 16 倍数、1:3~3:1、单边上限、像素区间 | 按渠道 profile 校验      |
| `provider_defined`  | 尺寸语义由上游决定                   | 只做正整数与本地资源预算 |

未登记模型一律落到 `provider_defined`，即“本地只保留资源上限保护（单边 8192px、总像素 67,108,864），语义交给上游”。这保证新模型不会因为没登记就被错误拒绝。

## 已登记模型族

- OpenAI：`gpt-image-1` 系（legacy 白名单）、`gpt-image-2` 系、`gpt-image-2.5` 系（Flare / Sunburst）、`dall-e` 系
- Google：Gemini 图像、Imagen
- Black Forest Labs：FLUX
- 字节：Seedream / Seededit
- 阿里：Qwen Image / Wanx
- Stability：SD / SDXL
- Recraft、Ideogram、Midjourney 系列、NovelAI Diffusion

前缀匹配覆盖上游随时新增的版本号，例如 `gpt-image-2.5-anything` 归入 2.5 族。

## 能力字段

`/api/agent/models` 的 `known_models[]` 暴露每个模型的族信息，Agent 端不需要自行维护模型清单：

- `family` / `family_label`：族标识与展示名
- `size_policy`：上述三态收敛后的两态（`provider_defined` 或 `legacy_allowlist`）
- `supports_edit`：是否支持以图生图的编辑入口
- `allow_transparent_background`：`false` 表示该族官方不支持透明背景；`null` 表示服务端不做本地判断，由上游裁决
- `recommended_presets`：族内推荐尺寸，仅作建议，不构成硬校验

## gpt-image-2.5 的官方约束

按 OpenAI 文档（2026-09 发布），Flare 与 Sunburst 的尺寸约束与 `gpt-image-2` 相同：宽高为 16 的倍数、长宽比在 1:3 到 3:1 之间、单边不超过 3840 像素、总像素在 655,360 到 8,294,400 之间。两者另外新增 `xhigh` 与 `max` 质量档，官方定价与 `gpt-image-2` 的 token 三档一致。

需要注意：某些中转渠道会放宽这些限制（实测接受 8192x8192、1001x1001 等非 16 倍数尺寸）。这类渠道应通过 `OPENAI_CHANNEL_N_PROVIDER_MANIFEST` 把 `constraints.gpt_image_2.size_policy` 声明为 `positive-integer`，而不是靠修改本地实现来适配单个渠道。

## 相关边界

- 页面工作台、页面 SSE 接口和 Agent JSON 接口分别校验，但共用同一张登记表。
- Skill 脚本的 `script-utils.mjs` 维护一份镜像判定，用于 dry-run 前置检查；两侧必须同步修改。
- `allow_transparent_background: null` 不等于“支持”，只是“服务端不拦”。调用方不应据此承诺透明输出。

## 上游不遵循 `size` 时

部分中转渠道会忽略请求中的 `size`，恒定返回某个固定尺寸（实测有个渠道无论请求 `1024x1024`、`1024x1536` 还是 `512x512`，都返回 `1536x1024`）。这不是本项目的缺陷，而是上游的固有实现差异，项目按"显式声明"而不是"猜测"来处理。

渠道可在 provider manifest 中声明输出尺寸策略：

```json
{
    "id": "fixed_size_relay",
    "base_profile": "openai-compatible",
    "modes": { "generate": { "submit": { "path": "/images/generations" } } },
    "constraints": { "output_dimensions": "upstream_controlled" }
}
```

| `output_dimensions`   | 行为                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `requested`（默认）   | 服务端把上游图片归一到请求尺寸；宽高比偏差超过 8px 或 1% 时返回 `image_dimension_mismatch`，绝不静默拉伸 |
| `upstream_controlled` | 不缩放，直接接受上游真实尺寸，并把真实 `width`/`height` 写进结果和产物元数据                             |

未声明的渠道一律按 `requested` 处理，保持严格契约。多个渠道共用时，只要有一个渠道保证按请求尺寸出图，合并结果就保持 `requested`。

`/api/agent/capabilities` 会返回 `output_dimensions` 和 `output_dimensions_note`，调用方据此决定是否需要校验返回尺寸；技能脚本对这类渠道不应使用 `--dimension-check`。

## 上游忽略 `n` 时

同一类渠道还常常忽略 `n`：实测某个渠道在 `n=1`、`n=2`、`n=4` 下都只返回 1 张图，但响应里没有任何提示。如果服务端不拦截，调用方会以为拿到了 3 张，实际只有 1 张——这是会被误当成"丢图故障"的静默降级。

项目不猜测，而是让渠道把真实上限声明出来：

```json
{
    "id": "single_out",
    "modes": { "generate": { "submit": { "path": "/images/generations" } } },
    "constraints": {
        "output_dimensions": "upstream_controlled",
        "generate_count": { "min": 1, "max": 1 },
        "edit_count": { "min": 1, "max": 1 }
    }
}
```

声明后，`n=3` 会在请求校验阶段收到 `validation_error`（`n` 必须是 1 到 1 之间的整数），`n=1` 正常通过。`/api/agent/capabilities` 的 `limits.max_images`、`generate_images`、`edit_images` 会同步收敛为 `{min: 1, max: 1}`，Agent 端无需硬编码。

不声明 `generate_count` 的渠道仍按基础 profile 的 1~10 处理。

## 已登记的模型族全貌

族表 `src/lib/image-model-family.ts` 是唯一事实来源：尺寸语义、编辑支持、透明背景、额外质量档、额外输出格式、生命周期都在这里声明，其余模块只读取结论。

| 族 id                                             | 覆盖的模型                                                       | 尺寸语义            |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------- |
| `openai-gpt-image-2.6`                            | `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`                  | `openai_compatible` |
| `openai-gpt-image-2.5`                            | `gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | `openai_compatible` |
| `openai-gpt-image-2`                              | `gpt-image-2`、`gpt-image-2-1k`                                  | `openai_compatible` |
| `openai-gpt-image-1`                              | `gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5`               | `legacy_allowlist`  |
| `openai-dall-e`                                   | `dall-e-*`                                                       | `legacy_allowlist`  |
| `google-gemini-image`                             | `gemini-*-image`、`gemini-nano-banana-*`、`nano-banana*`         | `provider_defined`  |
| `google-imagen`                                   | `imagen-*`                                                       | `provider_defined`  |
| `bfl-flux`                                        | `flux-*`、`flux.1-*`                                             | `provider_defined`  |
| `bytedance-seedream`                              | `seedream*`、`seededit*`、`doubao-seed*`                         | `provider_defined`  |
| `alibaba-qwen-image`                              | `qwen-image*`、`wan2*`、`wan*`、`wanx*`                          | `provider_defined`  |
| `xai-grok-imagine`                                | `grok-imagine`、`grok-imagine-edit`、`grok-imagine-image*`       | `provider_defined`  |
| `z-image`                                         | `z-image`                                                        | `provider_defined`  |
| `stability-diffusion`                             | `sd-*`、`sdxl`、`stable-diffusion*`、`sd3*`                      | `provider_defined`  |
| `recraft` / `ideogram` / `midjourney` / `novelai` | 同名前缀                                                         | `provider_defined`  |
| `custom`                                          | 未登记的其他模型                                                 | `provider_defined`  |

## gpt-image-2.6 的额外能力

2.6 不是单纯的版本号提升，它在协议上加了四个新东西。这些能力只在 2.6 族上声明，`gpt-image-2` 及更早的模型不会继承。下表区分"上游支持"和"本服务已代理"——没代理的能力会通过 `/api/agent/models` 的 `upstream_only_capabilities` 如实披露，让调用方能区分"上游不支持"和"本服务还没代理"。

为什么先不做 SVG/GIF：本服务的产物管线（格式探测、尺寸读取、sharp 归一化、文件名白名单、历史元数据、前端展示）都建立在栅格图之上。要真正支持 SVG 与动画 GIF，需要先改造这条管线，属于独立课题；在没有改造之前声明支持，只会让调用方拿到处理不了的二进制。

| 能力         | 字段                                 | 本服务状态                                             |
| ------------ | ------------------------------------ | ------------------------------------------------------ |
| 规划算力控制 | `complexity` = `low`/`medium`/`high` | **已代理**：仅 2.6 族接受该字段，省略时不发送          |
| 标注引导编辑 | `markup`                             | **未代理**：上游支持，本服务不接收该参数               |
| 矢量输出     | `output_format: svg`                 | **未代理**：输出格式白名单仍只有 png/jpeg/webp         |
| 动画输出     | `output_format: gif`                 | **未代理**：同上，frame_count/frame_duration_ms 未接入 |

质量档方面，2.6 与 2.5 一样支持 `xhigh` 和 `max`。质量档不再硬编码在调用点，而是由族表的 `extendedQualityTiers` 驱动：只有声明了扩展档的族才会放宽，其余族保持 `low`/`medium`/`high`/`auto`。

## 模型生命周期

`IMAGE_MODEL_LIFECYCLES` 按模型 id 记录官方公布的关停计划，因为同一族内各型号的时间并不一致：

| 模型                    | 状态   | 关停日期   |
| ----------------------- | ------ | ---------- |
| `gpt-image-1`           | 已关停 | 2026-10-23 |
| `gpt-image-1.5`         | 已弃用 | 2026-12-01 |
| `gpt-image-1-mini`      | 已弃用 | 2026-12-01 |
| `gpt-image-2`           | 已弃用 | 2027-02-10 |
| `dall-e-2` / `dall-e-3` | 已关停 | 2026-05-12 |

`/api/agent/models` 的 `known_models[]` 会带出 `lifecycle` 字段，调用方可以据此提示迁移，而不是等到上游报错。

## 刻意没有登记的内容

按照"只登记可以公开声明的事实"这一约定，以下能力宁可留空也不猜测：

- 各家厂商的透明背景支持：除 OpenAI（`background` 参数）、字节 Seedream、Ideogram、NovelAI 有官方说明外，其余族的 `allow_transparent_background` 均为 `null`，交给上游裁决。
- `z-image` 的厂商归属与约束：只在 new-api 的识别清单和 Ideogram 的代理列表中出现过，官方细节未核实，因此只登记前缀。
- 第三方"Midjourney API"：官方没有公开 API，不应写入登记表。
- NovelAI V5 的完整 model id 枚举：官方 Swagger 未公开，暂不登记具体 id。
