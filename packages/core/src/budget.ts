import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.js';

export interface BudgetConfig {
  /** 每日总预算（CNY），0 或缺省表示不限 */
  dailyCNY?: number;
  /** 单任务预算上限（CNY），0 或缺省表示不限 */
  perTaskCNY?: number;
}

export class BudgetError extends Error {
  constructor(public readonly reason: 'daily-exceeded' | 'per-task-exceeded', detail: string) {
    super(detail);
    this.name = 'BudgetError';
  }
}

/**
 * 预算闸门：预扣-结算模型。
 * 入队时按预估成本预扣额度（在途任务占用），成功按实际结算、失败/取消自动释放，
 * 杜绝并发任务同时通过日预算检查导致的超支。
 * 所有额度变更经内部互斥链串行化，避免 check-then-act 竞态。
 */
export class Budget {
  private reservations = new Map<string, number>();
  private lockChain: Promise<unknown> = Promise.resolve();

  constructor(private store: TaskStore, private config: BudgetConfig = {}) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.catch(() => {});
    return run;
  }

  private dayStart(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  async spentToday(): Promise<number> {
    return this.store.sumCostSince(this.dayStart());
  }

  /** 在途预扣总额 */
  outstanding(): number {
    let s = 0;
    for (const v of this.reservations.values()) s += v;
    return s;
  }

  /**
   * 预扣额度。
   * @returns 预扣凭据 id，用于 settle/release
   * @throws BudgetError 超限
   */
  async reserve(estimatedCny: number): Promise<string> {
    return this.withLock(async () => {
      const { dailyCNY, perTaskCNY } = this.config;
      if (perTaskCNY && estimatedCny > perTaskCNY) {
        throw new BudgetError('per-task-exceeded', `单任务预估 ¥${estimatedCny} 超过上限 ¥${perTaskCNY}`);
      }
      if (dailyCNY) {
        const spent = await this.spentToday();
        const need = spent + this.outstanding() + estimatedCny;
        if (need > dailyCNY) {
          throw new BudgetError(
            'daily-exceeded',
            `今日已花费 ¥${spent.toFixed(2)}（在途预扣 ¥${this.outstanding().toFixed(2)}），本任务预估 ¥${estimatedCny}，超过日预算 ¥${dailyCNY}`
          );
        }
      }
      const id = randomUUID();
      this.reservations.set(id, estimatedCny);
      return id;
    });
  }

  /** 结算：释放预扣。实际成本由调用方记入任务行（spentToday 从存储读取）。 */
  settle(reservationId: string | undefined, _actualCny: number): void {
    if (reservationId) this.reservations.delete(reservationId);
  }

  /** 失败/取消：释放预扣，不计成本 */
  release(reservationId: string | undefined): void {
    if (reservationId) this.reservations.delete(reservationId);
  }

  /** 兼容旧接口：一次性校验（不预扣） */
  async check(estimatedCny: number): Promise<void> {
    await this.withLock(async () => {
      const { dailyCNY, perTaskCNY } = this.config;
      if (perTaskCNY && estimatedCny > perTaskCNY) {
        throw new BudgetError('per-task-exceeded', `单任务预估 ¥${estimatedCny} 超过上限 ¥${perTaskCNY}`);
      }
      if (dailyCNY) {
        const spent = await this.spentToday();
        if (spent + this.outstanding() + estimatedCny > dailyCNY) {
          throw new BudgetError('daily-exceeded', `预算不足`);
        }
      }
    });
  }

  async remainingToday(): Promise<number | undefined> {
    if (!this.config.dailyCNY) return undefined;
    return Math.max(0, this.config.dailyCNY - (await this.spentToday()) - this.outstanding());
  }
}
