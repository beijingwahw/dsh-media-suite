import { randomUUID } from 'node:crypto';
import { Budget, BudgetError } from './budget.js';
import { quantityOf, Pricing, round4 } from './pricing.js';
import { canTransition, type GenerateRequest, type MediaProvider, type TaskProgress, type TaskRecord, type TaskStatus } from './protocol.js';
import type { TaskStore } from './store.js';

export interface QueueConfig {
  /** 各模态最大并发（缺省 image:4 / video:2 / speech:4） */
  concurrency: { image?: number; video?: number; speech?: number };
  /** 失败重试上限 */
  maxRetries: number;
  /** 异步任务轮询间隔（ms） */
  pollIntervalMs: number;
}

const CONCURRENCY_DEFAULTS = { image: 4, video: 2, speech: 4 };

export type QueueEvent =
  | { type: 'task:updated'; task: TaskRecord }
  | { type: 'artifact:created'; taskId: string; path: string };

export type Listener = (e: QueueEvent) => void;

export interface ArtifactSink {
  /** 保存产物并返回落盘绝对路径与字节数 */
  save(taskId: string, art: { data: Uint8Array | string; mime: string; filename?: string; meta?: Record<string, unknown> }): Promise<{ path: string; bytes: number }>;
}

/**
 * 任务队列 + 状态机驱动。
 * pending → submitted → running → succeeded/failed/canceled；failed 可回 pending 重试（指数退避）。
 */
export class TaskQueue {
  private providers = new Map<string, MediaProvider>();
  private inflight = new Map<string, { cancel: boolean }>();
  private listeners = new Set<Listener>();
  private running = 0;
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private store: TaskStore,
    private budget: Budget,
    private pricing: Pricing,
    private sink: ArtifactSink,
    private config: QueueConfig,
    private defaultProvider: Record<string, string> = {}
  ) {}

  registerProvider(p: MediaProvider): void {
    this.providers.set(p.id, p);
  }

  unregisterProvider(id: string): void {
    this.providers.delete(id);
  }

  listProviders(): { id: string; capabilities: string[] }[] {
    return [...this.providers.values()].map((p) => ({ id: p.id, capabilities: p.capabilities }));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: QueueEvent): void {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  /** 路由：用户指定 > 模态默认 > 首个支持该模态的 provider */
  private route(modality: GenerateRequest['modality'], hint?: string): MediaProvider {
    if (hint) {
      const p = this.providers.get(hint);
      if (!p) throw new Error(`未找到 provider: ${hint}`);
      if (!p.capabilities.includes(modality)) throw new Error(`provider ${hint} 不支持模态 ${modality}`);
      return p;
    }
    const def = this.defaultProvider[modality];
    if (def) {
      const p = this.providers.get(def);
      if (p?.capabilities.includes(modality)) return p;
    }
    for (const p of this.providers.values()) {
      if (p.capabilities.includes(modality)) return p;
    }
    throw new Error(`没有已注册的 provider 支持模态 ${modality}`);
  }

  /** 创建任务并入队；预算超限同步返回 rejected 记录 */
  async enqueue(req: Omit<GenerateRequest, 'id'>): Promise<TaskRecord> {
    const id = randomUUID();
    const now = Date.now();
    let provider: MediaProvider;
    try {
      provider = this.route(req.modality, req.providerHint);
    } catch (e) {
      const rec: TaskRecord = {
        id, modality: req.modality, provider: req.providerHint ?? '-', status: 'rejected',
        requestJson: JSON.stringify(req), error: (e as Error).message, retries: 0,
        sessionId: req.sessionId, createdAt: now, updatedAt: now
      };
      await this.store.insertTask(rec);
      this.emit({ type: 'task:updated', task: rec });
      return rec;
    }

    const textLen = req.modality === 'speech' ? (req.prompt?.length ?? 0) : 0;
    const est = this.pricing.estimate({
      provider: provider.id,
      modality: req.modality,
      quantity: quantityOf(req.modality, req.params, textLen)
    });

    const base: TaskRecord = {
      id, modality: req.modality, provider: provider.id, status: 'pending',
      requestJson: JSON.stringify({ ...req, id }), retries: 0,
      sessionId: req.sessionId, createdAt: now, updatedAt: now
    };

    try {
      await this.budget.check(est);
    } catch (e) {
      if (e instanceof BudgetError) {
        base.status = 'rejected';
        base.error = e.message;
        await this.store.insertTask(base);
        this.emit({ type: 'task:updated', task: base });
        return base;
      }
      throw e;
    }

    await this.store.insertTask(base);
    this.emit({ type: 'task:updated', task: base });
    void this.drain();
    return base;
  }

  private concurrencyOf(modality: string): number {
    if (modality === 'video') return this.config.concurrency.video ?? CONCURRENCY_DEFAULTS.video;
    if (modality === 'speech') return this.config.concurrency.speech ?? CONCURRENCY_DEFAULTS.speech;
    return this.config.concurrency.image ?? CONCURRENCY_DEFAULTS.image;
  }

  /** 泵：取 pending 任务，在并发额度内启动 */
  private async drain(): Promise<void> {
    if (this.closed) return;
    this.running++; // drain 自身占一个槽位，确保 idle() 不会在调度完成前返回
    try {
      await this.drainInner();
    } finally {
      this.releaseSlot();
    }
  }

  private async drainInner(): Promise<void> {
    const pending = await this.store.listTasks({ status: 'pending', limit: 50 });
    const byModality = new Map<string, number>();
    for (const t of await this.store.listTasks({ limit: 500 })) {
      if (t.status === 'submitted' || t.status === 'running') {
        byModality.set(t.modality, (byModality.get(t.modality) ?? 0) + 1);
      }
    }
    for (const task of pending) {
      const used = byModality.get(task.modality) ?? 0;
      if (used >= this.concurrencyOf(task.modality)) continue;
      byModality.set(task.modality, used + 1);
      this.running++; // 先占位，避免 idle() 在异步启动前误判为空
      void this.run(task.id);
    }
  }

  private async transition(id: string, to: TaskStatus, patch: Partial<TaskRecord> = {}): Promise<void> {
    const cur = await this.store.getTask(id);
    if (!cur) return;
    if (!canTransition(cur.status, to)) return;
    await this.store.updateTask(id, { status: to, ...patch });
    const updated = (await this.store.getTask(id))!;
    this.emit({ type: 'task:updated', task: updated });
  }

  private async run(id: string): Promise<void> {
    const task = await this.store.getTask(id);
    if (!task || task.status !== 'pending') {
      this.finishSlot();
      return;
    }
    const provider = this.providers.get(task.provider);
    if (!provider) {
      await this.transition(id, 'rejected', { error: `provider ${task.provider} 未注册（可能已卸载）` });
      this.finishSlot();
      return;
    }
    const req: GenerateRequest = JSON.parse(task.requestJson);
    const ctl = { cancel: false };
    this.inflight.set(id, ctl);
    try {
      await this.transition(id, 'submitted');
      const ticket = await provider.submit(req);
      await this.store.updateTask(id, { ticketJson: JSON.stringify(ticket) });

      let progress: TaskProgress = { status: 'running', percent: 0 };
      await this.transition(id, 'running', { percent: 0 });

      if (provider.poll) {
        // 异步任务：轮询直到终态或取消
        for (;;) {
          if (ctl.cancel) break;
          await sleep(this.config.pollIntervalMs);
          progress = await provider.poll(ticket);
          await this.store.updateTask(id, { percent: progress.percent ?? undefined, error: progress.error });
          if (progress.status !== 'running') break;
        }
      }

      if (ctl.cancel) {
        if (provider.cancel) await provider.cancel(ticket).catch(() => {});
        await this.transition(id, 'canceled', { error: '用户取消' });
        return;
      }
      if (progress.status === 'failed') {
        throw new Error(progress.error ?? '提供方返回失败');
      }
      if (progress.status === 'canceled') {
        await this.transition(id, 'canceled');
        return;
      }

      const arts = await provider.fetch(ticket);
      for (const art of arts) {
        const saved = await this.sink.save(id, art);
        await this.store.insertArtifact({
          id: randomUUID(), taskId: id, kind: art.kind, path: saved.path,
          mime: art.mime, bytes: saved.bytes,
          metaJson: art.meta ? JSON.stringify(art.meta) : undefined, createdAt: Date.now()
        });
        this.emit({ type: 'artifact:created', taskId: id, path: saved.path });
      }

      const costCny = progress.cost?.cny ?? this.pricing.estimate({
        provider: provider.id,
        modality: task.modality,
        quantity: quantityOf(task.modality, req.params, req.modality === 'speech' ? (req.prompt?.length ?? 0) : 0)
      });
      await this.transition(id, 'succeeded', { percent: 100, costCny: round4(costCny) });
    } catch (e) {
      const msg = (e as Error).message;
      const cur = (await this.store.getTask(id))!;
      if (cur.retries < this.config.maxRetries) {
        // 指数退避后回到 pending 重试
        const delay = 1000 * 2 ** cur.retries;
        await this.store.updateTask(id, { retries: cur.retries + 1, error: msg });
        setTimeout(() => {
          void this.transition(id, 'failed', { error: msg }).then(async () => {
            await this.transition(id, 'pending');
            void this.drain();
          });
        }, delay);
      } else {
        await this.transition(id, 'failed', { error: msg });
      }
    } finally {
      this.inflight.delete(id);
      this.finishSlot();
    }
  }

  private releaseSlot(): void {
    this.running--;
    for (const w of this.waiters.splice(0)) w();
  }

  private finishSlot(): void {
    this.releaseSlot();
    void this.drain();
  }

  async cancel(id: string): Promise<boolean> {
    const ctl = this.inflight.get(id);
    const task = await this.store.getTask(id);
    if (!task) return false;
    if (ctl) {
      ctl.cancel = true;
      return true;
    }
    if (task.status === 'pending') {
      await this.transition(id, 'canceled', { error: '用户取消' });
      return true;
    }
    return false;
  }

  async status(id: string): Promise<TaskRecord | undefined> {
    return this.store.getTask(id);
  }

  /** 等待所有在飞任务结束（测试/优雅退停用） */
  async idle(): Promise<void> {
    while (this.running > 0) {
      await new Promise<void>((res) => this.waiters.push(res));
    }
  }

  close(): void {
    this.closed = true;
    for (const ctl of this.inflight.values()) ctl.cancel = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
