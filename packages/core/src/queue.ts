import { randomUUID } from 'node:crypto';
import { Budget, BudgetError } from './budget.js';
import { asMediaError, configError, isRetryable, MediaError, withTimeout } from './errors.js';
import { quantityOf, Pricing, round4 } from './pricing.js';
import {
  canTransition,
  isTerminal,
  type GenerateRequest,
  type MediaProvider,
  type TaskRecord,
  type TaskStatus
} from './protocol.js';
import type { TaskStore } from './store.js';

export interface QueueConfig {
  /** 各模态最大并发（缺省 image:4 / video:2 / speech:4） */
  concurrency: { image?: number; video?: number; speech?: number };
  /** 失败重试上限（仅可重试错误） */
  maxRetries: number;
  /** 异步任务基础轮询间隔（ms），指数递增至 pollMaxIntervalMs */
  pollIntervalMs: number;
  /** 轮询间隔上限（ms），缺省 30000 */
  pollMaxIntervalMs?: number;
  /** Provider 故障自动转移（缺省 true）：路由时健康探测，不可用自动降级到下一个候选 */
  failover?: boolean;
  /** 各模态任务总超时（ms）；超时按可重试失败处理 */
  timeouts?: { image?: number; video?: number; speech?: number };
}

const CONCURRENCY_DEFAULTS = { image: 4, video: 2, speech: 4 };
const TIMEOUT_DEFAULTS = { image: 300_000, video: 1_800_000, speech: 120_000 };
const HEALTH_CACHE_MS = 30_000;

export type QueueEvent =
  | { type: 'task:updated'; task: TaskRecord }
  | { type: 'artifact:created'; taskId: string; path: string };

export type Listener = (e: QueueEvent) => void;

export interface ArtifactSink {
  save(
    taskId: string,
    art: { data: Uint8Array | string; mime: string; filename?: string; meta?: Record<string, unknown> }
  ): Promise<{ path: string; bytes: number; hash?: string; deduped?: boolean }>;
}

/**
 * 任务队列 + 状态机驱动。
 * pending → submitted → running → succeeded/failed/canceled；
 * 可重试失败回 pending 指数退避重试；不可重试错误立即 failed。
 */
export class TaskQueue {
  private providers = new Map<string, MediaProvider>();
  private inflight = new Map<string, { cancel: boolean }>();
  private listeners = new Set<Listener>();
  private running = 0;
  private waiters: (() => void)[] = [];
  private closed = false;
  private healthCache = new Map<string, { ok: boolean; ts: number }>();
  /** taskId → 预算预扣凭据 */
  private reservations = new Map<string, string>();

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
    this.healthCache.delete(p.id);
  }

  unregisterProvider(id: string): void {
    this.providers.delete(id);
    this.healthCache.delete(id);
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

  // ---------- 路由与故障转移 ----------

  private async healthy(p: MediaProvider): Promise<boolean> {
    const cached = this.healthCache.get(p.id);
    if (cached && Date.now() - cached.ts < HEALTH_CACHE_MS) return cached.ok;
    let ok = false;
    try {
      ok = await withTimeout(p.healthCheck(), 5000, `healthCheck(${p.id})`);
    } catch {
      ok = false;
    }
    this.healthCache.set(p.id, { ok, ts: Date.now() });
    return ok;
  }

  /** 路由：hint 优先；否则 模态默认 → 其余候选。failover 开启时按健康度择优。 */
  private async pickProvider(modality: GenerateRequest['modality'], hint?: string): Promise<MediaProvider> {
    const candidates: MediaProvider[] = [];
    if (hint) {
      const p = this.providers.get(hint);
      if (!p) throw configError(`未找到 provider: ${hint}`);
      if (!p.capabilities.includes(modality)) throw configError(`provider ${hint} 不支持模态 ${modality}`);
      candidates.push(p);
    } else {
      const def = this.defaultProvider[modality];
      const defP = def ? this.providers.get(def) : undefined;
      if (defP?.capabilities.includes(modality)) candidates.push(defP);
      for (const p of this.providers.values()) {
        if (p.capabilities.includes(modality) && !candidates.includes(p)) candidates.push(p);
      }
    }
    if (!candidates.length) throw configError(`没有已注册的 provider 支持模态 ${modality}`);
    if (this.config.failover === false || candidates.length === 1) return candidates[0];

    for (const p of candidates) {
      if (await this.healthy(p)) return p;
    }
    // 全部不健康：仍用首选（可能是探测误报），由提交阶段的错误分级兜底
    return candidates[0];
  }

  // ---------- 入队 ----------

  /** 创建任务并入队；预算超限/路由失败同步返回 rejected 记录 */
  async enqueue(req: Omit<GenerateRequest, 'id'>): Promise<TaskRecord> {
    const id = randomUUID();
    const now = Date.now();

    let provider: MediaProvider;
    try {
      provider = await this.pickProvider(req.modality, req.providerHint);
    } catch (e) {
      return this.reject(id, req, req.providerHint ?? '-', (e as Error).message, now);
    }

    const textLen = req.modality === 'speech' ? (req.prompt?.length ?? 0) : 0;
    const est = this.pricing.estimate({
      provider: provider.id,
      modality: req.modality,
      quantity: quantityOf(req.modality, req.params, textLen)
    });

    let reservationId: string | undefined;
    try {
      reservationId = await this.budget.reserve(est);
    } catch (e) {
      if (e instanceof BudgetError) return this.reject(id, req, provider.id, e.message, now);
      throw e;
    }
    this.reservations.set(id, reservationId);

    const rec: TaskRecord = {
      id, modality: req.modality, provider: provider.id, status: 'pending',
      requestJson: JSON.stringify({ ...req, id }), retries: 0,
      sessionId: req.sessionId, createdAt: now, updatedAt: now
    };
    await this.store.insertTask(rec);
    this.emit({ type: 'task:updated', task: rec });
    void this.drain();
    return rec;
  }

  /** 入队并等待终态；超时返回当前状态（任务继续在后台执行） */
  async enqueueAndWait(req: Omit<GenerateRequest, 'id'>, waitMs = 180_000): Promise<TaskRecord> {
    const t = await this.enqueue(req);
    if (isTerminal(t.status)) return t;
    return new Promise<TaskRecord>((resolve) => {
      const timer = setTimeout(async () => {
        off();
        resolve((await this.store.getTask(t.id))!);
      }, waitMs);
      const off = this.on(async (e) => {
        if (e.type === 'task:updated' && e.task.id === t.id && isTerminal(e.task.status)) {
          clearTimeout(timer);
          off();
          resolve(e.task);
        }
      });
    });
  }

  private async reject(id: string, req: Omit<GenerateRequest, 'id'>, provider: string, error: string, now: number): Promise<TaskRecord> {
    const rec: TaskRecord = {
      id, modality: req.modality, provider, status: 'rejected',
      requestJson: JSON.stringify({ ...req, id }), error, retries: 0,
      sessionId: req.sessionId, createdAt: now, updatedAt: now
    };
    await this.store.insertTask(rec);
    this.emit({ type: 'task:updated', task: rec });
    return rec;
  }

  // ---------- 调度 ----------

  private concurrencyOf(modality: string): number {
    if (modality === 'video') return this.config.concurrency.video ?? CONCURRENCY_DEFAULTS.video;
    if (modality === 'speech') return this.config.concurrency.speech ?? CONCURRENCY_DEFAULTS.speech;
    return this.config.concurrency.image ?? CONCURRENCY_DEFAULTS.image;
  }

  private timeoutOf(modality: string): number {
    const t = this.config.timeouts ?? {};
    if (modality === 'video') return t.video ?? TIMEOUT_DEFAULTS.video;
    if (modality === 'speech') return t.speech ?? TIMEOUT_DEFAULTS.speech;
    return t.image ?? TIMEOUT_DEFAULTS.image;
  }

  private async drain(): Promise<void> {
    if (this.closed) return;
    this.running++; // drain 自身占槽，确保 idle() 不会在调度完成前返回
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
      this.running++;
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
      this.settleBudget(id, undefined);
      this.finishSlot();
      return;
    }
    const req: GenerateRequest = JSON.parse(task.requestJson);
    const ctl = { cancel: false };
    this.inflight.set(id, ctl);
    const deadline = Date.now() + this.timeoutOf(task.modality);

    try {
      await this.transition(id, 'submitted');
      const ticket = await withTimeout(provider.submit(req), Math.max(5000, deadline - Date.now()), 'submit');
      await this.store.updateTask(id, { ticketJson: JSON.stringify(ticket) });

      let progress = { status: 'running' as const, percent: 0 } as import('./protocol.js').TaskProgress;
      await this.transition(id, 'running', { percent: 0 });

      if (provider.poll) {
        // 自适应轮询：间隔指数递增 + 抖动，长任务大幅减少无效请求
        let attempt = 0;
        for (;;) {
          if (ctl.cancel) break;
          if (Date.now() > deadline) {
            progress = { status: 'failed', error: `任务总超时（>${this.timeoutOf(task.modality)}ms）` };
            break;
          }
          const base = this.config.pollIntervalMs * 2 ** Math.min(attempt, 5);
          const max = this.config.pollMaxIntervalMs ?? 30_000;
          const interval = Math.min(base, max) * (0.8 + Math.random() * 0.4);
          await sleep(Math.min(interval, Math.max(50, deadline - Date.now())));
          attempt++;
          progress = await withTimeout(provider.poll(ticket), 30_000, 'poll');
          await this.store.updateTask(id, { percent: progress.percent ?? undefined, error: progress.error });
          if (progress.status !== 'running') break;
        }
      }

      if (ctl.cancel) {
        if (provider.cancel) await provider.cancel(ticket).catch(() => {});
        await this.transition(id, 'canceled', { error: '用户取消' });
        this.settleBudget(id, undefined);
        return;
      }
      if (progress.status === 'failed') {
        // 轮询侧失败：按可重试错误进入统一失败处理
        throw new MediaError(progress.error ?? '提供方返回失败', true);
      }
      if (progress.status === 'canceled') {
        await this.transition(id, 'canceled');
        this.settleBudget(id, undefined);
        return;
      }

      const arts = await withTimeout(provider.fetch(ticket), Math.max(5000, deadline - Date.now()), 'fetch');
      for (const art of arts) {
        const saved = await this.sink.save(id, art);
        await this.store.insertArtifact({
          id: randomUUID(), taskId: id, kind: art.kind, path: saved.path,
          mime: art.mime, bytes: saved.bytes, hash: saved.hash,
          metaJson: art.meta ? JSON.stringify(art.meta) : undefined, createdAt: Date.now()
        });
        this.emit({ type: 'artifact:created', taskId: id, path: saved.path });
      }

      // 结算：提供方回传真实计费量优先，其次按单价表预估
      const estQty = quantityOf(task.modality, req.params, req.modality === 'speech' ? (req.prompt?.length ?? 0) : 0);
      const usageQty = progress.cost?.quantity;
      const actualCny = progress.cost && progress.cost.cny > 0
        ? progress.cost.cny
        : this.pricing.estimate({ provider: provider.id, modality: task.modality, quantity: usageQty ?? estQty });
      await this.store.updateTask(id, { costCny: round4(actualCny) });
      this.settleBudget(id, actualCny);
      await this.transition(id, 'succeeded', { percent: 100, costCny: round4(actualCny) });
    } catch (e) {
      const err = asMediaError(e);
      const cur = (await this.store.getTask(id))!;
      if (err.retryable && cur.retries < this.config.maxRetries) {
        // 可重试：指数退避后回 pending
        const delay = 1000 * 2 ** cur.retries;
        await this.store.updateTask(id, { retries: cur.retries + 1, error: err.message });
        setTimeout(() => {
          void this.transition(id, 'failed', { error: err.message }).then(async () => {
            await this.transition(id, 'pending');
            void this.drain();
          });
        }, delay);
      } else {
        // 不可重试错误（参数/鉴权/能力缺失）立即失败，不烧重试
        await this.transition(id, 'failed', { error: err.message });
        this.settleBudget(id, undefined);
      }
    } finally {
      this.inflight.delete(id);
      this.finishSlot();
    }
  }

  /** 成功 → settle（实际成本已记入任务行）；失败/取消/拒绝 → release 预扣 */
  private settleBudget(taskId: string, actualCny: number | undefined): void {
    const rid = this.reservations.get(taskId);
    if (rid === undefined) return;
    this.reservations.delete(taskId);
    if (actualCny !== undefined) this.budget.settle(rid, actualCny);
    else this.budget.release(rid);
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
      this.settleBudget(id, undefined);
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
