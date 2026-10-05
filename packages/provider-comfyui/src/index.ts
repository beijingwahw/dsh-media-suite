/**
 * dsh-media-comfyui —— 本地 ComfyUI Provider。
 *
 * 原理：把「工作流 JSON（ComfyUI API 格式）」当作模板，
 * 将其中的 {{prompt}} / {{negative}} / {{width}} / {{height}} / {{seed}} / {{ref_image}}
 * 占位符用请求参数替换后 POST /prompt 提交，轮询 /queue + /history 拿真实进度，
 * 完成后从 /view 拉取产物。
 *
 * 深度优化：
 *  - 进度反馈：从 /queue 读取排队位次与运行状态，替代盲猜百分比
 *  - 模板前置校验：提交前检查占位符齐全、存在输出节点，避免跑一半才失败
 *  - 错误分级：连接失败可重试、模板/参数错误不可重试
 */
import { readFile } from 'node:fs/promises';
import {
  configError,
  httpError,
  MediaError,
  withTimeout,
  type Artifact,
  type GenerateRequest,
  type MediaProvider,
  type Modality,
  type ProviderTicket,
  type TaskProgress
} from 'dsh-media-core';

export const name = 'media-comfyui';

export interface Config {
  endpoint?: string;
  /** 模态 → 工作流模板：文件路径（.json）或内联对象 */
  workflows?: Partial<Record<Modality, string | Record<string, unknown>>>;
  timeoutSec?: number;
  requestTimeoutMs?: number;
}

interface PluginContext {
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): void {
  const provider = new ComfyUIProvider(config);
  ctx.emit?.('media/provider:register', provider);
  ctx.dispose?.(() => ctx.emit?.('media/provider:unregister', provider.id));
}

/** 视为「输出节点」的 class_type 集合 */
const OUTPUT_NODES = new Set([
  'SaveImage', 'PreviewImage', 'SaveAnimatedWEBP', 'SaveAnimatedPNG',
  'VHS_VideoCombine', 'SaveAudio', 'SaveVideo'
]);

export class ComfyUIProvider implements MediaProvider {
  readonly id = 'comfyui';
  readonly capabilities: Modality[];

  private endpoint: string;
  private templates: Partial<Record<Modality, string | Record<string, unknown>>>;
  private timeoutSec: number;
  private requestTimeoutMs: number;

  constructor(config: Config = {}) {
    this.endpoint = (config.endpoint ?? process.env.COMFYUI_ENDPOINT ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    this.templates = { image: BUILTIN_T2I, ...config.workflows };
    this.timeoutSec = config.timeoutSec ?? 1800;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.capabilities = (Object.keys(this.templates) as Modality[]).filter(
      (m) => m === 'image' || m === 'video' || m === 'image-edit'
    );
  }

  async submit(req: GenerateRequest): Promise<ProviderTicket> {
    const tpl = this.templates[req.modality];
    if (!tpl) throw configError(`comfyui 未配置 ${req.modality} 工作流模板`);
    const workflow = await loadTemplate(tpl);

    const [w, h] = parseSize(req.params.size);
    const vars: Record<string, string> = {
      prompt: req.prompt ?? '',
      negative: String(req.params.negative ?? ''),
      width: String(w),
      height: String(h),
      seed: String(Math.floor(Math.random() * 2 ** 31)),
      ref_image: req.refImage ?? ''
    };
    const filled = fillPlaceholders(workflow, vars) as Record<string, unknown>;

    // 模板前置校验：缺占位符值 / 无输出节点 → 不可重试错误，避免白跑
    validateWorkflow(filled, vars);

    const res = await withTimeout(
      fetch(`${this.endpoint}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: filled, client_id: `dsh-media-${Date.now()}` }),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      }),
      this.requestTimeoutMs + 5000,
      'comfyui-submit'
    ).catch((e) => {
      // 连接失败视为可重试（ComfyUI 可能正在启动）
      throw new MediaError(`无法连接 ComfyUI（${this.endpoint}）：${(e as Error).message}`, true);
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw httpError(res.status, data?.error ?? JSON.stringify(data), 'comfyui');
    }
    if (!data?.prompt_id) throw new MediaError(`ComfyUI 未返回 prompt_id：${JSON.stringify(data).slice(0, 200)}`, false);
    return { provider: this.id, handle: data.prompt_id, meta: { modality: req.modality, submittedAt: Date.now() } };
  }

  async poll(ticket: ProviderTicket): Promise<TaskProgress> {
    if ((Date.now() - Number(ticket.meta?.submittedAt ?? Date.now())) / 1000 > this.timeoutSec) {
      throw new MediaError(`ComfyUI 任务超时（>${this.timeoutSec}s）`, true);
    }
    // 终态判定：/history
    const histRes = await this.get(`/history/${encodeURIComponent(ticket.handle)}`);
    if (histRes.ok) {
      const history: any = await histRes.json();
      const entry = history?.[ticket.handle];
      if (entry) {
        if (entry.status?.status_str === 'error') {
          throw new MediaError('ComfyUI 工作流执行出错，详见 ComfyUI 控制台', false);
        }
        if (entry.outputs && Object.keys(entry.outputs).length > 0) {
          return { status: 'succeeded', percent: 100 };
        }
      }
    }
    // 进行中：从 /queue 拿排队位次，给出真实进度感
    const qRes = await this.get('/queue');
    if (qRes.ok) {
      const q: any = await qRes.json();
      const running: any[] = q?.queue_running ?? [];
      const waiting: any[] = q?.queue_pending ?? [];
      if (running.some((r) => r?.[1] === ticket.handle)) return { status: 'running', percent: 60 };
      const pos = waiting.findIndex((r) => r?.[1] === ticket.handle);
      if (pos >= 0) {
        return { status: 'running', percent: Math.max(5, Math.min(40, 40 - pos * 5)) }; // 排队中：位次越靠前越高
      }
    }
    return { status: 'running', percent: 50 };
  }

  async fetch(ticket: ProviderTicket): Promise<Artifact[]> {
    const res = await this.get(`/history/${encodeURIComponent(ticket.handle)}`);
    if (!res.ok) throw httpError(res.status, 'history 查询失败', 'comfyui');
    const history: any = await res.json();
    const entry = history?.[ticket.handle];
    if (!entry?.outputs) throw new MediaError('ComfyUI 无输出记录', true);
    const kind = (ticket.meta?.modality as Modality) ?? 'image';

    const arts: Artifact[] = [];
    for (const nodeOut of Object.values<any>(entry.outputs)) {
      for (const item of [...(nodeOut.images ?? []), ...(nodeOut.gifs ?? []), ...(nodeOut.audio ?? [])]) {
        const params = new URLSearchParams({
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output'
        });
        const r = await this.get(`/view?${params}`);
        if (!r.ok) continue;
        arts.push({
          kind,
          mime: r.headers.get('content-type') ?? guessMime(item.filename),
          data: new Uint8Array(await r.arrayBuffer()),
          filename: item.filename
        });
      }
    }
    if (!arts.length) throw new MediaError('ComfyUI 输出中未找到媒体文件', false);
    return arts;
  }

  async cancel(_ticket: ProviderTicket): Promise<void> {
    await fetch(`${this.endpoint}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/system_stats`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private get(path: string): Promise<Response> {
    return withTimeout(
      fetch(this.endpoint + path, { signal: AbortSignal.timeout(this.requestTimeoutMs) }),
      this.requestTimeoutMs + 5000,
      'comfyui-get'
    ).catch((e) => {
      throw new MediaError(`无法连接 ComfyUI（${this.endpoint}）：${(e as Error).message}`, true);
    });
  }
}

// ---------- 模板校验 ----------

function validateWorkflow(workflow: Record<string, unknown>, vars: Record<string, string>): void {
  const nodes = Object.values(workflow);
  if (!nodes.length) throw configError('ComfyUI 工作流模板为空');

  let hasOutput = false;
  const leftovers = new Set<string>();
  for (const node of nodes as any[]) {
    if (node?.class_type && OUTPUT_NODES.has(node.class_type)) hasOutput = true;
    const scan = (v: unknown) => {
      if (typeof v === 'string') {
        for (const m of v.matchAll(/\{\{(\w+)\}\}/g)) {
          if (!(m[1] in vars)) leftovers.add(m[1]);
        }
      } else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object') Object.values(v).forEach(scan);
    };
    scan(node?.inputs);
  }
  if (leftovers.size) {
    throw configError(`ComfyUI 模板含未知占位符：${[...leftovers].map((v) => `{{${v}}}`).join(', ')}（支持：${Object.keys(vars).map((v) => `{{${v}}}`).join(', ')}）`);
  }
  if (!hasOutput) {
    throw configError(`ComfyUI 模板缺少输出节点（需要 ${[...OUTPUT_NODES].slice(0, 4).join(' / ')} 等），产物无法回收`);
  }
}

// ---------- 工具函数 ----------

async function loadTemplate(tpl: string | Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof tpl !== 'string') return structuredClone(tpl);
  try {
    return JSON.parse(await readFile(tpl, 'utf-8'));
  } catch (e) {
    throw configError(`ComfyUI 工作流模板加载失败（${tpl}）：${(e as Error).message}`);
  }
}

/** 深度遍历，替换字符串中的 {{key}} 占位符 */
function fillPlaceholders(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  }
  if (Array.isArray(obj)) return obj.map((v) => fillPlaceholders(v, vars));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = fillPlaceholders(v, vars);
    return out;
  }
  return obj;
}

function parseSize(size: unknown): [number, number] {
  const m = String(size ?? '1024*1024').match(/(\d+)\s*[*x×]\s*(\d+)/i);
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg' }[ext ?? ''] ??
    'application/octet-stream'
  );
}

/**
 * 内置最小文生图模板（ComfyUI API 格式，SD1.5 结构）。
 * 需要本地 ComfyUI 存在对应 checkpoint；否则请通过 config.workflows 提供自己的工作流。
 */
const BUILTIN_T2I: Record<string, unknown> = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['1', 1] } },
  '4': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 }
  },
  '5': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}', steps: 25, cfg: 7, sampler_name: 'euler_ancestral', scheduler: 'normal',
      denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0]
    }
  },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-media', images: ['6', 0] } }
};
