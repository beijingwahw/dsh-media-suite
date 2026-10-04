/**
 * dsh-media-core 统一生成协议。
 * Provider 适配器插件实现 MediaProvider 接口，
 * 通过 Cordis 事件 `media/provider:register` 热插拔注册。
 */

export type Modality = 'image' | 'image-edit' | 'speech' | 'video';

export type TaskStatus =
  | 'pending'
  | 'submitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'rejected';

export interface GenerateRequest {
  /** core 分配的任务 id */
  id: string;
  modality: Modality;
  /** 生成提示词（speech 模态下为待合成文本） */
  prompt?: string;
  /** 参考图：本地路径或 URL（image-edit / 图生视频必填） */
  refImage?: string;
  /** 蒙版：本地路径或 URL（局部重绘可选） */
  mask?: string;
  /** 模态相关参数：size/n/voice/format/duration 等 */
  params: Record<string, unknown>;
  /** 用户显式指定的 provider id，缺省走路由策略 */
  providerHint?: string;
  sessionId?: string;
  workspaceDir?: string;
}

export interface ProviderTicket {
  provider: string;
  /** 提供方侧任务句柄：异步 task_id 或同步资源 URL */
  handle: string;
  meta?: Record<string, unknown>;
}

export interface CostInfo {
  amount: number;
  currency: string;
  /** 折算人民币，用于统一预算控制 */
  cny: number;
}

export interface TaskProgress {
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  percent?: number;
  error?: string;
  cost?: CostInfo;
}

export interface Artifact {
  kind: Modality;
  mime: string;
  /** 二进制内容，或已存在的本地文件路径（string） */
  data: Uint8Array | string;
  filename?: string;
  meta?: Record<string, unknown>;
}

export interface MediaProvider {
  id: string;
  capabilities: Modality[];
  /** 提交生成请求；同步类 provider 可直接返回可 fetch 的 ticket */
  submit(req: GenerateRequest): Promise<ProviderTicket>;
  /** 异步任务轮询；不提供则视为 submit+fetch 即完成 */
  poll?(ticket: ProviderTicket): Promise<TaskProgress>;
  /** 拉取产物 */
  fetch(ticket: ProviderTicket): Promise<Artifact[]>;
  cancel?(ticket: ProviderTicket): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export interface TaskRecord {
  id: string;
  modality: Modality;
  provider: string;
  status: TaskStatus;
  requestJson: string;
  ticketJson?: string;
  error?: string;
  percent?: number;
  costCny?: number;
  retries: number;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  kind: Modality;
  path: string;
  mime: string;
  bytes: number;
  metaJson?: string;
  createdAt: number;
}

/** 合法状态迁移表：状态机唯一事实来源 */
export const STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['submitted', 'rejected', 'canceled'],
  submitted: ['running', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: ['pending'], // 重试：回到 pending 重新入队
  canceled: [],
  rejected: []
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}
