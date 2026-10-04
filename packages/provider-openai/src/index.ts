/**
 * dsh-media-openai —— OpenAI 兼容 Provider。
 *
 * 覆盖模态：
 *  - image      POST /images/generations（gpt-image-1 返回 b64_json）
 *  - image-edit POST /images/edits（multipart）
 *  - speech     POST /audio/speech（返回音频 buffer）
 *  - video      不支持（capabilities 不声明，core 路由自动跳过）
 *
 * baseUrl 可指向任意 OpenAI 兼容网关（Azure/代理/自建）。
 */
import type {
  Artifact,
  GenerateRequest,
  MediaProvider,
  Modality,
  ProviderTicket,
  TaskProgress
} from 'dsh-media-core';

export const name = 'media-openai';

export interface Config {
  apiKey?: string;
  baseUrl?: string;
  imageModel?: string;
  ttsModel?: string;
  defaultVoice?: string;
}

interface PluginContext {
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): void {
  const provider = new OpenAIProvider(config);
  ctx.emit?.('media/provider:register', provider);
  ctx.dispose?.(() => ctx.emit?.('media/provider:unregister', provider.id));
}

/** ticket.handle 编码方式：`inline:<base64>` 或 `url:<href>` */
export class OpenAIProvider implements MediaProvider {
  readonly id = 'openai';
  readonly capabilities: Modality[] = ['image', 'image-edit', 'speech'];

  private apiKey: string;
  private baseUrl: string;
  private imageModel: string;
  private ttsModel: string;
  private defaultVoice: string;

  constructor(config: Config = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn('[media-openai] 未配置 API Key（config.apiKey 或 OPENAI_API_KEY）');
    }
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.imageModel = config.imageModel ?? 'gpt-image-1';
    this.ttsModel = config.ttsModel ?? 'gpt-4o-mini-tts';
    this.defaultVoice = config.defaultVoice ?? 'alloy';
  }

  /** 全部为同步接口：submit 内完成生成，结果编码进 ticket.handle */
  async submit(req: GenerateRequest): Promise<ProviderTicket> {
    switch (req.modality) {
      case 'image':
        return this.genImage(req);
      case 'image-edit':
        return this.editImage(req);
      case 'speech':
        return this.genSpeech(req);
      default:
        throw new Error(`openai provider 不支持模态 ${req.modality}`);
    }
  }

  poll(_ticket: ProviderTicket): Promise<TaskProgress> {
    return Promise.resolve({ status: 'succeeded', percent: 100 });
  }

  async fetch(ticket: ProviderTicket): Promise<Artifact[]> {
    const kind = (ticket.meta?.modality as Modality) ?? 'image';
    if (ticket.handle.startsWith('inline:')) {
      const b64 = ticket.handle.slice('inline:'.length);
      const buf = Buffer.from(b64, 'base64');
      const mime = kind === 'speech' ? `audio/${ticket.meta?.format ?? 'mp3'}` : 'image/png';
      return [{ kind, mime, data: buf }];
    }
    if (ticket.handle.startsWith('url:')) {
      const res = await fetch(ticket.handle.slice(4));
      if (!res.ok) throw new Error(`下载产物失败 HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const mime = res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
      return [{ kind, mime, data: buf }];
    }
    throw new Error(`无法识别的 ticket handle: ${ticket.handle.slice(0, 50)}`);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.auth() });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async genImage(req: GenerateRequest): Promise<ProviderTicket> {
    const data = await this.post('/images/generations', {
      model: this.imageModel,
      prompt: req.prompt,
      size: normalizeSize(req.params.size),
      n: Math.min(4, Math.max(1, Number(req.params.n ?? 1)))
    });
    const item = data?.data?.[0];
    if (!item) throw new Error('OpenAI 未返回图像数据');
    const handle = item.b64_json ? `inline:${item.b64_json}` : `url:${item.url}`;
    return { provider: this.id, handle, meta: { modality: 'image', count: data.data.length } };
  }

  private async editImage(req: GenerateRequest): Promise<ProviderTicket> {
    if (!req.refImage) throw new Error('edit_image 缺少 image_path');
    const form = new FormData();
    form.append('model', this.imageModel);
    form.append('prompt', req.prompt ?? '');
    const file = await toBlob(req.refImage);
    form.append('image', file, 'input.png');
    if (req.mask) form.append('mask', await toBlob(req.mask), 'mask.png');

    const res = await fetch(`${this.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${data?.error?.message ?? ''}`);
    const item = data?.data?.[0];
    if (!item) throw new Error('OpenAI 未返回编辑结果');
    const handle = item.b64_json ? `inline:${item.b64_json}` : `url:${item.url}`;
    return { provider: this.id, handle, meta: { modality: 'image-edit' } };
  }

  private async genSpeech(req: GenerateRequest): Promise<ProviderTicket> {
    const format = String(req.params.format ?? 'mp3');
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.ttsModel,
        input: req.prompt,
        voice: req.params.voice ?? this.defaultVoice,
        response_format: format,
        speed: req.params.speed ?? 1
      })
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      throw new Error(`OpenAI TTS HTTP ${res.status}: ${data?.error?.message ?? ''}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      provider: this.id,
      handle: `inline:${buf.toString('base64')}`,
      meta: { modality: 'speech', format }
    };
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
    return data;
  }
}

/** 各家 size 写法归一到 OpenAI 接受的格式 */
function normalizeSize(size: unknown): string {
  const s = String(size ?? '1024x1024').replace('*', 'x');
  return ['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(s) ? s : '1024x1024';
}

/** refImage 支持本地路径 / http URL / data URI */
async function toBlob(ref: string): Promise<Blob> {
  if (ref.startsWith('data:')) {
    const [head, b64] = ref.split(',');
    return new Blob([Buffer.from(b64 ?? '', 'base64')], { type: head.slice(5).split(';')[0] });
  }
  if (ref.startsWith('http')) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`下载参考图失败 HTTP ${res.status}`);
    return new Blob([new Uint8Array(await res.arrayBuffer())], { type: res.headers.get('content-type') ?? 'image/png' });
  }
  const { readFile } = await import('node:fs/promises');
  return new Blob([await readFile(ref)], { type: 'image/png' });
}
