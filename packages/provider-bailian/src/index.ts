/**
 * dsh-media-bailian —— 阿里云百炼（DashScope）Provider。
 *
 * 覆盖模态：
 *  - image      通义万相文生图（异步任务 + 轮询）
 *  - image-edit 万相图像编辑（参考图重绘/风格迁移）
 *  - video      万相图生视频/文生视频（异步任务 + 轮询）
 *  - speech     CosyVoice TTS（同步）
 *
 * 深度优化：错误分级（4xx 不重试 / 429、5xx 重试）、全请求超时、
 * usage 真实计费量回传 core 精确结算、参考图本地文件前置校验。
 *
 * ⚠️ DashScope 处于快速迭代期，模型名与端点以官方文档为准，可在 config.models 覆盖。
 */
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

export const name = 'media-bailian';

export interface Config {
  apiKey?: string;
  baseUrl?: string;
  models?: Partial<Record<Modality, string>>;
  /** 单请求 HTTP 超时（ms），默认 30s；任务级总超时由 core 控制 */
  requestTimeoutMs?: number;
}

// 模型名均已在百炼官方文档核实（2026-10-05）：
//  - wanx2.1-t2i-turbo：0.14 元/张，异步 HTTP
//  - wanx2.1-imageedit：0.14 元/张，异步 HTTP
//  - wanx2.1-t2v-turbo：480P/720P 0.24 元/秒，异步 HTTP
//  - qwen3-tts-flash：0.8 元/万字符，非实时 HTTP（multimodal-generation 端点）
// 注意：cosyvoice 系列仅支持 WebSocket 接口，本插件的 HTTP 链路不适用，
// 故 TTS 默认走 qwen3-tts-flash；如需 cosyvoice 请自行桥接 WebSocket。
const DEFAULT_MODELS: Record<Modality, string> = {
  image: 'wanx2.1-t2i-turbo',
  'image-edit': 'wanx2.1-imageedit',
  video: 'wanx2.1-t2v-turbo',
  speech: 'qwen3-tts-flash'
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav'
};

interface PluginContext {
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): void {
  const provider = new BailianProvider(config);
  ctx.emit?.('media/provider:register', provider);
  ctx.dispose?.(() => ctx.emit?.('media/provider:unregister', provider.id));
}

export class BailianProvider implements MediaProvider {
  readonly id = 'bailian';
  readonly capabilities: Modality[] = ['image', 'image-edit', 'video', 'speech'];

  private apiKey: string;
  private baseUrl: string;
  private models: Record<Modality, string>;
  private requestTimeoutMs: number;

  constructor(config: Config = {}) {
    this.apiKey = config.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn('[media-bailian] 未配置 API Key（config.apiKey 或 DASHSCOPE_API_KEY），提交任务将失败');
    }
    this.baseUrl = (config.baseUrl ?? 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
    this.models = { ...DEFAULT_MODELS, ...config.models };
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  }

  async submit(req: GenerateRequest): Promise<ProviderTicket> {
    if (!this.apiKey) throw configError('百炼未配置 API Key（config.apiKey 或 DASHSCOPE_API_KEY）');
    // DashScope 只接受公网 URL / base64 data URI，本地路径提前拒绝，不进重试
    for (const [label, v] of [['参考图', req.refImage], ['蒙版', req.mask]] as const) {
      if (v && !isRemoteRef(v)) {
        throw configError(`百炼${label}需要公网可访问的 URL 或 data: URI，收到本地路径：${v}（可先上传或使用支持本地文件的 provider，如 comfyui）`);
      }
    }
    if (req.modality === 'speech') return this.submitSpeech(req);
    return this.submitAsyncTask(req);
  }

  /** 图像/视频：DashScope 异步任务，X-DashScope-Async: enable */
  private async submitAsyncTask(req: GenerateRequest): Promise<ProviderTicket> {
    const model = this.models[req.modality];
    const endpoint =
      req.modality === 'video'
        ? '/api/v1/services/aigc/video-generation/video-synthesis'
        : '/api/v1/services/aigc/text2image/image-synthesis';

    const input: Record<string, unknown> = { prompt: req.prompt };
    if (req.refImage) {
      input[req.modality === 'video' ? 'img_url' : 'base_image_url'] = req.refImage;
    }
    if (req.mask) input.mask_image_url = req.mask;

    const parameters: Record<string, unknown> = {};
    if (req.params.size) parameters.size = req.params.size;
    if (req.modality === 'image' && req.params.n) parameters.n = req.params.n;
    if (req.params.style) parameters.style = req.params.style;
    if (req.modality === 'video' && req.params.duration) parameters.duration = req.params.duration;

    const data = await this.http(endpoint, { model, input, parameters }, { async: true });
    const taskId = data?.output?.task_id;
    if (!taskId) throw new MediaError(`百炼未返回 task_id：${JSON.stringify(data).slice(0, 300)}`, false);
    return { provider: this.id, handle: taskId, meta: { modality: req.modality, submittedAt: Date.now() } };
  }

  /** TTS：同步调用，直接拿到音频 URL，ticket.handle 即 URL */
  private async submitSpeech(req: GenerateRequest): Promise<ProviderTicket> {
    const data = await this.http(
      '/api/v1/services/aigc/multimodal-generation/generation',
      {
        model: this.models.speech,
        input: { text: req.prompt, voice: req.params.voice ?? 'Cherry' }, // qwen3-tts 音色：Cherry/Serena/Ethan/Chelsie 等
        parameters: { format: req.params.format ?? 'mp3', speech_rate: req.params.speed ?? 1 }
      },
      { async: false }
    );
    const url: string | undefined = data?.output?.audio?.url ?? data?.output?.audio?.data;
    if (!url) throw new MediaError(`百炼 TTS 未返回音频：${JSON.stringify(data).slice(0, 300)}`, false);
    const usage = data?.usage;
    return {
      provider: this.id,
      handle: url.startsWith('http') ? url : `data:;base64,${url}`,
      meta: { sync: true, characters: usage?.characters }
    };
  }

  async poll(ticket: ProviderTicket): Promise<TaskProgress> {
    if (ticket.meta?.sync) {
      const chars = Number(ticket.meta?.characters ?? 0);
      return {
        status: 'succeeded',
        percent: 100,
        cost: chars > 0 ? { amount: chars, currency: 'char', cny: 0, quantity: chars / 1000 } : undefined
      };
    }
    const data = await this.httpGet(`/api/v1/tasks/${encodeURIComponent(ticket.handle)}`);
    const out = data?.output ?? {};
    switch (out.task_status as string) {
      case 'SUCCEEDED':
        return { status: 'succeeded', percent: 100, cost: this.costFromUsage(data?.usage, ticket) };
      case 'FAILED': {
        const msg = out.message ?? out.code ?? '百炼任务失败';
        // 内容审核/参数类失败不可重试
        const retryable = !/DataInspection|InvalidParameter|InvalidURL|Arrearage/i.test(String(out.code ?? ''));
        throw new MediaError(String(msg), retryable);
      }
      case 'CANCELED':
      case 'UNKNOWN':
        return { status: 'canceled' };
      default:
        return { status: 'running', percent: this.progressOf(out) };
    }
  }

  /** 从任务指标估算进度百分比（DashScope 无精确进度，用阶段启发式） */
  private progressOf(out: any): number {
    const metrics = out?.task_metrics;
    if (metrics) {
      const total = Number(metrics.TOTAL ?? 0);
      const done = Number(metrics.SUCCEEDED ?? 0);
      if (total > 0) return Math.min(95, Math.round((done / total) * 100));
    }
    return 50;
  }

  /** usage → CostInfo：回传真实计费量，cny 由 core Pricing 按单价表结算 */
  private costFromUsage(usage: any, ticket: ProviderTicket): TaskProgress['cost'] {
    if (!usage) return undefined;
    const quantity = Number(usage.image_count ?? usage.video_duration ?? usage.video_count ?? 0);
    if (!quantity) return undefined;
    void ticket;
    return { amount: quantity, currency: 'unit', cny: 0, quantity };
  }

  async fetch(ticket: ProviderTicket): Promise<Artifact[]> {
    if (ticket.meta?.sync) {
      return [await this.download(ticket.handle, 'speech')];
    }
    const data = await this.httpGet(`/api/v1/tasks/${encodeURIComponent(ticket.handle)}`);
    const out = data?.output ?? {};
    const urls: string[] = [];
    if (Array.isArray(out.results)) {
      for (const r of out.results) if (r?.url) urls.push(r.url);
    }
    if (out.video_url) urls.push(out.video_url);
    if (!urls.length) throw new MediaError('任务成功但未找到产物 URL', true);
    const kind = (ticket.meta?.modality as Modality) ?? 'image';
    return Promise.all(urls.map((u) => this.download(u, kind)));
  }

  async cancel(ticket: ProviderTicket): Promise<void> {
    // DashScope 任务取消端点（部分模型不支持，失败静默）
    await this.http(`/api/v1/tasks/${encodeURIComponent(ticket.handle)}/cancel`, {}, { method: 'POST' }).catch(() => {});
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.httpGet('/api/v1/tasks/healthcheck-nonexistent');
      return true; // 401 之外的响应说明网络与鉴权链路可达
    } catch (e) {
      return !/401|Unauthorized|InvalidApiKey/.test((e as Error).message);
    }
  }

  private async download(urlOrData: string, kind: Modality): Promise<Artifact> {
    if (urlOrData.startsWith('data:')) {
      const b64 = urlOrData.split(',')[1] ?? '';
      return { kind, mime: 'audio/mpeg', data: Buffer.from(b64, 'base64') };
    }
    const res = await fetch(urlOrData, { signal: AbortSignal.timeout(this.requestTimeoutMs * 2) });
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), 'bailian-download');
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get('content-type')?.split(';')[0] ?? MIME_BY_EXT[extOf(urlOrData)] ?? 'application/octet-stream';
    return { kind, mime, data: buf, filename: decodeURIComponent(urlOrData.split('/').pop()?.split('?')[0] ?? '') };
  }

  private async http(path: string, body: unknown, opts: { async?: boolean; method?: string } = {}): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
    if (opts.async) headers['X-DashScope-Async'] = 'enable';
    const res = await withTimeout(
      fetch(this.baseUrl + path, {
        method: opts.method ?? 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      }),
      this.requestTimeoutMs + 5000,
      'dashscope-request'
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw httpError(res.status, data?.message ?? data?.code ?? JSON.stringify(data), 'bailian');
    }
    return data;
  }

  private async httpGet(path: string): Promise<any> {
    const res = await withTimeout(
      fetch(this.baseUrl + path, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      }),
      this.requestTimeoutMs + 5000,
      'dashscope-get'
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 404) {
      throw httpError(res.status, data?.message ?? '', 'bailian');
    }
    return data;
  }
}

function isRemoteRef(v: string): boolean {
  return v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:') || v.startsWith('oss://');
}

function extOf(url: string): string {
  return (url.split('/').pop()?.split('?')[0]?.split('.').pop() ?? '').toLowerCase();
}
