/**
 * dsh-media-ui —— Web UI「媒体生成」面板。
 *
 * dsh UI 挂载点处于 developer preview，本插件按优先级尝试：
 *   1. 宿主 ui 服务：ctx.ui.registerPanel / ctx.registry.ui
 *   2. 事件广播 'media/ui:mount'（由宿主 UI 适配层拾取）
 *   3. 直接挂到 document 右侧浮层（保底，任何 Web UI 下可见）
 *
 * 数据全部来自 Cordis 服务 `media` 与事件总线，UI 无独立状态源。
 */
import type { MediaService, TaskRecord, TaskView } from 'dsh-media-core';

export const name = 'media-ui';

export interface Config {
  panelTitle?: string;
  refreshMs?: number;
}

interface PluginContext {
  on(event: string, handler: (...args: any[]) => any): () => void;
  emit?(event: string, ...args: any[]): void;
  dispose?(fn: () => void): void;
  [key: string]: any;
}

export function Plugin(ctx: PluginContext, config: Config = {}): void {
  const title = config.panelTitle ?? '媒体生成';
  const refreshMs = config.refreshMs ?? 2000;
  const media: MediaService | undefined = ctx.media ?? ctx.registry?.media;

  const panel = new MediaPanel(title, media, refreshMs, ctx);
  const mounted = mountPanel(ctx, panel.root, title);

  const offTask = ctx.on('media/task:updated', (t: TaskRecord) => panel.onTask(t));
  const offArtifact = ctx.on('media/artifact:created', () => panel.refresh());

  const timer = typeof setInterval !== 'undefined' ? setInterval(() => panel.refresh(), refreshMs) : undefined;

  ctx.dispose?.(() => {
    offTask?.();
    offArtifact?.();
    if (timer) clearInterval(timer);
    mounted.unmount?.();
    panel.destroy();
  });
}

function mountPanel(ctx: PluginContext, el: HTMLElement, title: string): { unmount?: () => void } {
  const ui = ctx.ui ?? ctx.registry?.ui;
  if (ui && typeof ui.registerPanel === 'function') {
    const handle = ui.registerPanel({ id: 'media-panel', title, render: () => el });
    return { unmount: () => handle?.dispose?.() ?? ui.unregisterPanel?.('media-panel') };
  }
  ctx.emit?.('media/ui:mount', { id: 'media-panel', title, element: el });
  // 保底：右侧浮层
  if (typeof document !== 'undefined' && !document.getElementById('dsh-media-panel')) {
    el.id = 'dsh-media-panel';
    Object.assign(el.style, {
      position: 'fixed', top: '48px', right: '0', bottom: '0', width: '340px',
      overflowY: 'auto', background: 'var(--dsh-bg, #111)', color: 'var(--dsh-fg, #eee)',
      borderLeft: '1px solid #333', padding: '12px', zIndex: '9000', fontSize: '13px'
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    return { unmount: () => el.remove() };
  }
  return {};
}

class MediaPanel {
  readonly root: HTMLElement;
  private listEl: HTMLElement;
  private budgetEl: HTMLElement;
  private tasks = new Map<string, TaskRecord>();

  constructor(private title: string, private media: MediaService | undefined, private refreshMs: number, private ctx: PluginContext) {
    const doc = typeof document !== 'undefined' ? document : undefined;
    if (!doc) {
      // 无 DOM 环境（headless）：面板退化为 no-op
      this.root = { appendChild() {}, style: {} } as unknown as HTMLElement;
      this.listEl = this.root;
      this.budgetEl = this.root;
      return;
    }
    this.root = doc.createElement('div');
    const h = doc.createElement('h3');
    h.textContent = title;
    this.budgetEl = doc.createElement('div');
    this.listEl = doc.createElement('div');
    this.root.append(h, this.budgetEl, this.listEl);
    void this.refresh();
  }

  onTask(t: TaskRecord): void {
    this.tasks.set(t.id, t);
    this.renderTask(t);
  }

  async refresh(): Promise<void> {
    if (!this.media) return;
    try {
      const remaining = await this.media.budget.remainingToday();
      if (this.budgetEl && 'textContent' in this.budgetEl) {
        const spent = await this.media.budget.spentToday();
        this.budgetEl.textContent = remaining === undefined
          ? `今日已花费 ¥${spent.toFixed(2)}（未设日预算）`
          : `今日已花费 ¥${spent.toFixed(2)} / 剩余 ¥${remaining.toFixed(2)}`;
      }
      const recent = await this.media.store.listTasks({ limit: 30 });
      for (const t of recent) this.tasks.set(t.id, t);
      this.renderAll();
    } catch {
      /* 面板失败不打扰主流程 */
    }
  }

  private renderAll(): void {
    if (!this.listEl || !('innerHTML' in this.listEl)) return;
    this.listEl.innerHTML = '';
    const sorted = [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
    for (const t of sorted) this.renderTask(t, true);
  }

  private renderTask(t: TaskRecord, append = false): void {
    if (!this.listEl || typeof this.listEl.ownerDocument === 'undefined') return;
    const doc = this.listEl.ownerDocument;
    const id = `media-task-${t.id}`;
    let card = doc.getElementById(id);
    if (!card) {
      card = doc.createElement('div');
      card.id = id;
      Object.assign(card.style, { borderBottom: '1px solid #2a2a2a', padding: '8px 0' } as Partial<CSSStyleDeclaration>);
      if (append || !this.listEl.firstChild) this.listEl.appendChild(card);
      else this.listEl.insertBefore(card, this.listEl.firstChild);
    }
    card.innerHTML = '';

    const head = doc.createElement('div');
    head.textContent = `${iconOf(t.modality)} ${t.modality} · ${t.provider} · ${statusText(t.status)}${typeof t.percent === 'number' && t.status === 'running' ? ` ${t.percent}%` : ''}`;
    card.appendChild(head);

    if (t.error) {
      const err = doc.createElement('div');
      err.textContent = `⚠ ${t.error}`;
      Object.assign(err.style, { color: '#e66', wordBreak: 'break-all' } as Partial<CSSStyleDeclaration>);
      card.appendChild(err);
      if (t.status === 'failed') card.appendChild(this.retryButton(t));
    }

    // 产物预览（成功后拉取）
    if (t.status === 'succeeded' && this.media) {
      void this.media.taskStatus(t.id).then((view: TaskView | undefined) => {
        if (!view || !card) return;
        for (const a of view.artifacts) {
          card.appendChild(this.preview(a.path, a.mime, t.id));
        }
      });
    }
  }

  private preview(path: string, mime: string, taskId: string): HTMLElement {
    const doc = this.listEl.ownerDocument;
    const wrap = doc.createElement('div');
    Object.assign(wrap.style, { margin: '6px 0', display: 'flex', gap: '8px', alignItems: 'center' } as Partial<CSSStyleDeclaration>);
    // dsh Web UI 通常提供工作区文件的 HTTP 访问端点；拿不到就用 file 引用文本兜底
    const src = this.ctx.fileUrl ? this.ctx.fileUrl(path) : path;

    if (mime.startsWith('image/')) {
      const img = doc.createElement('img');
      img.src = src;
      Object.assign(img.style, { maxWidth: '140px', borderRadius: '6px' } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(img);
    } else if (mime.startsWith('audio/')) {
      const au = doc.createElement('audio');
      au.src = src;
      au.controls = true;
      wrap.appendChild(au);
    } else if (mime.startsWith('video/')) {
      const v = doc.createElement('video');
      v.src = src;
      v.controls = true;
      Object.assign(v.style, { maxWidth: '100%', borderRadius: '6px' } as Partial<CSSStyleDeclaration>);
      wrap.appendChild(v);
    } else {
      const span = doc.createElement('span');
      span.textContent = path;
      wrap.appendChild(span);
    }

    const btn = doc.createElement('button');
    btn.textContent = '引用到对话';
    btn.onclick = () => {
      // 优先走宿主插入接口，等价 @file；否则复制到剪贴板
      if (typeof this.ctx.insertToComposer === 'function') this.ctx.insertToComposer(path);
      else if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(path);
      this.ctx.emit?.('media/ui:reference', { taskId, path });
    };
    wrap.appendChild(btn);
    return wrap;
  }

  private retryButton(t: TaskRecord): HTMLElement {
    const doc = this.listEl.ownerDocument;
    const btn = doc.createElement('button');
    btn.textContent = '重试';
    btn.onclick = async () => {
      if (!this.media) return;
      const view = await this.media.taskStatus(t.id);
      if (!view) return;
      const req = JSON.parse(view.requestJson);
      const { id: _drop, ...rest } = req;
      await this.media.queue.enqueue(rest);
    };
    return btn;
  }

  destroy(): void {
    this.tasks.clear();
  }
}

function iconOf(m: string): string {
  return { image: '🖼', 'image-edit': '✏️', speech: '🔊', video: '🎬' }[m] ?? '📦';
}

function statusText(s: string): string {
  return (
    {
      pending: '排队中', submitted: '已提交', running: '生成中',
      succeeded: '已完成', failed: '失败', canceled: '已取消', rejected: '被拒绝'
    }[s] ?? s
  );
}
