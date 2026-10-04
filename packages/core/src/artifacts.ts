import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Artifact } from './protocol.js';

export interface ArtifactManagerConfig {
  /** 相对工作区的产物输出目录 */
  outputDir: string;
  /** 工作区根目录；缺省用 process.cwd() */
  workspaceDir?: string;
  /** 会话事件注入回调（由 dsh 会话插件桥接，core 不直接依赖 dsh 内部 API） */
  onSessionEvent?: (event: { taskId: string; path: string; mime: string; kind: string }) => void;
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

/** 产物落盘：统一写入 <workspace>/<outputDir>/<taskId 前 8 位>-<短哈希>.<ext>，并向会话事件流注入元数据。 */
export class ArtifactManager {
  constructor(private config: ArtifactManagerConfig) {}

  private dir(): string {
    return join(this.config.workspaceDir ?? process.cwd(), this.config.outputDir);
  }

  async save(
    taskId: string,
    art: Artifact
  ): Promise<{ path: string; bytes: number }> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true });

    let data: Uint8Array;
    if (typeof art.data === 'string') {
      data = await readFile(art.data);
    } else {
      data = art.data;
    }

    const ext = art.filename ? extname(art.filename) : MIME_EXT[art.mime] ?? guessExt(art.kind);
    const short = createHash('sha1').update(data).digest('hex').slice(0, 10);
    const name = art.filename ?? `${taskId.slice(0, 8)}-${short}${ext}`;
    const path = join(dir, name);
    await writeFile(path, data);

    this.config.onSessionEvent?.({ taskId, path, mime: art.mime, kind: art.kind });
    return { path, bytes: data.byteLength };
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
