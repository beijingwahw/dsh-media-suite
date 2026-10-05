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

## v0.2 深度优化（2026-10-05）

**可靠性**
- Provider 故障自动转移：路由时健康探测（30s 缓存），指定/默认 Provider 不可用自动降级到下一个候选，可用 `failover: false` 关闭
- 错误分级重试：429/5xx/网络错误才进指数退避重试；参数、鉴权、能力缺失类错误立即 failed，不再白烧 3 次重试和预算
- 自适应轮询：异步任务轮询间隔指数递增（3s→30s 封顶）+ 抖动，长视频任务大幅减少无效请求
- 任务总超时看门狗：各模态可配置（默认 image 5min / speech 2min / video 30min），卡死任务自动失败并释放并发槽位

**预算**
- 预扣-结算模型：入队即预扣预估成本（在途占用额度），成功按实际结算、失败/取消自动释放，杜绝并发任务同时通过日预算检查导致超支
- 真实计费量结算：Provider 回传 usage（张数/秒数/千字符）优先于预估单价结算

**产物与存储**
- 原子写入（临时文件 + rename）+ SHA-256 内容去重（相同产物复用文件）+ 同名冲突自动加哈希后缀
- 可选保留策略：按数量/天数自动清理旧产物（`retention: { maxCount, maxAgeDays }`，默认关闭）
- SQLite 补 sessionId+status / hash / created_at 索引，旧库自动轻量迁移；listTasks 支持游标分页

**工具体验**
- `generate_image` / `edit_image` / `generate_speech` 默认 `wait: true`：同步等待完成直接返回产物路径（超时自动转后台并返回 task_id），Agent 少一轮查询
- 入参前置校验：非法 size/n/duration/speed/format 在入队前拒绝并返回可读错误，Agent 可自行修正

**Provider**
- bailian：错误码分类（内容审核/参数错误不重试）、全请求超时、本地路径参考图前置拒绝（提示改用公网 URL 或 comfyui）、task_metrics 进度估算
- openai：全请求 AbortSignal 超时、dall-e-3 参数约束（n=1、quality/style 透传）、TTS 字符量回传结算
- comfyui：/queue 排队位次真实进度、模板前置校验（未知占位符/缺输出节点提交前报错）、连接失败归类可重试

**UI**
- 事件驱动增量渲染（去掉 2s 全量轮询，保留 10s 低频对账兜底）、任务取消按钮、模态/状态筛选、成本列、进度条、空状态提示、产物详情缓存

测试从 13 例扩充至 **35 例**，全部通过。

## 真实数据接地（2026-10-05 核实）

代码中的模型名、端点与单价均已对照官方文档核实：

| 项目 | 值 | 来源 |
|---|---|---|
| 百炼文生图 | `wanx2.1-t2i-turbo`，0.14 元/张，异步 HTTP | [官方模型页](https://help.aliyun.com/zh/model-studio/wanx2-1-t2i-turbo) |
| 百炼图像编辑 | `wanx2.1-imageedit`，0.14 元/张 | [百炼收费标准汇总](https://developer.aliyun.com/article/1763163) |
| 百炼文生视频 | `wanx2.1-t2v-turbo`，480P/720P 0.24 元/秒 | 同上 |
| 百炼 TTS | `qwen3-tts-flash`，0.8 元/万字符，REST 同步 | [官方模型页](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash) |
| OpenAI 图像 | `gpt-image-1` 低档 $0.011/张 ≈ 0.08 元 | OpenAI API 定价页 |
| OpenAI TTS | `gpt-4o-mini-tts` $0.6/百万字符 ≈ 0.0043 元/千字符 | OpenAI API 定价页 |

关键修正：**cosyvoice 系列仅支持 WebSocket 接口**，HTTP 链路调不通，TTS 默认模型已切换为 REST 可用的 `qwen3-tts-flash`（音色 Cherry/Serena/Ethan/Chelsie 等）。

计费口径注意：百炼 TTS 按「1 汉字=2 字符」计，本套件按文本长度估算时中文实际成本约为估算 2 倍，预算请留余量；任务成功后按 provider 回传的真实 usage 结算。

### 真实链路冒烟测试

配置好 API Key 后，用 `scripts/smoke.mjs` 直接验证各家真实端点（不经过插件层，快速定位链路问题）：

```bash
DASHSCOPE_API_KEY=sk-xxx node scripts/smoke.mjs bailian-image   # 真实生成一张图（约 0.14 元）
DASHSCOPE_API_KEY=sk-xxx node scripts/smoke.mjs bailian-tts     # 真实合成一段语音
OPENAI_API_KEY=sk-xxx    node scripts/smoke.mjs openai-image
COMFYUI_ENDPOINT=http://127.0.0.1:8188 node scripts/smoke.mjs comfyui-health
node scripts/smoke.mjs all   # 跑所有已配置 Key 的项，产物在 ./smoke-output/
```

## 已知限制与风险

- **dsh 处于 developer preview**：本套件以 dsh v0.2.x 插件 API 为基线（Cordis `provide/on/emit/dispose` + `dsh.bundle` 声明）。宿主 UI 挂载点与工具注册接口可能变化，`core/index.ts` 与 `ui/index.ts` 已做多级回退（宿主服务 → 事件广播 → DOM 浮层），但大版本升级后仍需复核。
- **单价表为快照**：`core/src/pricing.ts` 中的各家单价是 2026-10 的公开定价快照，官方调价后请更新；无单价规则的 Provider 记 0 成本（不阻断任务，只影响预算精度）。
- **ComfyUI 内置模板**仅为 SD1.5 最小示例，实际使用请提供自己的工作流 JSON（API 格式，含 `{{prompt}}/{{width}}/{{height}}/{{seed}}/{{negative}}/{{ref_image}}` 占位符）。
- 百炼各模型的异步任务接口细节（如取消端点支持度）以 DashScope 官方文档为准。
