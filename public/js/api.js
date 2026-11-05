// 唯一的后端出入口：统一 JSON、统一错误、统一超时。页面不直接写 fetch。
export class ApiError extends Error {
  constructor(message, { status = 0, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // 默认的 code 必须看有没有拿到 HTTP 响应：
    // 有 status 就说明服务端已经回了话，这时说「连不上服务」是谎报——
    // 老师会以为程序挂了，实际只是「现在不能这么做」「参数不对」。
    // 只有连 status 都没有（断线、超时、取消）才轮到 NETWORK。
    this.code = code ?? (status ? 'HTTP_ERROR' : 'NETWORK');
  }
}

// 请求挂起时不能永远转圈：默认 15 秒没回应就当超时，让界面把话说出来。
// 传 timeoutMs: 0 表示不设上限（给确实很慢的批量操作）。
export const DEFAULT_TIMEOUT_MS = 15000;

export async function api(path, {
  method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
    : null;
  // 调用方自己传的 signal 也要能中止这次请求。
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new ApiError('请求太久没有回应，请确认服务是否还在运行', { code: 'TIMEOUT' });
      }
      throw new ApiError('请求已取消', { code: 'ABORTED' });
    }
    throw new ApiError('连不上服务，请确认本机程序仍在运行', { code: 'NETWORK' });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new ApiError(data?.error?.message || `请求失败（${response.status}）`, {
      status: response.status,
      code: data?.error?.code || 'HTTP_ERROR',
    });
  }
  return data;
}

// 把错误翻译成给老师看的话：不同状态要说不同的话，
// 别一律「请求失败」——「状态不允许」与「参数不对」该分开说。
// 每一类都带上自己的措辞：即使几条错误的后端原文一样，
// 说出来的话也必须不一样，否则「分类」等于没做。
export function describeError(error) {
  if (!error) return '出了点问题';
  if (error.code === 'TIMEOUT') return '请求太久没有回应，请确认服务是否还在运行';
  if (error.code === 'NETWORK') return '连不上服务，请确认本机程序仍在运行';
  if (error.code === 'ABORTED') return '请求已取消';
  if (error.status === 409) return `现在不能这么做：${error.message || '换个时机再试'}`;
  if (error.status === 404) return `找不到：${error.message || '要找的东西不在'}`;
  if (error.status === 400) return `请求没通过：${error.message || '参数不对'}`;
  return error.message || '出了点问题';
}

export function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
