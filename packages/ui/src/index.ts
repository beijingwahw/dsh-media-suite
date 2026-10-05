/**
 * dsh-media-ui —— Web UI「媒体生成」面板。
 *
 * dsh UI 挂载点处于 developer preview，本插件按优先级尝试：
 *   1. 宿主 ui 服务：ctx.ui.registerPanel / ctx.registry.ui
 *   2. 事件广播 'media/ui:mount'（由宿主 UI 适配层拾取）
 *   3. 直接挂到 document 右侧浮层（保底，任何 Web UI 下可见）
 *
 * 深度优化：
 *  - 纯事件驱动增量渲染（media/task:updated 精准更新单卡片），
 *    低频对账刷新（默认 10s）兜底，替代旧版 2s 全量轮询
 *  - 任务取消按钮、按模态/状态筛选、成本列、空状态提示
 *  - 产物详情按 taskId 缓存，避免重复请求
 */
import type { MediaService, TaskRecord, TaskView } from 'dsh-media-core';

export const name = 'media-ui';

export interface Config {
  panelTitle?: string;
  /** 对账刷新间隔（ms），事件驱动为主、此为兜底 */
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
  const refreshMs = config.refreshMs ?? 10_000;
  const media: MediaService | undefined = ctx.media ?? ctx.registry?.media;

  const panel = new MediaPanel(title, media, ctx);
  const mounted = mountPanel(ctx, panel.root, title);

  const offTask = ctx.on('media/task:updated', (t: TaskRecord) => panel.onTask(t));
  const offArtifact = ctx.on('media/artifact:created', (e: { taskId: string }) => panel.onArtifact(e?.taskId));

  const timer = typeof setInterval !== 'undefined' ? setInterval(() => panel.reconcile(), refreshMs) : undefined;

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
  if (typeof document !== 'undefined' && !document.getElementById('dsh-media-panel')) {
    el.id = 'dsh-media-panel';
    Object.assign(el.style, {
      position: 'fixed', top: '48px', right: '0', bottom: '0', width: '360px',
      overflowY: 'auto', background: 'var(--dsh-bg, #111)', color: 'var(--dsh-fg, #eee)',
      borderLeft: '1px solid #333', padding: '12px', zIndex: '9000', fontSize: '13px'
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    return { unmount: () => el.remove() };
  }
  return {};
}

type Filter = { modality: string; status: string };

class MediaPanel {
  readonly root: HTMLElement;
  private doc: Document | undefined;
  private listEl!: HTMLElement;
  private budgetEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private tasks = new Map<string, TaskRecord>();
  private viewCache = new Map<string, TaskView>();
  private filter: Filter = { modality: 'all', status: 'all' };

  constructor(private title: string, private media: MediaService | undefined, private ctx: PluginContext) {
    if (typeof document === 'undefined') {
      // headless：面板退化为 no-op
      this.root = { appendChild() {}, style: {} } as unknown as HTMLElement;
      return;
    }
    this.doc = document;
    this.root = document.createElement('div');
    this.buildChrome();
    void this.reconcile();
  }

  private buildChrome(): void {
    const doc = this.doc!;
    const h = doc.createElement('h3');
    h.textContent = this.title;
    Object.assign(h.style, { margin: '0 0 8px' } as Partial<CSSStyleDeclaration>);

    this.budgetEl = doc.createElement('div');
    Object.assign(this.budgetEl.style, { opacity: '0.8', marginBottom: '8px' } as Partial<CSSStyleDeclaration>);

    // 筛选行
    const bar = doc.createElement('div');
    Object.assign(bar.style, { display: 'flex', gap: '6px', marginBottom: '8px' } as Partial<CSSStyleDeclaration>);
    const modSel = this.select(['all:全部模态', 'image:图像', 'image-edit:图像编辑', 'speech:语音', 'video:视频'], (v) => { this.filter.modality = v; this.renderFiltered(); });
    const stSel = this.select(['all:全部状态', 'running:进行中', 'succeeded:已完成', 'failed:失败', 'rejected:被拒绝', 'canceled:已取消'], (v) => { this.filter.status = v; this.renderFiltered(); });
    bar.append(modSel, stSel);

    this.emptyEl = doc.createElement('div');
    this.emptyEl.textContent = '暂无生成任务。对 Agent 说「生成一张…」即可开始。';
    Object.assign(this.emptyEl.style, { opacity: '0.5', padding: '24px 8px', textAlign: 'center' } as Partial<CSSStyleDeclaration>);

    this.listEl = doc.createElement('div');
    this.root.append(h, this.budgetEl, bar, this.emptyEl, this.listEl);
  }

  private select(options: string[], onChange: (v: string) => void): HTMLElement {
    const doc = this.doc!;
    const sel = doc.createElement('select');
    Object.assign(sel.style, { flex: '1', background: '#1c1c1c', color: 'inherit', border: '1px solid #333', borderRadius: '4px', padding: '2px 4px' } as Partial<CSSStyleDeclaration>);
    for (const opt of options) {
      const [value, label] = opt.split(':');
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.onchange = () => onChange((sel as HTMLSelectElement).value);
    return sel;
  }

  /** 事件驱动：单任务增量更新 */
  onTask(t: TaskRecord): void {
    this.tasks.set(t.id, t);
    if (isTerminal(t.status)) this.viewCache.delete(t.id); // 终态后允许重取产物
    this.renderFiltered();
  }

  /** 产物事件：拉取该任务详情并更新卡片 */
  onArtifact(taskId?: string): void {
    if (!taskId || !this.media) return;
    void this.media.taskStatus(taskId).then((v) => {
      if (v) {
        this.viewCache.set(taskId, v);
        this.renderFiltered();
      }
    });
  }

  /** 低频对账：兜底同步预算与近期任务（事件丢失时自愈） */
  async reconcile(): Promise<void> {
    if (!this.media) return;
    try {
      const spent = await this.media.budget.spentToday();
      const remaining = await this.media.budget.remainingToday();
      if (this.budgetEl) {
        this.budgetEl.textContent = remaining === undefined
          ? `今日已花费 ¥${spent.toFixed(2)}（未设日预算）`
          : `今日已花费 ¥${spent.toFixed(2)} / 剩余 ¥${remaining.toFixed(2)}`;
      }
      const recent = await this.media.store.listTasks({ limit: 50 });
      for (const t of recent) if (!this.tasks.has(t.id)) this.tasks.set(t.id, t);
      this.renderFiltered();
    } catch {
      /* 面板失败不打扰主流程 */
    }
  }

  private passFilter(t: TaskRecord): boolean {
    if (this.filter.modality !== 'all' && t.modality !== this.filter.modality) return false;
    if (this.filter.status === 'running' && !['pending', 'submitted', 'running'].includes(t.status)) return false;
    if (this.filter.status !== 'all' && this.filter.status !== 'running' && t.status !== this.filter.status) return false;
    return true;
  }

  private renderFiltered(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const sorted = [...this.tasks.values()].filter((t) => this.passFilter(t)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
    this.emptyEl.style.display = sorted.length ? 'none' : 'block';
    for (const t of sorted) this.renderCard(t);
  }

  private renderCard(t: TaskRecord): void {
    const doc = this.doc!;
    const card = doc.createElement('div');
    Object.assign(card.style, { borderBottom: '1px solid #2a2a2a', padding: '8px 0' } as Partial<CSSStyleDeclaration>);

    const head = doc.createElement('div');
    Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } as Partial<CSSStyleDeclaration>);
    const label = doc.createElement('span');
    label.textContent = `${iconOf(t.modality)} ${t.modality} · ${t.provider} · ${statusText(t.status)}${t.status === 'running' && typeof t.percent === 'number' ? ` ${t.percent}%` : ''}${typeof t.costCny === 'number' && t.costCny > 0 ? ` · ¥${t.costCny.toFixed(3)}` : ''}`;
    head.appendChild(label);

    // 进行中任务：取消按钮
    if (['pending', 'submitted', 'running'].includes(t.status) && this.media) {
      const cancel = doc.createElement('button');
      cancel.textContent = '取消';
      cancel.onclick = () => { void this.media!.cancel(t.id); };
      head.appendChild(cancel);
    }
    card.appendChild(head);

    if (t.status === 'running' && typeof t.percent === 'number') {
      const bar = doc.createElement('div');
      Object.assign(bar.style, { height: '3px', background: '#333', borderRadius: '2px', margin: '4px 0' } as Partial<CSSStyleDeclaration>);
      const fill = doc.createElement('div');
      Object.assign(fill.style, { height: '100%', width: `${t.percent}%`, background: '#4a9eff', borderRadius: '2px', transition: 'width .3s' } as Partial<CSSStyleDeclaration>);
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    if (t.error) {
      const err = doc.createElement('div');
      err.textContent = `⚠ ${t.error}`;
      Object.assign(err.style, { color: '#e66', wordBreak: 'break-all' } as Partial<CSSStyleDeclaration>);
      card.appendChild(err);
      if (t.status === 'failed') card.appendChild(this.retryButton(t));
    }

    // 产物预览（缓存命中直接渲染）
    const cached = this.viewCache.get(t.id);
    if (t.status === 'succeeded' && cached) {
      for (const a of cached.artifacts) card.appendChild(this.preview(a.path, a.mime, t.id));
    } else if (t.status === 'succeeded' && this.media) {
      void this.media.taskStatus(t.id).then((v) => {
        if (v) {
          this.viewCache.set(t.id, v);
          this.renderFiltered();
        }
      });
    }

    this.listEl.appendChild(card);
  }

  private preview(path: string, mime: string, taskId: string): HTMLElement {
    const doc = this.doc!;
    const wrap = doc.createElement('div');
    Object.assign(wrap.style, { margin: '6px 0', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } as Partial<CSSStyleDeclaration>);
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
      if (typeof this.ctx.insertToComposer === 'function') this.ctx.insertToComposer(path);
      else if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(path);
      this.ctx.emit?.('media/ui:reference', { taskId, path });
    };
    wrap.appendChild(btn);
    return wrap;
  }

  private retryButton(t: TaskRecord): HTMLElement {
    const doc = this.doc!;
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
    this.viewCache.clear();
  }
}

function isTerminal(s: string): boolean {
  return ['succeeded', 'failed', 'canceled', 'rejected'].includes(s);
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
