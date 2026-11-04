// #2 测试先行：Issue 与需求编号映射文档的静态校验
// 红灯预期：scripts/check-issue-map.mjs 尚未实现，import 失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIssueMap, EXPECTED_COUNT } from '../scripts/check-issue-map.mjs';

// 编号总数只有一个事实源：EXPECTED_COUNT。测试不许再写死数字。
const TOTAL = EXPECTED_COUNT;

function withFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-map-'));
  const file = join(dir, 'issue-map.md');
  if (content !== null) writeFileSync(file, content);
  try { return fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function validRows(from, to, { omit = null } = {}) {
  const rows = [];
  for (let n = from; n <= to; n += 1) {
    if (n === omit) continue;
    rows.push(`| #${n} | P${Math.min(6, Math.ceil(n / 5))} | F15 / B1 |`);
  }
  const lines = [
    `| Issue 总数 | ${rows.length} |`,
    '| Issue | 阶段 | 关联需求 |',
    '| --- | --- | --- |',
    ...rows,
  ];
  return lines.join('\n');
}

test('映射文件不存在时必须判失败', () => {
  withFile(null, (file) => {
    const out = checkIssueMap(file);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /不存在/);
  });
});

test('编号不连续时必须判失败', () => {
  withFile(validRows(1, TOTAL, { omit: 9 }), (file) => {
    const out = checkIssueMap(file);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /#9/);
  });
});

test('行内缺阶段或需求编号时必须判失败', () => {
  const bad = `${validRows(1, TOTAL)}\n| #${TOTAL + 1} |  |  |`;
  withFile(bad, (file) => {
    const out = checkIssueMap(file);
    assert.equal(out.ok, false);
  });
});

test(`${TOTAL} 个编号齐全且字段完整时通过`, () => {
  withFile(validRows(1, TOTAL), (file) => {
    const out = checkIssueMap(file);
    assert.equal(out.ok, true, out.errors.join('; '));
    assert.equal(out.count, TOTAL);
  });
});
