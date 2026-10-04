# dsh-media-suite

DeepSeek Harness（dsh）**多模态生成插件族** —— 把文生图、图像编辑、语音合成、视频生成以统一协议接入 dsh Agent，填补生态「生成侧多模态」空白。

> 定位：dsh 生态里已有 modlens 等「视觉理解」插件，但**生成侧**（图/音/视频）尚无统一方案。本套件按 dsh「一切皆插件」哲学设计：core 提供统一生成协议，Provider 以独立插件热插拔。

## 包一览

| 包 | npm 名 | 职责 |
|---|---|---|
| packages/core | `dsh-media-core` | `media` 服务：统一生成协议、任务队列（并发/重试/取消）、SQLite 持久化、产物落盘 + 会话事件注入、预算限流、5 个 Agent 工具 |
| packages/provider-bailian | `dsh-media-bailian` | 阿里云百炼：万相文生图/图像编辑/图生视频、CosyVoice TTS |
| packages/provider-openai | `dsh-media-openai` | OpenAI 兼容端点：gpt-image、/v1/audio/speech |
| packages/provider-comfyui | `dsh-media-comfyui` | 本地 ComfyUI：工作流 JSON 模板参数化，零 API 成本 |
| packages/ui | `dsh-media-ui` | Web UI 面板：任务看板、图/音/视频内联预览、引用到对话、失败重试、预算仪表 |

## 架构

```
Agent 工具 (generate_image / edit_image / generate_speech / generate_video / media_task_status)
        │
   dsh-media-core ── 服务名 `media`
   ├─ 统一生成协议（MediaProvider 接口）
   ├─ 任务队列：状态机 pending→submitted→running→succeeded/failed/canceled
   │   · 按模态并发控制 · 指数退避重试(≤3) · 取消 · 崩溃恢复
   ├─ 预算闸门：日预算 / 单任务预算（各家计价统一折算 CNY）
   ├─ 产物管理：落盘 <workspace>/assets/media/ + 元数据写入会话事件流（轨迹可回放）
   └─ SQLite 持久化（$DSH_HOME/media.db，可切 memory）
        │  事件 media/provider:register（Cordis 热插拔，卸载自动反注册）
   ┌────┼──────────┐
 bailian openai  comfyui      ←  Provider 插件，按需安装
        │
   dsh-media-ui               ←  订阅 media/task:updated 渲染面板
```

## 安装

```bash
# 必装：核心
dsh plugin --profile web add dsh-media-core

# 按你有的 API Key / 本地部署选装 Provider
dsh plugin --profile web add dsh-media-bailian     # 需 DASHSCOPE_API_KEY
dsh plugin --profile web add dsh-media-openai      # 需 OPENAI_API_KEY（或兼容端点）
dsh plugin --profile web add dsh-media-comfyui     # 需本地 ComfyUI

# 推荐：Web UI 面板
dsh plugin --profile web add dsh-media-ui
```

源码安装（本仓库）：

```bash
pnpm install && pnpm build
dsh plugin --profile web add ./packages/core
dsh plugin --profile web add ./packages/provider-bailian
# ...其余同理
```

## 配置（cordis.yml / 插件配置页）

```yaml
media-core:
  defaultProvider: { image: bailian, video: bailian, speech: openai }
  budget: { dailyCNY: 20, perTaskCNY: 5 }
  concurrency: { image: 4, video: 2, speech: 4 }
  outputDir: assets/media
  storage: sqlite

media-bailian:
  apiKey: ${DASHSCOPE_API_KEY}
  # models: { image: wanx2.1-t2i-turbo, video: wanx2.1-t2v-turbo, speech: cosyvoice-v2 }

media-openai:
  apiKey: ${OPENAI_API_KEY}
  baseUrl: https://api.openai.com/v1   # 可指向任意 OpenAI 兼容网关

media-comfyui:
  endpoint: http://127.0.0.1:8188
  # workflows: { image: /path/to/my-workflow.json, video: ... }  # ComfyUI API 格式，{{prompt}} 等占位符自动注入
```

密钥建议走环境变量或 dsh credentials 机制，不要写明文配置。

## 使用

装好后直接对 Agent 说：

- 「生成一张赛博朋克风格的黑鲸图片，1024x1024」 → `generate_image`
- 「把 assets/media/xxx.png 改成水彩风格」 → `edit_image`
- 「把这段总结读出来，用沉稳男声」 → `generate_speech`
- 「生成一段 5 秒的海浪视频」 → `generate_video`（异步，立即返回 task_id，完成后产物自动落盘并出现在 UI 面板）

产物统一保存在工作区 `assets/media/`，元数据写入会话事件流，可在 dsh 轨迹视图中回放；UI 面板支持一键「引用到对话」做二次编辑。

## 开发

```bash
pnpm install
pnpm build        # 全包 tsc 构建
pnpm test         # core 单测（状态机/预算/队列端到端，vitest）
```

## 已知限制与风险

- **dsh 处于 developer preview**：本套件以 dsh v0.2.x 插件 API 为基线（Cordis `provide/on/emit/dispose` + `dsh.bundle` 声明）。宿主 UI 挂载点与工具注册接口可能变化，`core/index.ts` 与 `ui/index.ts` 已做多级回退（宿主服务 → 事件广播 → DOM 浮层），但大版本升级后仍需复核。
- **单价表为快照**：`core/src/pricing.ts` 中的各家单价是 2026-10 的公开定价快照，官方调价后请更新；无单价规则的 Provider 记 0 成本（不阻断任务，只影响预算精度）。
- **ComfyUI 内置模板**仅为 SD1.5 最小示例，实际使用请提供自己的工作流 JSON（API 格式，含 `{{prompt}}/{{width}}/{{height}}/{{seed}}/{{negative}}/{{ref_image}}` 占位符）。
- 百炼各模型的异步任务接口细节（如取消端点支持度）以 DashScope 官方文档为准。
