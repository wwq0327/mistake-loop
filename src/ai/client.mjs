// 第一版只留接口与审核闸门，不接真实密钥。
// 密钥只从环境变量读，不进代码、不进 git、不进日志。

export function isEnabled() {
  return Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL);
}

export async function analyze(payload, { signal } = {}) {
  if (!isEnabled()) {
    return { status: 'disabled', reviewed: false, data: null };
  }
  const base = process.env.AI_BASE_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    // 只回状态码，不回显响应体，避免把密钥或上游内容带进日志
    throw new Error(`AI upstream returned ${response.status}`);
  }
  const data = await response.json();
  // 所有 AI 结果必须教师审核后才生效
  return { status: 'ok', reviewed: false, data };
}
