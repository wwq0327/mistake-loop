// node:test 的摘要行在 Node 22 是 TAP 风格（`# pass 28`），
// 在 Node 26 是 spec 风格（`ℹ pass 28`）。只解析计数，不依赖具体 reporter 前缀。
// 零依赖、纯函数，供回归检查与 CI 契约测试共用。
export function parseTestSummary(text) {
  const pick = (key) => {
    const match = String(text).match(new RegExp(`(?:#|ℹ)\\s+${key}\\s+(\\d+)\\b`));
    return match ? Number(match[1]) : NaN;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}
