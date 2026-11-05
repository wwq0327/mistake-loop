// #2 实现：校验 docs/github/issue-map.md 的编号完整性与字段质量。
// 由 test/issue-map.test.mjs 先行定义行为；也可单独执行做提交前检查。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// 新增 Issue 时同步改这里，并由 scripts/gen-issue-map 重新生成映射表。
export const EXPECTED_COUNT = 77;
const DEFAULT_PATH = fileURLToPath(new URL('../docs/github/issue-map.md', import.meta.url));

export function checkIssueMap(path = DEFAULT_PATH) {
  if (!existsSync(path)) return { ok: false, count: 0, errors: ['映射文件不存在'] };
  const text = readFileSync(path, 'utf8');
  const errors = [];
  const numbers = new Set();
  const stageCounts = new Map();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| #')) continue;
    const cells = trimmed.split('|').map((s) => s.trim()).filter((s, i, arr) => i > 0 && i < arr.length - 1);
    const head = cells[0] ?? '';
    const m = /^#(\d+)$/.exec(head);
    if (!m) { errors.push(`编号格式错误：${head}`); continue; }
    const n = Number(m[1]);
    if (numbers.has(n)) errors.push(`重复编号：#${n}`);
    numbers.add(n);
    if (!cells[1]) errors.push(`#${n} 缺阶段列`);
    if (!cells[2] || /TODO|待补|待定/i.test(cells[2])) errors.push(`#${n} 缺关联需求列或为占位符`);
    // P7 起为设计改版等后续阶段，阶段号允许 0-99。
    if (cells[1] && !/^P[0-9]{1,2}/.test(cells[1])) errors.push(`#${n} 阶段列格式错误：${cells[1]}`);
    const stage = (cells[1] ?? '').split(/\s+/)[0];
    if (stage) stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }

  for (let n = 1; n <= EXPECTED_COUNT; n += 1) {
    if (!numbers.has(n)) errors.push(`缺少编号：#${n}`);
  }
  for (const n of numbers) {
    if (n < 1 || n > EXPECTED_COUNT) errors.push(`超出预期范围的编号：#${n}`);
  }

  // #31 数字一致性：映射文档自己写的总数与阶段汇总也必须与事实源一致。
  const totalRow = /^\|\s*Issue 总数\s*\|\s*(\d+)\s*\|/m.exec(text);
  if (!totalRow) errors.push('缺「Issue 总数」行');
  else if (Number(totalRow[1]) !== EXPECTED_COUNT) {
    errors.push(`「Issue 总数」写的是 ${totalRow[1]}，实际应为 ${EXPECTED_COUNT}`);
  }
  for (const line of text.split('\n')) {
    const m = /^\|\s*(P\d+)\b[^|]*\|\s*(\d+)\s*\|/.exec(line.trim());
    if (!m) continue;
    const [, stage, written] = m;
    const actual = stageCounts.get(stage) ?? 0;
    if (Number(written) !== actual) {
      errors.push(`阶段汇总 ${stage} 写的是 ${written} 个，映射表里实际 ${actual} 个`);
    }
  }
  return { ok: errors.length === 0, count: numbers.size, errors };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const out = checkIssueMap();
  if (out.ok) {
    console.log(`issue-map: PASS (${out.count} issues, 编号 1-${EXPECTED_COUNT} 齐全)`);
  } else {
    console.error(`issue-map: FAIL (${out.count} issues)`);
    for (const e of out.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}
