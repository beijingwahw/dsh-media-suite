/**
 * dsh-media-comfyui —— 本地 ComfyUI Provider。
 *
 * 原理：把「工作流 JSON（ComfyUI API 格式）」当作模板，
 * 将其中的 {{prompt}} / {{negative}} / {{width}} / {{height}} / {{seed}} 占位符
 * 用请求参数替换后 POST /prompt 提交，轮询 /history/{prompt_id}，
 * 完成后从 /view 拉取产物。
 *
 * 用户可通过 config.workflows 提供自己的工作流模板（任意 SD/Flux/视频模型），
 * 内置模板仅为最小可跑通的示例（SD1.5 结构）。
 */
import { readFile } from 'node:fs/promises';
import type {
  Artifact,
  GenerateRequest,
  MediaProvider,
  Modality,
  ProviderTicket,
  TaskProgress
} from 'dsh-media-core';

export const name = 'media-comfyui';

export interface Config {
  endpoint?: string;
  /** 模态 → 工作流模板：文件路径（.json）或内联对象 */
  workflows?: Partial<Record<Modality, string | Record<string, unknown>>>;
  timeoutSec?: number;
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

export class ComfyUIProvider implements MediaProvider {
  readonly id = 'comfyui';
  /** 默认声明 image；用户提供 video 工作流模板后自动扩展能力 */
  readonly capabilities: Modality[];

  private endpoint: string;
  private templates: Partial<Record<Modality, string | Record<string, unknown>>>;
  private timeoutSec: number;

  constructor(config: Config = {}) {
    this.endpoint = (config.endpoint ?? process.env.COMFYUI_ENDPOINT ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
    this.templates = { image: BUILTIN_T2I, ...config.workflows };
    this.timeoutSec = config.timeoutSec ?? 1800;
    this.capabilities = (Object.keys(this.templates) as Modality[]).filter((m) => m === 'image' || m === 'video' || m === 'image-edit');
  }

  async submit(req: GenerateRequest): Promise<ProviderTicket> {
    const tpl = this.templates[req.modality];
    if (!tpl) throw new Error(`comfyui 未配置 ${req.modality} 工作流模板`);
    const workflow = await loadTemplate(tpl);
    const [w, h] = parseSize(req.params.size);
    const filled = fillPlaceholders(workflow, {
      prompt: req.prompt ?? '',
      negative: String(req.params.negative ?? ''),
      width: String(w),
      height: String(h),
      seed: String(Math.floor(Math.random() * 2 ** 31)),
      ref_image: req.refImage ?? ''
    });

    const res = await fetch(`${this.endpoint}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: filled, client_id: `dsh-media-${Date.now()}` })
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.prompt_id) {
      throw new Error(`ComfyUI 提交失败 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return { provider: this.id, handle: data.prompt_id, meta: { modality: req.modality, submittedAt: Date.now() } };
  }

  async poll(ticket: ProviderTicket): Promise<TaskProgress> {
    if ((Date.now() - Number(ticket.meta?.submittedAt ?? Date.now())) / 1000 > this.timeoutSec) {
      return { status: 'failed', error: `ComfyUI 任务超时（>${this.timeoutSec}s）` };
    }
    const res = await fetch(`${this.endpoint}/history/${encodeURIComponent(ticket.handle)}`);
    if (!res.ok) return { status: 'running', percent: 10 };
    const history: any = await res.json();
    const entry = history?.[ticket.handle];
    if (!entry) return { status: 'running', percent: 10 };
    const st = entry.status?.status_str;
    if (st === 'error') return { status: 'failed', error: 'ComfyUI 工作流执行出错，详见 ComfyUI 控制台' };
    if (entry.outputs && Object.keys(entry.outputs).length > 0) {
      return { status: 'succeeded', percent: 100 };
    }
    return { status: 'running', percent: 50 };
  }

  async fetch(ticket: ProviderTicket): Promise<Artifact[]> {
    const res = await fetch(`${this.endpoint}/history/${encodeURIComponent(ticket.handle)}`);
    const history: any = await res.json();
    const entry = history?.[ticket.handle];
    if (!entry?.outputs) throw new Error('ComfyUI 无输出记录');
    const kind = (ticket.meta?.modality as Modality) ?? 'image';

    const arts: Artifact[] = [];
    for (const nodeOut of Object.values<any>(entry.outputs)) {
      for (const item of [...(nodeOut.images ?? []), ...(nodeOut.gifs ?? []), ...(nodeOut.audio ?? [])]) {
        const params = new URLSearchParams({
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type ?? 'output'
        });
        const r = await fetch(`${this.endpoint}/view?${params}`);
        if (!r.ok) continue;
        arts.push({
          kind,
          mime: r.headers.get('content-type') ?? guessMime(item.filename),
          data: new Uint8Array(await r.arrayBuffer()),
          filename: item.filename
        });
      }
    }
    if (!arts.length) throw new Error('ComfyUI 输出中未找到媒体文件');
    return arts;
  }

  async cancel(ticket: ProviderTicket): Promise<void> {
    await fetch(`${this.endpoint}/interrupt`, { method: 'POST' }).catch(() => {});
    void ticket;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/system_stats`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ---------- 工具函数 ----------

async function loadTemplate(tpl: string | Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof tpl !== 'string') return structuredClone(tpl);
  return JSON.parse(await readFile(tpl, 'utf-8'));
}

/** 深度遍历，替换字符串中的 {{key}} 占位符 */
function fillPlaceholders(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
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
