// 唯一的后端出入口：统一 JSON、统一错误、统一超时。页面不直接写 fetch。
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('请求已取消', { code: 'ABORTED' });
    throw new ApiError('连不上服务，请确认本机程序仍在运行', { code: 'NETWORK' });
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

export function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
