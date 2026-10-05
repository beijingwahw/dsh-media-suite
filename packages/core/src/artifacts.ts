import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Artifact } from './protocol.js';
import type { TaskStore } from './store.js';

export interface RetentionPolicy {
  /** 最多保留产物数量，超出按时间清理最旧（缺省不限） */
  maxCount?: number;
  /** 保留天数，超期清理（缺省不限） */
  maxAgeDays?: number;
}

export interface ArtifactManagerConfig {
  /** 相对工作区的产物输出目录 */
  outputDir: string;
  /** 工作区根目录；缺省用 process.cwd() */
  workspaceDir?: string;
  /** 会话事件注入回调（由 dsh 会话插件桥接，core 不直接依赖 dsh 内部 API） */
  onSessionEvent?: (event: { taskId: string; path: string; mime: string; kind: string; deduped: boolean }) => void;
  /** 保留策略（默认关闭） */
  retention?: RetentionPolicy;
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/opus': '.opus',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
};

/**
 * 产物落盘：
 *  - 原子写入（临时文件 + rename），杜绝半截文件
 *  - SHA-256 内容去重：相同内容直接复用已有文件，不重复写盘
 *  - 文件名冲突（同名不同内容）自动加哈希后缀
 *  - 可选保留策略：按数量/天数清理旧产物
 *  - 元数据经 onSessionEvent 写入会话事件流（轨迹可回放）
 */
export class ArtifactManager {
  constructor(private config: ArtifactManagerConfig, private store?: TaskStore) {}

  private dir(): string {
    return join(this.config.workspaceDir ?? process.cwd(), this.config.outputDir);
  }

  async save(
    taskId: string,
    art: Artifact
  ): Promise<{ path: string; bytes: number; hash: string; deduped: boolean }> {
    const data = typeof art.data === 'string' ? await readFile(art.data) : art.data;
    const hash = createHash('sha256').update(data).digest('hex');

    // 内容去重：同哈希产物已存在则直接复用
    if (this.store) {
      const existing = await this.store.findArtifactByHash(hash);
      if (existing) {
        this.config.onSessionEvent?.({ taskId, path: existing.path, mime: art.mime, kind: art.kind, deduped: true });
        return { path: existing.path, bytes: existing.bytes, hash, deduped: true };
      }
    }

    const dir = this.dir();
    await mkdir(dir, { recursive: true });

    const ext = art.filename ? extname(art.filename) : MIME_EXT[art.mime] ?? guessExt(art.kind);
    let name = art.filename ?? `${taskId.slice(0, 8)}-${hash.slice(0, 10)}${ext}`;
    let path = join(dir, name);

    // 同名不同内容：加哈希后缀避免覆盖
    if (this.store) {
      const clash = await this.store.findArtifactByPath(path);
      if (clash && clash.hash !== hash) {
        const base = name.slice(0, name.length - ext.length);
        name = `${base}-${hash.slice(0, 8)}${ext}`;
        path = join(dir, name);
      }
    }

    // 原子写入
    const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(tmp, data);
    await rename(tmp, path);

    this.config.onSessionEvent?.({ taskId, path, mime: art.mime, kind: art.kind, deduped: false });

    if (this.config.retention) {
      void this.prune().catch(() => {});
    }
    return { path, bytes: data.byteLength, hash, deduped: false };
  }

  /** 按保留策略清理旧产物（数量超限或超期），同时删除文件与存储记录 */
  async prune(): Promise<number> {
    if (!this.store || !this.config.retention) return 0;
    const { maxCount, maxAgeDays } = this.config.retention;
    const all = await this.store.listArtifacts();
    const doomed = new Set<string>();

    if (maxCount && all.length > maxCount) {
      const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt);
      for (const a of sorted.slice(0, all.length - maxCount)) doomed.add(a.id);
    }
    if (maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 86400_000;
      for (const a of all) if (a.createdAt < cutoff) doomed.add(a.id);
    }

    let n = 0;
    for (const id of doomed) {
      const rec = all.find((a) => a.id === id);
      if (!rec) continue;
      await unlink(rec.path).catch(() => {});
      await this.store.deleteArtifact(id);
      n++;
    }
    return n;
  }
}

function guessExt(kind: Artifact['kind']): string {
  switch (kind) {
    case 'image':
    case 'image-edit':
      return '.png';
    case 'speech':
      return '.mp3';
    case 'video':
      return '.mp4';
  }
}

export function newId(): string {
  return randomUUID();
}
