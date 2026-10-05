import type { Budget } from './budget.js';
import { configError } from './errors.js';
import { Pricing, quantityOf } from './pricing.js';
import { isTerminal, type Modality, type TaskRecord } from './protocol.js';
import type { TaskQueue } from './queue.js';
import type { TaskStore } from './store.js';

/**
 * 对外统一门面：Cordis 服务名 `media`。
 * UI 插件、其他插件、Agent 工具都通过它交互，不直接触碰队列内部。
 */
export class MediaService {
  constructor(
    public readonly queue: TaskQueue,
    public readonly store: TaskStore,
    public readonly budget: Budget,
    public readonly pricing: Pricing
  ) {}

  generateImage(input: ToolInput.Image, session?: SessionCtx): Promise<TaskRecord> {
    validateImage(input);
    return this.queue.enqueue({
      modality: 'image',
      prompt: input.prompt,
      refImage: input.ref_image,
      params: { size: input.size, n: input.n ?? 1, style: input.style, quality: input.quality },
      providerHint: input.provider,
      sessionId: session?.sessionId,
      workspaceDir: session?.workspaceDir
    });
  }

  editImage(input: ToolInput.EditImage, session?: SessionCtx): Promise<TaskRecord> {
    validateEditImage(input);
    return this.queue.enqueue({
      modality: 'image-edit',
      prompt: input.instruction,
      refImage: input.image_path,
      mask: input.mask,
      params: { strength: input.strength },
      providerHint: input.provider,
      sessionId: session?.sessionId,
      workspaceDir: session?.workspaceDir
    });
  }

  generateSpeech(input: ToolInput.Speech, session?: SessionCtx): Promise<TaskRecord> {
    validateSpeech(input);
    return this.queue.enqueue({
      modality: 'speech',
      prompt: input.text,
      params: { voice: input.voice, format: input.format ?? 'mp3', speed: input.speed ?? 1 },
      providerHint: input.provider,
      sessionId: session?.sessionId,
      workspaceDir: session?.workspaceDir
    });
  }

  generateVideo(input: ToolInput.Video, session?: SessionCtx): Promise<TaskRecord> {
    validateVideo(input);
    return this.queue.enqueue({
      modality: 'video',
      prompt: input.prompt,
      refImage: input.ref_image,
      params: { duration: input.duration ?? 5, size: input.size },
      providerHint: input.provider,
      sessionId: session?.sessionId,
      workspaceDir: session?.workspaceDir
    });
  }

  /** 入队并等待终态（用于 wait=true 的短任务） */
  async generateAndWait(
    kind: 'image' | 'speech' | 'edit',
    input: any,
    session?: SessionCtx,
    waitMs?: number
  ): Promise<TaskView> {
    const t =
      kind === 'image'
        ? await this.queue.enqueueAndWait(toReq('image', input, session), waitMs)
        : kind === 'speech'
          ? await this.queue.enqueueAndWait(toReq('speech', input, session), waitMs)
          : await this.queue.enqueueAndWait(toReq('image-edit', input, session), waitMs);
    return (await this.taskStatus(t.id))!;
  }

  async taskStatus(id: string): Promise<TaskView | undefined> {
    const t = await this.store.getTask(id);
    if (!t) return undefined;
    const arts = await this.store.listArtifacts(id);
    return { ...t, artifacts: arts.map((a) => ({ path: a.path, mime: a.mime, bytes: a.bytes })) };
  }

  async cancel(id: string): Promise<boolean> {
    return this.queue.cancel(id);
  }

  providers(): { id: string; capabilities: string[] }[] {
    return this.queue.listProviders();
  }

  estimateCost(provider: string, modality: Modality, params: Record<string, unknown>, textLength = 0): number {
    return this.pricing.estimate({ provider, modality, quantity: quantityOf(modality, params, textLength) });
  }
}

function toReq(kind: Modality, input: any, session?: SessionCtx): any {
  if (kind === 'speech') {
    validateSpeech(input);
    return { modality: 'speech', prompt: input.text, params: { voice: input.voice, format: input.format ?? 'mp3', speed: input.speed ?? 1 }, providerHint: input.provider, sessionId: session?.sessionId, workspaceDir: session?.workspaceDir };
  }
  if (kind === 'image-edit') {
    validateEditImage(input);
    return { modality: 'image-edit', prompt: input.instruction, refImage: input.image_path, mask: input.mask, params: { strength: input.strength }, providerHint: input.provider, sessionId: session?.sessionId, workspaceDir: session?.workspaceDir };
  }
  validateImage(input);
  return { modality: 'image', prompt: input.prompt, refImage: input.ref_image, params: { size: input.size, n: input.n ?? 1, style: input.style, quality: input.quality }, providerHint: input.provider, sessionId: session?.sessionId, workspaceDir: session?.workspaceDir };
}

// ---------- 入参前置校验：非法参数在入队前拒绝，不进队列烧重试 ----------

const SIZE_RE = /^\d{2,4}\s*[*x×]\s*\d{2,4}$/i;

export function validateImage(i: ToolInput.Image): void {
  if (!i.prompt || !String(i.prompt).trim()) throw configError('generate_image: prompt 不能为空');
  if (i.n !== undefined && (!Number.isInteger(i.n) || i.n < 1 || i.n > 4)) throw configError('generate_image: n 必须是 1-4 的整数');
  if (i.size !== undefined && !SIZE_RE.test(String(i.size))) throw configError(`generate_image: size 格式非法（${i.size}），应形如 1024*1024`);
}

export function validateEditImage(i: ToolInput.EditImage): void {
  if (!i.image_path || !String(i.image_path).trim()) throw configError('edit_image: image_path 不能为空');
  if (!i.instruction || !String(i.instruction).trim()) throw configError('edit_image: instruction 不能为空');
  if (i.strength !== undefined && (Number(i.strength) < 0 || Number(i.strength) > 1)) throw configError('edit_image: strength 必须在 0-1 之间');
}

export function validateSpeech(i: ToolInput.Speech): void {
  if (!i.text || !String(i.text).trim()) throw configError('generate_speech: text 不能为空');
  if (i.speed !== undefined && (Number(i.speed) < 0.5 || Number(i.speed) > 2)) throw configError('generate_speech: speed 必须在 0.5-2 之间');
  if (i.format !== undefined && !['mp3', 'wav', 'opus'].includes(i.format)) throw configError('generate_speech: format 仅支持 mp3/wav/opus');
}

export function validateVideo(i: ToolInput.Video): void {
  if (!i.prompt || !String(i.prompt).trim()) throw configError('generate_video: prompt 不能为空');
  if (i.duration !== undefined && (Number(i.duration) < 1 || Number(i.duration) > 60)) throw configError('generate_video: duration 必须在 1-60 秒之间');
}

export interface SessionCtx {
  sessionId?: string;
  workspaceDir?: string;
}

export interface TaskView extends TaskRecord {
  artifacts: { path: string; mime: string; bytes: number }[];
}

export namespace ToolInput {
  export interface Image {
    prompt: string;
    size?: string;
    n?: number;
    style?: string;
    quality?: string;
    provider?: string;
    ref_image?: string;
    /** 同步等待完成（默认 true，超时自动转异步并返回 task_id） */
    wait?: boolean;
  }
  export interface EditImage {
    image_path: string;
    instruction: string;
    mask?: string;
    strength?: number;
    provider?: string;
    wait?: boolean;
  }
  export interface Speech {
    text: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    speed?: number;
    provider?: string;
    wait?: boolean;
  }
  export interface Video {
    prompt: string;
    duration?: number;
    size?: string;
    ref_image?: string;
    provider?: string;
  }
}

/**
 * Agent 工具 Schema 定义。
 * dsh 的工具注册接口处于 developer preview，这里以纯数据形式导出，
 * 由 index.ts 按当前运行时的注册方式挂载。
 */
export const TOOL_DEFS = [
  {
    name: 'generate_image',
    description: '生成图像。默认同步等待完成并直接返回产物路径（超时自动转异步）；产物自动保存到工作区 assets/media/ 并写入会话轨迹。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像描述提示词' },
        size: { type: 'string', description: '尺寸，如 1024*1024', default: '1024*1024' },
        n: { type: 'number', description: '生成张数 1-4', default: 1 },
        style: { type: 'string', description: '风格，如 <photography> / <anime>' },
        quality: { type: 'string', description: '质量档位（部分模型支持），如 low/medium/high' },
        provider: { type: 'string', description: '指定提供方：bailian / openai / comfyui，缺省自动路由；指定方不可用时自动故障转移' },
        ref_image: { type: 'string', description: '参考图路径或 URL（可选）' },
        wait: { type: 'boolean', description: '是否同步等待完成', default: true }
      },
      required: ['prompt']
    }
  },
  {
    name: 'edit_image',
    description: '基于参考图与指令编辑图像（重绘/风格迁移/局部修改）。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '待编辑图像的本地路径或 URL' },
        instruction: { type: 'string', description: '编辑指令' },
        mask: { type: 'string', description: '蒙版路径（局部重绘可选）' },
        strength: { type: 'number', description: '重绘强度 0-1', default: 0.7 },
        provider: { type: 'string' },
        wait: { type: 'boolean', default: true }
      },
      required: ['image_path', 'instruction']
    }
  },
  {
    name: 'generate_speech',
    description: '文字转语音。默认同步等待，返回音频文件路径。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待合成文本' },
        voice: { type: 'string', description: '音色，缺省用提供方默认音色' },
        format: { type: 'string', enum: ['mp3', 'wav', 'opus'], default: 'mp3' },
        speed: { type: 'number', description: '语速 0.5-2', default: 1 },
        provider: { type: 'string' },
        wait: { type: 'boolean', default: true }
      },
      required: ['text']
    }
  },
  {
    name: 'generate_video',
    description: '生成视频（异步长任务）。立即返回 task_id，可用 media_task_status 查询进度，完成后产物落盘工作区。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述提示词' },
        duration: { type: 'number', description: '时长（秒）1-60', default: 5 },
        size: { type: 'string', description: '分辨率，如 1280*720' },
        ref_image: { type: 'string', description: '首帧参考图（图生视频可选）' },
        provider: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'media_task_status',
    description: '查询媒体生成任务状态、成本与产物列表，或取消任务（action=cancel）。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        action: { type: 'string', enum: ['status', 'cancel'], default: 'status' }
      },
      required: ['task_id']
    }
  }
] as const;

export { isTerminal };
