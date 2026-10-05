/**
 * 统一错误模型：区分可重试与不可重试，
 * 队列据此决定是否进入指数退避重试，避免参数/鉴权类错误白白烧预算。
 */

export class MediaError extends Error {
  constructor(
    message: string,
    /** true：网络/限流/服务端错误，可重试；false：参数/鉴权/能力缺失，立即失败 */
    public readonly retryable: boolean,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'MediaError';
  }
}

/** HTTP 状态码 → 可重试性分类 */
export function httpError(status: number, body: string, source = 'provider'): MediaError {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new MediaError(`[${source}] HTTP ${status}: ${String(body).slice(0, 200)}`, retryable);
}

export function timeoutError(ms: number, label = '请求'): MediaError {
  return new MediaError(`${label}超时（>${ms}ms）`, true);
}

export function configError(message: string): MediaError {
  return new MediaError(message, false);
}

/** 非 MediaError 的未知异常默认可重试（网络抖动等），但会保留原始堆栈信息 */
export function asMediaError(e: unknown): MediaError {
  if (e instanceof MediaError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // fetch 常见网络错误归类为可重试
  const retryable = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg);
  return new MediaError(msg, retryable, { cause: e });
}

export function isRetryable(e: unknown): boolean {
  return asMediaError(e).retryable;
}

/** 带超时的 Promise 包装 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label = '请求'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(timeoutError(ms, label)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
