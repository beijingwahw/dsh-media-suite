/**
 * dsh-media-core —— Cordis 插件入口。
 *
 * dsh 处于 developer preview，插件宿主 API 可能变化。
 * 本入口对宿主做最小假设：
 *  - ctx.provide / ctx.on / ctx.dispose（Cordis 标准能力）
 *  - 工具注册优先走宿主 `tool-registry` 服务（若可用），否则退回事件广播，
 *    由 UI 或适配层拾取。
 */
import { join } from 'node:path';
import { ArtifactManager } from './artifacts.js';
import { Budget } from './budget.js';
import { Pricing } from './pricing.js';
import type { MediaProvider } from './protocol.js';
import { TaskQueue } from './queue.js';
import { MemoryTaskStore, SqliteTaskStore, type TaskStore } from './store.js';
import { MediaService, TOOL_DEFS } from './tools.js';

export * from './protocol.js';
export * from './tools.js';
export { TaskQueue } from './queue.js';
export { MemoryTaskStore, SqliteTaskStore } from './store.js';
export { Budget, BudgetError } from './budget.js';
export { Pricing, DEFAULT_PRICES } from './pricing.js';
export { ArtifactManager } from './artifacts.js';
export { MediaService } from './tools.js';

export const name = 'media-core';

export interface Config {
  defaultProvider?: Record<string, string>;
  budget?: { dailyCNY?: number; perTaskCNY?: number };
  concurrency?: { image?: number; video?: number; speech?: number };
  outputDir?: string;
  storage?: 'sqlite' | 'memory';
  dbFile?: string;
  maxRetries?: number;
  pollIntervalMs?: number;
}

/** Cordis 上下文中本插件实际用到的最小能力面 */
interface PluginContext {
  provide<K extends string>(key: K, value: unknown, autowire?: boolean): void;
  on(event: string, handler: (...args: any[]) => any): () => void;
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  root?: any;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): MediaService {
  const workspaceDir: string = ctx.root?.workspaceDir ?? process.cwd();
  const dshHome: string = process.env.DSH_HOME ?? join(workspaceDir, '.dsh');

  // ---- 存储 ----
  let store: TaskStore;
  if (config.storage === 'memory') {
    store = new MemoryTaskStore();
  } else {
    store = new SqliteTaskStore(config.dbFile ?? join(dshHome, 'media.db'));
  }

  // ---- 产物管理：落盘 + 会话事件注入 ----
  const artifactManager = new ArtifactManager({
    outputDir: config.outputDir ?? 'assets/media',
    workspaceDir,
    onSessionEvent: (e) => ctx.emit?.('media/artifact:created', e)
  });

  const pricing = new Pricing();
  const budget = new Budget(store, config.budget ?? {});
  const queue = new TaskQueue(
    store,
    budget,
    pricing,
    artifactManager,
    {
      concurrency: config.concurrency ?? {},
      maxRetries: config.maxRetries ?? 3,
      pollIntervalMs: config.pollIntervalMs ?? 3000
    },
    config.defaultProvider ?? {}
  );

  const media = new MediaService(queue, store, budget, pricing);

  // ---- 初始化（含崩溃恢复）----
  const ready = store.init().then(async () => {
    const n = await store.requeueInterrupted();
    if (n > 0) console.warn(`[media-core] 恢复 ${n} 个中断任务，重新入队`);
  });

  // ---- Provider 热插拔注册 ----
  const offRegister = ctx.on('media/provider:register', (provider: MediaProvider) => {
    queue.registerProvider(provider);
    ctx.emit?.('media/provider:changed', media.providers());
  });
  const offUnregister = ctx.on('media/provider:unregister', (id: string) => {
    queue.unregisterProvider(id);
    ctx.emit?.('media/provider:changed', media.providers());
  });

  // ---- 任务事件转发到 Cordis 事件总线（供 UI 插件订阅）----
  const offQueue = queue.on((e) => {
    if (e.type === 'task:updated') ctx.emit?.('media/task:updated', e.task);
  });

  // ---- 工具注册：优先宿主 tool-registry，退回事件广播 ----
  const registry = ctx.toolRegistry ?? ctx.registry?.tool;
  if (registry && typeof registry.register === 'function') {
    for (const def of TOOL_DEFS) {
      registry.register(def, async (input: any) => handleTool(media, def.name, input));
    }
  } else {
    ctx.emit?.('media/tools:declare', {
      defs: TOOL_DEFS,
      invoke: (name: string, input: any) => handleTool(media, name, input)
    });
  }

  // ---- 对外提供 media 服务 ----
  ctx.provide('media', media, true);

  // ---- 卸载回收（Cordis 可逆副作用之外的手动清理）----
  const dispose = async () => {
    queue.close();
    await queue.idle();
    offRegister();
    offUnregister();
    offQueue();
    await store.close();
  };
  if (typeof ctx.dispose === 'function') ctx.dispose(dispose as any);

  (media as any).ready = ready;
  return media;
}

async function handleTool(media: MediaService, tool: string, input: any): Promise<unknown> {
  switch (tool) {
    case 'generate_image':
      return summarize(await media.generateImage(input));
    case 'edit_image':
      return summarize(await media.editImage(input));
    case 'generate_speech':
      return summarize(await media.generateSpeech(input));
    case 'generate_video':
      return summarize(await media.generateVideo(input), true);
    case 'media_task_status': {
      if (input.action === 'cancel') {
        return { canceled: await media.cancel(input.task_id) };
      }
      return media.taskStatus(input.task_id);
    }
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

function summarize(t: import('./protocol.js').TaskRecord, asyncHint = false) {
  const base = {
    task_id: t.id,
    status: t.status,
    provider: t.provider,
    modality: t.modality,
    error: t.error
  };
  if (t.status === 'rejected') return { ...base, message: t.error };
  if (asyncHint) {
    return { ...base, message: '视频为异步长任务，已入队。可调用 media_task_status 查询进度；完成后产物自动保存到工作区。' };
  }
  return { ...base, message: t.status === 'succeeded' ? '生成完成，产物见 artifacts' : '任务已入队，稍后可用 media_task_status 查询' };
}
