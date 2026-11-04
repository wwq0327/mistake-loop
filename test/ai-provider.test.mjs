// #12 测试先行：可插拔视觉接口（OpenAI 兼容），本地假端点、零外网。
// 红灯预期：src/ai/provider.mjs 不存在，import 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider, providerConfig, ProviderError } from '../src/ai/provider.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ENABLED_ENV = {
  AI_ENABLED: '1',
  AI_BASE_URL: 'http://127.0.0.1:9999/v1',
  AI_API_KEY: 'sk-local-fake-key',
  AI_MODEL: 'fake-vision-model',
  AI_TIMEOUT_MS: '50',
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { impl, calls };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CONTENT = JSON.stringify({ questions: [{ seq: 1, prompt: '1+1=?' }] });

test('未配置时 isEnabled=false，且一次外部请求都不发', async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse({ choices: [{ message: { content: CONTENT } }] }));
  for (const env of [{}, { ...ENABLED_ENV, AI_ENABLED: '0' }, { ...ENABLED_ENV, AI_API_KEY: '' }]) {
    const provider = createProvider({ env, fetchImpl: impl });
    assert.equal(provider.isEnabled, false);
    await assert.rejects(
      () => provider.recognize({ imageBase64: 'AAAA', mime: 'image/jpeg' }),
      (error) => error instanceof ProviderError && error.code === 'NOT_CONFIGURED',
    );
  }
  assert.equal(calls.length, 0, '关闭状态竟发起了外部请求');
  assert.equal(providerConfig({}).enabled, false);
});

test('成功：请求为 chat/completions + image_url base64，模型名来自 AI_MODEL，返回原始文本', async () => {
  const { impl, calls } = fakeFetch(async () => jsonResponse({ choices: [{ message: { content: CONTENT } }] }));
  const provider = createProvider({ env: ENABLED_ENV, fetchImpl: impl });
  const raw = await provider.recognize({ imageBase64: 'AAAA', mime: 'image/jpeg', hint: '小学数学' });
  assert.equal(raw, CONTENT);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('http://127.0.0.1'), '请求发往了非本地地址');
  assert.match(calls[0].url, /\/chat\/completions$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'fake-vision-model');
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-local-fake-key');
  assert.equal(provider.model, 'fake-vision-model');
});

test('超时归一化为 TIMEOUT；外部 signal 取消归一化为 ABORTED', async () => {
  const { impl } = fakeFetch((url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  const provider = createProvider({ env: ENABLED_ENV, fetchImpl: impl });
  await assert.rejects(
    () => provider.recognize({ imageBase64: 'AAAA' }),
    (error) => error instanceof ProviderError && error.code === 'TIMEOUT',
  );

  const controller = new AbortController();
  const external = createProvider({ env: { ...ENABLED_ENV, AI_TIMEOUT_MS: '5000' }, fetchImpl: impl });
  const pending = external.recognize({ imageBase64: 'AAAA', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof ProviderError && error.code === 'ABORTED');
});

test('429 归一化为 RATE_LIMITED；非 JSON 响应归一化为 INVALID_RESPONSE；缺字段为 MISSING_FIELD', async () => {
  const cases = [
    [async () => jsonResponse({ error: 'slow down' }, 429), 'RATE_LIMITED'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }), 'INVALID_RESPONSE'],
    [async () => jsonResponse({ choices: [] }), 'MISSING_FIELD'],
    [async () => jsonResponse({}), 'MISSING_FIELD'],
    [async () => jsonResponse({ choices: [{ message: { content: null } }] }), 'MISSING_FIELD'],
  ];
  for (const [handler, code] of cases) {
    const { impl } = fakeFetch(handler);
    const provider = createProvider({ env: ENABLED_ENV, fetchImpl: impl });
    await assert.rejects(
      () => provider.recognize({ imageBase64: 'AAAA' }),
      (error) => error instanceof ProviderError && error.code === code,
      `期望 ${code}`,
    );
  }
});

test('密钥不进错误信息、不进日志，源码不含硬编码厂商域名', async () => {
  const { impl } = fakeFetch(async () => jsonResponse({ choices: [] }));
  const provider = createProvider({ env: ENABLED_ENV, fetchImpl: impl });
  try {
    await provider.recognize({ imageBase64: 'AAAA' });
    assert.fail('应当抛错');
  } catch (error) {
    assert.ok(!error.message.includes('sk-local-fake-key'), '错误信息泄漏密钥');
    assert.ok(!JSON.stringify(error).includes('sk-local-fake-key'));
  }
  const source = readFileSync(join(here, '..', 'src', 'ai', 'provider.mjs'), 'utf8');
  assert.doesNotMatch(source, /api\.openai\.com|dashscope\.aliyuncs\.com|bigmodel\.cn/i);
  assert.doesNotMatch(source, /console\.(log|error|warn)/, 'provider 不应打印日志');
});
