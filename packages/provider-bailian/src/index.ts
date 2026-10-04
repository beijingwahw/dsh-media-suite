/**
 * dsh-media-bailian —— 阿里云百炼（DashScope）Provider。
 *
 * 覆盖模态：
 *  - image      通义万相文生图（异步任务 + 轮询）
 *  - image-edit 万相图像编辑（参考图重绘/风格迁移）
 *  - video      万相图生视频/文生视频（异步任务 + 轮询）
 *  - speech     CosyVoice TTS（同步）
 *
 * ⚠️ DashScope 处于快速迭代期，模型名与端点以官方文档为准，可在 config.models 覆盖。
 */
import type {
  Artifact,
  GenerateRequest,
  MediaProvider,
  Modality,
  ProviderTicket,
  TaskProgress
} from 'dsh-media-core';

export const name = 'media-bailian';

export interface Config {
  apiKey?: string;
  baseUrl?: string;
  models?: Partial<Record<Modality, string>>;
  /** 轮询上限（秒），超时按失败处理 */
  timeoutSec?: number;
}

const DEFAULT_MODELS: Record<Modality, string> = {
  image: 'wanx2.1-t2i-turbo',
  'image-edit': 'wanx2.1-imageedit',
  video: 'wanx2.1-t2v-turbo',
  speech: 'cosyvoice-v2'
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav'
};

interface PluginContext {
  on(event: string, handler: (...args: any[]) => any): () => void;
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): void {
  const provider = new BailianProvider(config);
  // 向 core 注册；卸载时反注册（Cordis 可逆副作用之外的显式清理）
  ctx.emit?.('media/provider:register', provider);
  const off = ctx.on?.('media/provider:unregister-all', () => {});
  ctx.dispose?.(() => {
    ctx.emit?.('media/provider:unregister', provider.id);
    off?.();
  });
}

export class BailianProvider implements MediaProvider {
  readonly id = 'bailian';
  readonly capabilities: Modality[] = ['image', 'image-edit', 'video', 'speech'];

  private apiKey: string;
  private baseUrl: string;
  private models: Record<Modality, string>;
  private timeoutSec: number;

  constructor(config: Config = {}) {
    this.apiKey = config.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn('[media-bailian] 未配置 API Key（config.apiKey 或 DASHSCOPE_API_KEY），提交任务将失败');
    }
    this.baseUrl = (config.baseUrl ?? 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
    this.models = { ...DEFAULT_MODELS, ...config.models };
    this.timeoutSec = config.timeoutSec ?? 900;
  }

  async submit(req: GenerateRequest): Promise<ProviderTicket> {
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
    if (!taskId) throw new Error(`百炼未返回 task_id：${JSON.stringify(data).slice(0, 300)}`);
    return { provider: this.id, handle: taskId, meta: { modality: req.modality, submittedAt: Date.now() } };
  }

  /** TTS：同步调用，直接拿到音频 URL，ticket.handle 即 URL */
  private async submitSpeech(req: GenerateRequest): Promise<ProviderTicket> {
    const data = await this.http(
      '/api/v1/services/aigc/multimodal-generation/generation',
      {
        model: this.models.speech,
        input: { text: req.prompt, voice: req.params.voice ?? 'longxiaochun' },
        parameters: { format: req.params.format ?? 'mp3', speech_rate: req.params.speed ?? 1 }
      },
      { async: false }
    );
    const url: string | undefined = data?.output?.audio?.url ?? data?.output?.audio?.data;
    if (!url) throw new Error(`百炼 TTS 未返回音频：${JSON.stringify(data).slice(0, 300)}`);
    const usage = data?.usage;
    return {
      provider: this.id,
      handle: url.startsWith('http') ? url : `data:;base64,${url}`,
      meta: { sync: true, characters: usage?.characters }
    };
  }

  async poll(ticket: ProviderTicket): Promise<TaskProgress> {
    if (ticket.meta?.sync) return { status: 'succeeded', percent: 100 };
    const submittedAt = Number(ticket.meta?.submittedAt ?? Date.now());
    if ((Date.now() - submittedAt) / 1000 > this.timeoutSec) {
      return { status: 'failed', error: `任务超时（>${this.timeoutSec}s）` };
    }
    const data = await this.httpGet(`/api/v1/tasks/${encodeURIComponent(ticket.handle)}`);
    const st: string = data?.output?.task_status ?? 'UNKNOWN';
    switch (st) {
      case 'SUCCEEDED':
        return { status: 'succeeded', percent: 100, cost: this.costOf(data?.usage) };
      case 'FAILED':
        return { status: 'failed', error: data?.output?.message ?? data?.output?.code ?? '百炼任务失败' };
      case 'CANCELED':
      case 'UNKNOWN':
        return { status: 'canceled' };
      default:
        return { status: 'running', percent: 50 }; // PENDING / RUNNING，DashScope 不提供细粒度进度
    }
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
    if (!urls.length) throw new Error('任务成功但未找到产物 URL');
    const kind = (ticket.meta?.modality as Modality) ?? 'image';
    return Promise.all(urls.map((u) => this.download(u, kind)));
  }

  async cancel(ticket: ProviderTicket): Promise<void> {
    // DashScope 通用任务取消端点（部分模型不支持，失败静默）
    await this.http(`/api/v1/tasks/${encodeURIComponent(ticket.handle)}/cancel`, {}, { method: 'POST' }).catch(() => {});
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.httpGet('/api/v1/tasks/healthcheck-nonexistent');
      return true; // 401 之外的响应都说明网络与鉴权链路可达
    } catch (e) {
      return !/401|Unauthorized|InvalidApiKey/.test((e as Error).message);
    }
  }

  private costOf(_usage: any): TaskProgress['cost'] {
    // 百炼 usage 单位口径不一，成本统一交由 core Pricing 单价表折算，这里不透传以免覆盖预算记账
    return undefined;
  }

  private async download(urlOrData: string, kind: Modality): Promise<Artifact> {
    if (urlOrData.startsWith('data:')) {
      const b64 = urlOrData.split(',')[1] ?? '';
      return { kind, mime: 'audio/mpeg', data: Buffer.from(b64, 'base64') };
    }
    const res = await fetch(urlOrData);
    if (!res.ok) throw new Error(`下载产物失败 HTTP ${res.status}: ${urlOrData.slice(0, 120)}`);
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
    const res = await fetch(this.baseUrl + path, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.method === 'POST' || !opts.method ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`DashScope HTTP ${res.status}: ${data?.message ?? data?.code ?? JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  private async httpGet(path: string): Promise<any> {
    const res = await fetch(this.baseUrl + path, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 404) {
      throw new Error(`DashScope HTTP ${res.status}: ${data?.message ?? ''}`);
    }
    return data;
  }
}

function extOf(url: string): string {
  return (url.split('/').pop()?.split('?')[0]?.split('.').pop() ?? '').toLowerCase();
}
