import type { Budget } from './budget.js';
import { Pricing, quantityOf } from './pricing.js';
import type { Modality, TaskRecord } from './protocol.js';
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
    return this.queue.enqueue({
      modality: 'image',
      prompt: input.prompt,
      refImage: input.ref_image,
      params: { size: input.size, n: input.n ?? 1, style: input.style },
      providerHint: input.provider,
      sessionId: session?.sessionId,
      workspaceDir: session?.workspaceDir
    });
  }

  editImage(input: ToolInput.EditImage, session?: SessionCtx): Promise<TaskRecord> {
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
    provider?: string;
    ref_image?: string;
  }
  export interface EditImage {
    image_path: string;
    instruction: string;
    mask?: string;
    strength?: number;
    provider?: string;
  }
  export interface Speech {
    text: string;
    voice?: string;
    format?: 'mp3' | 'wav' | 'opus';
    speed?: number;
    provider?: string;
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
    description: '生成图像。返回任务记录；成功后产物自动保存到工作区 assets/media/ 并写入会话轨迹。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像描述提示词' },
        size: { type: 'string', description: '尺寸，如 1024*1024', default: '1024*1024' },
        n: { type: 'number', description: '生成张数 1-4', default: 1 },
        style: { type: 'string', description: '风格，如 <photography> / <anime>' },
        provider: { type: 'string', description: '指定提供方：bailian / openai / comfyui，缺省自动路由' },
        ref_image: { type: 'string', description: '参考图路径或 URL（可选）' }
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
        provider: { type: 'string' }
      },
      required: ['image_path', 'instruction']
    }
  },
  {
    name: 'generate_speech',
    description: '文字转语音。返回音频文件路径与时长。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待合成文本' },
        voice: { type: 'string', description: '音色，缺省用提供方默认音色' },
        format: { type: 'string', enum: ['mp3', 'wav', 'opus'], default: 'mp3' },
        speed: { type: 'number', description: '语速 0.5-2', default: 1 },
        provider: { type: 'string' }
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
        duration: { type: 'number', description: '时长（秒）', default: 5 },
        size: { type: 'string', description: '分辨率，如 1280*720' },
        ref_image: { type: 'string', description: '首帧参考图（图生视频可选）' },
        provider: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'media_task_status',
    description: '查询媒体生成任务状态与产物列表，或取消任务（action=cancel）。',
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
