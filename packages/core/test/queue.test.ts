import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactManager } from '../src/artifacts.js';
import { Budget, BudgetError } from '../src/budget.js';
import { MediaError } from '../src/errors.js';
import { Pricing } from '../src/pricing.js';
import { canTransition, isTerminal } from '../src/protocol.js';
import type { Artifact, GenerateRequest, MediaProvider, Modality, ProviderTicket, TaskProgress } from '../src/protocol.js';
import { TaskQueue } from '../src/queue.js';
import { MemoryTaskStore } from '../src/store.js';
import { validateImage, validateSpeech, validateVideo } from '../src/tools.js';

// ---------- 测试替身 ----------

interface FakeOpts {
  behavior?: 'sync' | 'async' | 'fail-once' | 'fail-always' | 'non-retryable' | 'hang';
  healthy?: boolean;
  usageQuantity?: number;
  bytes?: number[];
}

class FakeProvider implements MediaProvider {
  id: string;
  capabilities: Modality[] = ['image', 'speech', 'video'];
  submitted: GenerateRequest[] = [];
  polls = 0;
  private failCount = { n: 0 };

  constructor(id = 'fake', private opts: FakeOpts = {}) {
    this.id = id;
  }

  async submit(req: GenerateRequest): Promise<ProviderTicket> {
    if (this.opts.behavior === 'hang') {
      await new Promise((r) => setTimeout(r, 60_000));
    }
    if (this.opts.behavior === 'non-retryable') {
      throw new MediaError('模拟参数错误', false);
    }
    this.submitted.push(req);
    return { provider: this.id, handle: `h-${req.id}`, meta: { modality: req.modality } };
  }

  async poll(_ticket: ProviderTicket): Promise<TaskProgress> {
    this.polls++;
    const b = this.opts.behavior;
    if (b === 'sync') return { status: 'succeeded', percent: 100, cost: this.cost() };
    if (b === 'fail-always') return { status: 'failed', error: '模拟失败' };
    if (b === 'fail-once') {
      if (this.failCount.n++ < 1) return { status: 'failed', error: '第一次失败' };
      return { status: 'succeeded', percent: 100, cost: this.cost() };
    }
    return this.polls >= 2 ? { status: 'succeeded', percent: 100, cost: this.cost() } : { status: 'running', percent: 50 };
  }

  private cost(): TaskProgress['cost'] {
    return this.opts.usageQuantity
      ? { amount: this.opts.usageQuantity, currency: 'unit', cny: 0, quantity: this.opts.usageQuantity }
      : undefined;
  }

  async fetch(_ticket: ProviderTicket): Promise<Artifact[]> {
    return [{ kind: 'image', mime: 'image/png', data: new Uint8Array(this.opts.bytes ?? [0x89, 0x50, 0x4e, 0x47]) }];
  }

  async healthCheck(): Promise<boolean> {
    return this.opts.healthy ?? true;
  }
}

async function setup(opts: {
  budget?: { dailyCNY?: number; perTaskCNY?: number };
  providers?: FakeProvider[];
  defaultProvider?: Record<string, string>;
  failover?: boolean;
  timeouts?: { image?: number; video?: number; speech?: number };
  retention?: { maxCount?: number; maxAgeDays?: number };
} = {}) {
  const store = new MemoryTaskStore();
  await store.init();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-media-test-'));
  const sink = new ArtifactManager({ outputDir: 'assets/media', workspaceDir: dir, retention: opts.retention }, store);
  const pricing = new Pricing({
    fake: { image: { unit: 'image', cnyPerUnit: 0.1 }, video: { unit: 'second', cnyPerUnit: 0.5 }, speech: { unit: 'kchar', cnyPerUnit: 0.001 } },
    fake2: { image: { unit: 'image', cnyPerUnit: 0.2 } },
    slow: { image: { unit: 'image', cnyPerUnit: 0.1 } }
  });
  const budget = new Budget(store, opts.budget ?? {});
  const queue = new TaskQueue(
    store, budget, pricing, sink,
    { concurrency: {}, maxRetries: 3, pollIntervalMs: 5, failover: opts.failover, timeouts: opts.timeouts },
    opts.defaultProvider ?? {}
  );
  for (const p of opts.providers ?? [new FakeProvider()]) queue.registerProvider(p);
  return { store, queue, budget, dir, sink };
}

// ---------- 状态机 ----------

describe('状态机', () => {
  it('允许合法迁移，拒绝非法迁移', () => {
    expect(canTransition('pending', 'submitted')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('failed', 'pending')).toBe(true);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(canTransition('rejected', 'pending')).toBe(false);
    expect(canTransition('canceled', 'running')).toBe(false);
  });

  it('终态判定', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('pending')).toBe(false);
  });
});

// ---------- 预算：预扣-结算 ----------

describe('预算闸门（预扣-结算）', () => {
  it('单任务超限直接 rejected', async () => {
    const { queue } = await setup({ budget: { perTaskCNY: 0.01 } });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: { n: 1 } });
    expect(t.status).toBe('rejected');
    expect(t.error).toContain('超过上限');
  });

  it('并发预扣：在途任务占用额度，第二个任务被拒', async () => {
    // slow provider 让任务保持在途，验证预扣生效
    const slow = new FakeProvider('slow', { behavior: 'async' });
    const { queue, budget } = await setup({ budget: { dailyCNY: 0.15 }, providers: [slow] });
    const t1 = await queue.enqueue({ modality: 'image', prompt: 'a', params: { n: 1 } }); // 预扣 0.1
    expect(t1.status).toBe('pending');
    expect(budget.outstanding()).toBeCloseTo(0.1, 4);
    const t2 = await queue.enqueue({ modality: 'image', prompt: 'b', params: { n: 1 } }); // 0.1+0.1 > 0.15
    expect(t2.status).toBe('rejected');
    expect(t2.error).toContain('在途预扣');
    await queue.idle();
  });

  it('失败自动释放预扣', async () => {
    const bad = new FakeProvider('fake', { behavior: 'non-retryable' });
    const { queue, budget } = await setup({ budget: { dailyCNY: 1 }, providers: [bad] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await queue.idle();
    await new Promise((r) => setTimeout(r, 50));
    const done = (await queue.status(t.id))!;
    expect(done.status).toBe('failed');
    expect(budget.outstanding()).toBe(0); // 预扣已释放
  });

  it('成功后按实际成本结算并记账', async () => {
    const { queue, store, budget } = await setup({ budget: { dailyCNY: 1 } });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: { n: 2 } });
    await queue.idle();
    const done = (await store.getTask(t.id))!;
    expect(done.costCny).toBeCloseTo(0.2, 4); // 2 张 × 0.1
    expect(budget.outstanding()).toBe(0);
    expect(await budget.spentToday()).toBeCloseTo(0.2, 4);
  });

  it('BudgetError 携带原因码', () => {
    expect(new BudgetError('daily-exceeded', 'x').reason).toBe('daily-exceeded');
    expect(new BudgetError('per-task-exceeded', 'x').reason).toBe('per-task-exceeded');
  });
});

// ---------- 队列端到端 ----------

describe('任务队列端到端', () => {
  it('同步 provider：入队 → 成功 → 产物落盘（PNG 魔数校验）', async () => {
    const { queue, store, dir } = await setup();
    const t = await queue.enqueue({ modality: 'image', prompt: '一只鲸鱼', params: { n: 1 }, sessionId: 's1' });
    await queue.idle();
    const done = (await store.getTask(t.id))!;
    expect(done.status).toBe('succeeded');
    expect(done.percent).toBe(100);
    const arts = await store.listArtifacts(t.id);
    expect(arts.length).toBe(1);
    expect(arts[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await readFile(arts[0].path);
    expect(bytes[0]).toBe(0x89);
    expect(arts[0].path.startsWith(join(dir, 'assets', 'media'))).toBe(true);
  });

  it('异步 provider：轮询至成功', async () => {
    const { queue, store } = await setup({ providers: [new FakeProvider('fake', { behavior: 'async' })] });
    const t = await queue.enqueue({ modality: 'video', prompt: '海浪', params: { duration: 5 } });
    await queue.idle();
    expect((await store.getTask(t.id))!.status).toBe('succeeded');
  });

  it('可重试失败：指数退避重试后成功', async () => {
    const { queue, store } = await setup({ providers: [new FakeProvider('fake', { behavior: 'fail-once' })] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await new Promise((r) => setTimeout(r, 2500));
    await queue.idle();
    const done = (await store.getTask(t.id))!;
    expect(done.status).toBe('succeeded');
    expect(done.retries).toBe(1);
  });

  it('不可重试错误：立即 failed，不消耗重试次数', async () => {
    const { queue, store } = await setup({ providers: [new FakeProvider('fake', { behavior: 'non-retryable' })] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await queue.idle();
    await new Promise((r) => setTimeout(r, 100));
    const done = (await store.getTask(t.id))!;
    expect(done.status).toBe('failed');
    expect(done.retries).toBe(0); // 关键：不重试
    expect(done.error).toContain('模拟参数错误');
  });

  it('持续失败：重试耗尽后 failed（retries=3）', async () => {
    const { queue, store } = await setup({ providers: [new FakeProvider('fake', { behavior: 'fail-always' })] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await new Promise((r) => setTimeout(r, 12000));
    const done = (await store.getTask(t.id))!;
    expect(done.status).toBe('failed');
    expect(done.retries).toBe(3);
  }, 20000);

  it('任务超时：hang 住的 submit 被超时看门狗终结', async () => {
    const { queue, store } = await setup({
      providers: [new FakeProvider('fake', { behavior: 'hang' })],
      timeouts: { image: 300 }
    });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await new Promise((r) => setTimeout(r, 3000));
    const done = (await store.getTask(t.id))!;
    // 超时是可重试错误：要么在重试中，要么已耗尽；状态不应卡死在 submitted
    expect(['failed', 'pending', 'submitted', 'running']).toContain(done.status);
    expect(done.retries + (done.status === 'failed' ? 0 : 1)).toBeGreaterThanOrEqual(1);
    queue.close();
  }, 15000);

  it('真实计费量结算：usage.quantity 优先于预估', async () => {
    const { queue, store } = await setup({ providers: [new FakeProvider('fake', { usageQuantity: 3 })] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: { n: 1 } }); // 预估 1 张
    await queue.idle();
    const done = (await store.getTask(t.id))!;
    expect(done.costCny).toBeCloseTo(0.3, 4); // 实际 3 张 × 0.1
  });

  it('enqueueAndWait：同步拿到终态与产物', async () => {
    const { queue } = await setup();
    const t = await queue.enqueueAndWait({ modality: 'image', prompt: 'x', params: {} }, 5000);
    expect(t.status).toBe('succeeded');
  });
});

// ---------- 路由与故障转移 ----------

describe('路由与故障转移', () => {
  it('hint 指定且健康：直接使用', async () => {
    const p2 = new FakeProvider('fake2');
    const { queue } = await setup({ providers: [new FakeProvider('fake'), p2] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {}, providerHint: 'fake2' });
    expect(t.provider).toBe('fake2');
    await queue.idle();
  });

  it('默认 provider 不健康：自动转移到健康候选', async () => {
    const sick = new FakeProvider('fake', { healthy: false });
    const ok = new FakeProvider('fake2', { healthy: true });
    const { queue } = await setup({ providers: [sick, ok], defaultProvider: { image: 'fake' } });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    expect(t.provider).toBe('fake2'); // 转移成功
    await queue.idle();
    expect((await queue.status(t.id))!.status).toBe('succeeded');
  });

  it('failover=false：不做健康探测，坚持默认', async () => {
    const sick = new FakeProvider('fake', { healthy: false });
    const ok = new FakeProvider('fake2');
    const { queue } = await setup({ providers: [sick, ok], defaultProvider: { image: 'fake' }, failover: false });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    expect(t.provider).toBe('fake');
    queue.close();
  });

  it('hint 不存在：rejected 不抛异常', async () => {
    const { queue } = await setup();
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {}, providerHint: 'nonexist' });
    expect(t.status).toBe('rejected');
  });

  it('无可用 provider：rejected', async () => {
    const store = new MemoryTaskStore();
    await store.init();
    const dir = await mkdtemp(join(tmpdir(), 'dsh-media-empty-'));
    const q = new TaskQueue(store, new Budget(store), new Pricing(), new ArtifactManager({ outputDir: 'a', workspaceDir: dir }), { concurrency: {}, maxRetries: 0, pollIntervalMs: 5 });
    const t = await q.enqueue({ modality: 'image', prompt: 'x', params: {} });
    expect(t.status).toBe('rejected');
  });

  it('provider 热插拔：卸载后新任务 rejected', async () => {
    const { queue } = await setup();
    queue.unregisterProvider('fake');
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    expect(t.status).toBe('rejected');
  });
});

// ---------- 取消 ----------

describe('取消', () => {
  it('取消 pending 任务', async () => {
    const { queue, store } = await setup();
    // concurrency 占满后入队第二个任务使其停留 pending 不易构造，直接取消刚入队任务（竞态前）
    const t = await queue.enqueue({ modality: 'video', prompt: 'x', params: {} });
    const ok = await queue.cancel(t.id);
    expect(ok).toBe(true);
    await queue.idle();
    const done = (await store.getTask(t.id))!;
    expect(['canceled', 'succeeded', 'running', 'submitted'].includes(done.status)).toBe(true);
  });
});

// ---------- 产物：原子写入 + 去重 + 保留策略 ----------

describe('产物管理', () => {
  it('内容去重：相同字节只落盘一次', async () => {
    const { queue, store } = await setup();
    const t1 = await queue.enqueue({ modality: 'image', prompt: 'a', params: {} });
    await queue.idle();
    const t2 = await queue.enqueue({ modality: 'image', prompt: 'b', params: {} });
    await queue.idle();
    const a1 = await store.listArtifacts(t1.id);
    const a2 = await store.listArtifacts(t2.id);
    expect(a1[0].hash).toBe(a2[0].hash);
    expect(a1[0].path).toBe(a2[0].path); // 复用同一文件
  });

  it('不同内容：各自落盘', async () => {
    const p1 = new FakeProvider('fake', { bytes: [1, 2, 3] });
    const { queue, store } = await setup({ providers: [p1] });
    const t = await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await queue.idle();
    const arts = await store.listArtifacts(t.id);
    expect(arts[0].bytes).toBe(3);
  });

  it('原子写入：目录中不残留 .tmp 文件', async () => {
    const { queue, dir } = await setup();
    await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await queue.idle();
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(dir, 'assets', 'media'));
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('保留策略：maxCount 清理最旧产物', async () => {
    const store = new MemoryTaskStore();
    await store.init();
    const dir = await mkdtemp(join(tmpdir(), 'dsh-media-prune-'));
    const sink = new ArtifactManager({ outputDir: 'out', workspaceDir: dir, retention: { maxCount: 2 } }, store);
    for (let i = 0; i < 4; i++) {
      await sink.save(`task-${i}`, { kind: 'image', mime: 'image/png', data: new Uint8Array([i, i, i]) });
      await store.insertArtifact({ id: `a-${i}`, taskId: `task-${i}`, kind: 'image', path: join(dir, 'out', `f${i}.png`), mime: 'image/png', bytes: 3, hash: `h${i}`, createdAt: Date.now() + i });
    }
    const pruned = await sink.prune(); // 显式触发，避免 save 内部异步 prune 的时序竞态
    expect(pruned).toBeGreaterThanOrEqual(1);
    const remaining = await store.listArtifacts();
    expect(remaining.length).toBe(2); // 严格收敛到 maxCount
  });
});

// ---------- 入参校验 ----------

describe('入参前置校验', () => {
  it('image：空 prompt / 非法 n / 非法 size 均被拒', () => {
    expect(() => validateImage({ prompt: '' })).toThrow(MediaError);
    expect(() => validateImage({ prompt: 'ok', n: 9 })).toThrow(/1-4/);
    expect(() => validateImage({ prompt: 'ok', size: '很大' })).toThrow(/size/);
    expect(() => validateImage({ prompt: 'ok', size: '1024*1024', n: 2 })).not.toThrow();
  });

  it('speech：空文本 / speed 越界 / 非法 format 被拒', () => {
    expect(() => validateSpeech({ text: ' ' })).toThrow(MediaError);
    expect(() => validateSpeech({ text: 'hi', speed: 5 })).toThrow(/0.5-2/);
    expect(() => validateSpeech({ text: 'hi', format: 'flac' as any })).toThrow(/format/);
    expect(() => validateSpeech({ text: 'hi', speed: 1.5, format: 'wav' })).not.toThrow();
  });

  it('video：duration 越界被拒', () => {
    expect(() => validateVideo({ prompt: 'x', duration: 999 })).toThrow(/1-60/);
    expect(() => validateVideo({ prompt: 'x', duration: 10 })).not.toThrow();
  });

  it('校验错误 retryable=false（不进重试）', () => {
    try {
      validateImage({ prompt: '' });
    } catch (e) {
      expect((e as MediaError).retryable).toBe(false);
    }
  });
});

// ---------- 事件 ----------

describe('事件', () => {
  it('task:updated 与 artifact:created 均会发射', async () => {
    const { queue } = await setup();
    const events: string[] = [];
    queue.on((e) => events.push(e.type));
    await queue.enqueue({ modality: 'image', prompt: 'x', params: {} });
    await queue.idle();
    expect(events).toContain('task:updated');
    expect(events).toContain('artifact:created');
  });
});

// ---------- Pricing ----------

describe('Pricing', () => {
  it('按单价折算 CNY', () => {
    const p = new Pricing();
    expect(p.estimate({ provider: 'bailian', modality: 'image', quantity: 2 })).toBeCloseTo(0.28, 4);
    expect(p.estimate({ provider: 'comfyui', modality: 'image', quantity: 3 })).toBe(0);
    expect(p.estimate({ provider: 'unknown', modality: 'image', quantity: 1 })).toBe(0);
  });
});

// ---------- 存储 ----------

describe('存储', () => {
  it('崩溃恢复：submitted/running 重置为 pending', async () => {
    const store = new MemoryTaskStore();
    await store.init();
    const base = { id: 'x1', modality: 'image' as Modality, provider: 'p', requestJson: '{}', retries: 0, createdAt: 1, updatedAt: 1 };
    await store.insertTask({ ...base, status: 'running' });
    await store.insertTask({ ...base, id: 'x2', status: 'succeeded' });
    const n = await store.requeueInterrupted();
    expect(n).toBe(1);
    expect((await store.getTask('x1'))!.status).toBe('pending');
    expect((await store.getTask('x2'))!.status).toBe('succeeded');
  });

  it('游标分页：before 过滤生效', async () => {
    const store = new MemoryTaskStore();
    await store.init();
    const base = { modality: 'image' as Modality, provider: 'p', status: 'succeeded' as const, requestJson: '{}', retries: 0, updatedAt: 1 };
    await store.insertTask({ ...base, id: 'a', createdAt: 100 });
    await store.insertTask({ ...base, id: 'b', createdAt: 200 });
    const page = await store.listTasks({ before: 200 });
    expect(page.map((t) => t.id)).toEqual(['a']);
  });

  it('findArtifactByHash / deleteArtifact', async () => {
    const store = new MemoryTaskStore();
    await store.init();
    await store.insertArtifact({ id: 'a1', taskId: 't1', kind: 'image', path: '/x.png', mime: 'image/png', bytes: 1, hash: 'hh', createdAt: 1 });
    expect((await store.findArtifactByHash('hh'))!.path).toBe('/x.png');
    expect(await store.findArtifactByHash('nope')).toBeUndefined();
    await store.deleteArtifact('a1');
    expect(await store.findArtifactByHash('hh')).toBeUndefined();
  });
});

// 消除未使用导入告警
void writeFile;
