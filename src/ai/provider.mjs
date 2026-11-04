// 唯一对外 HTTP 出口：OpenAI 兼容 chat/completions + image_url(base64)。
// 密钥只在模块内从环境读，不落日志、不进错误信息、不进接口响应。
// 只返回上游原始文本，解析与清洗交给 normalize.mjs。
import { buildRecognitionPrompt } from './prompt.mjs';

export class ProviderError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_DAILY_LIMIT = 30;

export function providerConfig(env = process.env) {
  const baseUrl = String(env.AI_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = String(env.AI_API_KEY || '');
  const model = String(env.AI_MODEL || '');
  const enabled = env.AI_ENABLED === '1' && Boolean(baseUrl && apiKey && model);
  const timeoutMs = Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const maxImageBytes = Number(env.AI_MAX_IMAGE_BYTES) > 0 ? Number(env.AI_MAX_IMAGE_BYTES) : DEFAULT_MAX_IMAGE_BYTES;
  const dailyLimit = Number(env.AI_DAILY_LIMIT) > 0 ? Number(env.AI_DAILY_LIMIT) : DEFAULT_DAILY_LIMIT;
  return { enabled, baseUrl, apiKey, model, timeoutMs, maxImageBytes, dailyLimit };
}

export function createProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = providerConfig(env);

  async function recognize({ imageBase64, mime = 'image/jpeg', hint = '', signal } = {}) {
    if (!config.enabled) {
      throw new ProviderError('AI 未启用，照片不会离开这台设备', 'NOT_CONFIGURED');
    }
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      throw new ProviderError('没有可识别的图片', 'INVALID_IMAGE');
    }
    if (Buffer.byteLength(imageBase64, 'utf8') > config.maxImageBytes) {
      throw new ProviderError('图片超过上游大小上限', 'IMAGE_TOO_LARGE');
    }

    const url = `${config.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildRecognitionPrompt(hint) },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      }],
    });

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    if (signal) {
      if (signal.aborted) externallyAborted = true;
      else signal.addEventListener('abort', () => {
        externallyAborted = true;
        controller.abort();
      }, { once: true });
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new ProviderError(
          timedOut ? '识别超时，可重试或改为手工录入' : '识别已取消',
          timedOut ? 'TIMEOUT' : 'ABORTED',
        );
      }
      throw new ProviderError('连不上识别服务，可重试或改为手工录入', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const status = Number(response.status) || 0;
      if (status === 429) {
        throw new ProviderError('上游限流，今日不再重复调用', 'RATE_LIMITED', status);
      }
      throw new ProviderError(`上游返回 ${status}，原图已保留`, 'UPSTREAM_ERROR', status);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError('上游返回的不是 JSON', 'INVALID_RESPONSE');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('上游响应缺少识别文本', 'MISSING_FIELD');
    }
    return content;
  }

  return {
    isEnabled: config.enabled,
    model: config.model,
    providerName: 'openai-compatible',
    config: { timeoutMs: config.timeoutMs, maxImageBytes: config.maxImageBytes, dailyLimit: config.dailyLimit },
    recognize,
  };
}
