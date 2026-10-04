import type { ArtifactRecord, TaskRecord, TaskStatus } from './protocol.js';

/** 任务/产物持久化接口。SQLite 为默认实现，内存实现用于测试与降级。 */
export interface TaskStore {
  init(): Promise<void>;
  insertTask(rec: TaskRecord): Promise<void>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<void>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  listTasks(filter?: { status?: TaskStatus; sessionId?: string; limit?: number }): Promise<TaskRecord[]>;
  /** 崩溃恢复：把中断的 submitted/running 任务重置为 pending */
  requeueInterrupted(): Promise<number>;
  insertArtifact(rec: ArtifactRecord): Promise<void>;
  listArtifacts(taskId?: string): Promise<ArtifactRecord[]>;
  sumCostSince(ts: number): Promise<number>;
  close(): Promise<void>;
}

export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private artifacts: ArtifactRecord[] = [];

  async init(): Promise<void> {}

  async insertTask(rec: TaskRecord): Promise<void> {
    this.tasks.set(rec.id, { ...rec });
  }

  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void> {
    const cur = this.tasks.get(id);
    if (!cur) return;
    this.tasks.set(id, { ...cur, ...patch, updatedAt: Date.now() });
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  async listTasks(filter?: { status?: TaskStatus; sessionId?: string; limit?: number }): Promise<TaskRecord[]> {
    let out = [...this.tasks.values()];
    if (filter?.status) out = out.filter((t) => t.status === filter.status);
    if (filter?.sessionId) out = out.filter((t) => t.sessionId === filter.sessionId);
    out.sort((a, b) => b.createdAt - a.createdAt);
    if (filter?.limit) out = out.slice(0, filter.limit);
    return out.map((t) => ({ ...t }));
  }

  async requeueInterrupted(): Promise<number> {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'submitted' || t.status === 'running') {
        t.status = 'pending';
        t.updatedAt = Date.now();
        n++;
      }
    }
    return n;
  }

  async insertArtifact(rec: ArtifactRecord): Promise<void> {
    this.artifacts.push({ ...rec });
  }

  async listArtifacts(taskId?: string): Promise<ArtifactRecord[]> {
    const out = taskId ? this.artifacts.filter((a) => a.taskId === taskId) : this.artifacts;
    return out.map((a) => ({ ...a }));
  }

  async sumCostSince(ts: number): Promise<number> {
    return this.tasks.values
      ? [...this.tasks.values()]
          .filter((t) => t.createdAt >= ts && typeof t.costCny === 'number')
          .reduce((s, t) => s + (t.costCny ?? 0), 0)
      : 0;
  }

  async close(): Promise<void> {}
}

/** SQLite 实现（better-sqlite3）。数据库文件默认放在 $DSH_HOME/media.db */
export class SqliteTaskStore implements TaskStore {
  private db: import('better-sqlite3').Database | undefined;

  constructor(private file: string) {}

  async init(): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        modality TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        ticket_json TEXT,
        error TEXT,
        percent INTEGER,
        cost_cny REAL,
        retries INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
    `);
  }

  private get d(): import('better-sqlite3').Database {
    if (!this.db) throw new Error('SqliteTaskStore not initialized');
    return this.db;
  }

  async insertTask(rec: TaskRecord): Promise<void> {
    this.d
      .prepare(
        `INSERT INTO tasks (id, modality, provider, status, request_json, ticket_json, error, percent, cost_cny, retries, session_id, created_at, updated_at)
         VALUES (@id, @modality, @provider, @status, @requestJson, @ticketJson, @error, @percent, @costCny, @retries, @sessionId, @createdAt, @updatedAt)`
      )
      .run({ ...rec, ticketJson: rec.ticketJson ?? null, error: rec.error ?? null, percent: rec.percent ?? null, costCny: rec.costCny ?? null, sessionId: rec.sessionId ?? null });
  }

  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void> {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: Date.now() };
    const map: Record<string, string> = {
      status: 'status', provider: 'provider', ticketJson: 'ticket_json', error: 'error',
      percent: 'percent', costCny: 'cost_cny', retries: 'retries'
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        fields.push(`${col} = @${k}`);
        params[k] = (patch as Record<string, unknown>)[k] ?? null;
      }
    }
    fields.push('updated_at = @updatedAt');
    this.d.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }

  private rowToTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: row.id as string,
      modality: row.modality as TaskRecord['modality'],
      provider: row.provider as string,
      status: row.status as TaskRecord['status'],
      requestJson: row.request_json as string,
      ticketJson: (row.ticket_json as string) ?? undefined,
      error: (row.error as string) ?? undefined,
      percent: (row.percent as number) ?? undefined,
      costCny: (row.cost_cny as number) ?? undefined,
      retries: row.retries as number,
      sessionId: (row.session_id as string) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    };
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    const row = this.d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : undefined;
  }

  async listTasks(filter?: { status?: TaskStatus; sessionId?: string; limit?: number }): Promise<TaskRecord[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.status) { where.push('status = @status'); params.status = filter.status; }
    if (filter?.sessionId) { where.push('session_id = @sessionId'); params.sessionId = filter.sessionId; }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT @limit`;
    params.limit = filter?.limit ?? 100;
    return (this.d.prepare(sql).all(params) as Record<string, unknown>[]).map((r) => this.rowToTask(r));
  }

  async requeueInterrupted(): Promise<number> {
    const info = this.d
      .prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE status IN ('submitted','running')`)
      .run(Date.now());
    return info.changes;
  }

  async insertArtifact(rec: ArtifactRecord): Promise<void> {
    this.d
      .prepare(
        `INSERT INTO artifacts (id, task_id, kind, path, mime, bytes, meta_json, created_at)
         VALUES (@id, @taskId, @kind, @path, @mime, @bytes, @metaJson, @createdAt)`
      )
      .run({ ...rec, metaJson: rec.metaJson ?? null });
  }

  async listArtifacts(taskId?: string): Promise<ArtifactRecord[]> {
    const rows = taskId
      ? (this.d.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at').all(taskId) as Record<string, unknown>[])
      : (this.d.prepare('SELECT * FROM artifacts ORDER BY created_at').all() as Record<string, unknown>[]);
    return rows.map((r) => ({
      id: r.id as string, taskId: r.task_id as string, kind: r.kind as ArtifactRecord['kind'],
      path: r.path as string, mime: r.mime as string, bytes: r.bytes as number,
      metaJson: (r.meta_json as string) ?? undefined, createdAt: r.created_at as number
    }));
  }

  async sumCostSince(ts: number): Promise<number> {
    const row = this.d.prepare('SELECT COALESCE(SUM(cost_cny), 0) AS s FROM tasks WHERE created_at >= ?').get(ts) as { s: number };
    return row.s;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
