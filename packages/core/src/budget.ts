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

/** 预算闸门：任务入队前校验，超限直接 rejected，不进队列。 */
export class Budget {
  constructor(private store: TaskStore, private config: BudgetConfig = {}) {}

  private dayStart(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  async spentToday(): Promise<number> {
    return this.store.sumCostSince(this.dayStart());
  }

  /**
   * 校验任务预估成本是否放行。
   * @throws BudgetError 超限时抛出，调用方将任务置为 rejected
   */
  async check(estimatedCny: number): Promise<void> {
    const { dailyCNY, perTaskCNY } = this.config;
    if (perTaskCNY && estimatedCny > perTaskCNY) {
      throw new BudgetError('per-task-exceeded', `单任务预估 ¥${estimatedCny} 超过上限 ¥${perTaskCNY}`);
    }
    if (dailyCNY) {
      const spent = await this.spentToday();
      if (spent + estimatedCny > dailyCNY) {
        throw new BudgetError('daily-exceeded', `今日已花费 ¥${spent.toFixed(2)}，本任务预估 ¥${estimatedCny}，超过日预算 ¥${dailyCNY}`);
      }
    }
  }

  async remainingToday(): Promise<number | undefined> {
    if (!this.config.dailyCNY) return undefined;
    return Math.max(0, this.config.dailyCNY - (await this.spentToday()));
  }
}
