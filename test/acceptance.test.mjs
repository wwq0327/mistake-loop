// #26 测试先行：B1-B12 全量验收报告必须逐项留实际数字或复现步骤。
// 红灯预期：验收脚本与报告都还不存在；不接受「命令执行成功」当结论。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const REPORT = 'docs/audits/2026-11-04-v2-acceptance.md';
const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);

function sectionOf(report, number) {
  if (!report) return null;
  const start = report.indexOf(`## B${number} `);
  if (start < 0) return null;
  const rest = report.slice(start + 1);
  const next = rest.search(/\n## (?:B\d+|第)/);
  return next < 0 ? report.slice(start) : report.slice(start, start + 1 + next);
}

test('#26 验收脚本与 B 系列报告都存在', () => {
  assert.ok(read('scripts/acceptance.mjs'), '缺 scripts/acceptance.mjs');
  assert.ok(read(REPORT), `缺 ${REPORT}`);
});

test('#26 报告逐项覆盖 B1-B12，每项都有状态与实际数字', () => {
  const report = read(REPORT);
  assert.ok(report, '报告不存在');
  for (let i = 1; i <= 12; i += 1) {
    const section = sectionOf(report, i);
    assert.ok(section, `报告缺 ## B${i} 章节`);
    assert.match(section, /状态：/, `B${i} 缺状态行`);
    assert.match(section, /\d/, `B${i} 没有实际数字（不接受「命令执行成功」）`);
    assert.match(section, /证据|复现|回读/, `B${i} 缺证据或复现步骤`);
  }
});

test('#26 B11 留给用户判断，不由开发自评通过', () => {
  const section = sectionOf(read(REPORT), 11);
  assert.ok(section, '缺 B11 章节');
  assert.match(section, /待用户判断|由你判断|不自评/, 'B11 未标明需用户判断');
  assert.doesNotMatch(section, /状态：PASS/, 'B11 被开发自评通过，违反 PRD');
});

test('#26 四项实机 / 试运行未验证项如实列出，不写成已验证', () => {
  const report = read(REPORT);
  assert.ok(report, '报告不存在');
  for (const keyword of ['NAS', '相机', '打印预览', '两周']) {
    assert.ok(report.includes(keyword), `缺未验证项：${keyword}`);
  }
  assert.match(report, /未验证/, '报告没有明确写出未验证');
  assert.match(report, /页面做完|测试通过|命令成功/, '未写明「测试通过不能代替实机验收」');
});

test('#26 验收脚本逐项留证据，且任一 B 项不达标就退出 1', () => {
  const source = read('scripts/acceptance.mjs');
  assert.ok(source, '验收脚本不存在');
  assert.match(source, /evidence/, '脚本未逐项留证据');
  assert.match(source, /process\.exitCode\s*=\s*1|process\.exit\(1\)/, '脚本不会因 B 项不达标而失败');
  assert.match(source, /parseTestSummary|spawnSync/, '脚本未回读测试计数');
  for (const key of ['B1', 'B5', 'B6', 'B7', 'B8', 'B10', 'B12']) {
    assert.ok(source.includes(`'${key}'`) || source.includes(`"${key}"`), `脚本缺 ${key} 检查`);
  }
});
