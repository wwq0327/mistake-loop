// #27 测试先行：README 与文档索引的静态检查。
// 红灯预期：scripts/check-docs.mjs 尚未实现；实现后真实仓库 README 仍是 v1 描述、发布说明链接目标缺失。
// #31 追加：文档里会漂的数字（Issue 总数、用例数）必须有守护。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocs } from '../scripts/check-docs.mjs';
import { EXPECTED_COUNT } from '../scripts/check-issue-map.mjs';
import { countTests } from '../scripts/count-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = 'docs/releases/2026-11-04-v2.md';

// 真实跑出来的用例数（唯一事实源，不是源码行数，也不是手抄的数字）。
function countRepoTests(root = ROOT) {
  return countTests(root).total;
}

const README_OK = [
  '# 演示仓库',
  '',
  '当前 main 是 v2 已交付版本：工作台 / 收件箱 / 题目详情 / 打印 / 题库 / 设置 六页。',
  'AI 图片识别只产草稿，教师逐题确认后才入库；未启用时退回空白草稿等价路径。',
  '',
  '详见 [PRD](docs/requirements/PRD.md)、[发布说明](docs/releases/2026-11-04-v2.md)、[许可证](LICENSE)。',
  '',
  '## 文档索引',
  '',
  '| 文档 | 看什么 |',
  '| --- | --- |',
  '| `docs/requirements/PRD.md` | 需求 |',
  '| `docs/releases/2026-11-04-v2.md` | 发布说明 |',
].join('\n');

const RELEASE_OK = [
  '# v2 发布说明',
  '',
  '## 已完成',
  '- 六页界面与 AI 草稿流程。',
  '',
  '## 未验证',
  '- 真实 NAS 容器；手机相机；打印预览；两周试运行。',
  '',
  '## 许可证与数据边界',
  '- MIT。',
  '- 真实学生数据与照片不入库，data/ 已 gitignore；照片外发需显式开启 AI。',
].join('\n');

function withRepo(readme = README_OK, build, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-docs-'));
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'releases'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), readme);
  writeFileSync(join(dir, 'LICENSE'), 'MIT');
  writeFileSync(join(dir, 'docs', 'requirements', 'PRD.md'), '# PRD');
  writeFileSync(join(dir, RELEASE), RELEASE_OK);
  if (build) build(dir);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('最小仓库文档齐全时检查通过，并返回实际回读数量', () => {
  withRepo(undefined, null, (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, true, out.errors.join('; '));
    assert.ok(out.links >= 3, '未回读 README 链接');
    assert.ok(out.docs >= 2, '未回读 docs 文件');
  });
});

test('README 引用的文档路径不存在时必须判失败，并点名缺失目标', () => {
  withRepo(undefined, (dir) => rmSync(join(dir, 'docs', 'requirements', 'PRD.md')), (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /docs\/requirements\/PRD\.md/);
  });
});

test('docs/ 下有文件但 README 索引未列出时必须判失败', () => {
  withRepo(undefined, (dir) => writeFileSync(join(dir, 'docs', 'new-note.md'), '# 新增'), (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /docs\/new-note\.md/);
  });
});

test('README 未描述 v2 六页或 AI 草稿流程时必须判失败', () => {
  const v1 = README_OK
    .replace('当前 main 是 v2 已交付版本：工作台 / 收件箱 / 题目详情 / 打印 / 题库 / 设置 六页。', '当前 main 是 v1：三页界面。')
    .replace('AI 图片识别只产草稿，教师逐题确认后才入库；未启用时退回空白草稿等价路径。', '第一版没有图片识别。');
  withRepo(v1, null, (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /v2|六页|草稿/);
  });
});

test('发布说明链接目标缺失时必须判失败', () => {
  withRepo(undefined, (dir) => rmSync(join(dir, RELEASE)), (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), new RegExp(RELEASE.replace(/\./g, '\\.')));
  });
});

test('发布说明缺「未验证」或数据边界时必须判失败', () => {
  withRepo(undefined, (dir) => writeFileSync(join(dir, RELEASE), '# v2 发布说明\n\n## 已完成\n- 六页。\n'), (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false);
    assert.match(out.errors.join(' '), /未验证|数据边界/);
  });
});

// 真实仓库：#27 的真实红灯来源。README 仍写 v1、索引未补齐、发布说明尚未产出。
test('#27 真实仓库的 README 与文档索引必须全部通过静态检查', () => {
  const out = checkDocs(ROOT);
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.ok(existsSync(join(ROOT, RELEASE)), '发布说明文件不存在');
  assert.ok(out.links >= 8, `README 链接回读数偏少：${out.links}`);
  assert.ok(out.docs >= 11, `docs 文件回读数偏少：${out.docs}`);
});

// ── #31 数字一致性：文档里会漂的数字必须有守护 ───────────────────────────────

test('#31 文档里的 Issue 总数必须与唯一事实源 EXPECTED_COUNT 一致', () => {
  const out = checkDocs(ROOT);
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.equal(out.issueCount, EXPECTED_COUNT, '未回读 Issue 总数');
});

test('#31 README 写错的 Issue 总数必须被判失败，且错误信息点名文件与两个数字', () => {
  const wrong = README_OK.replace(
    '详见 [PRD](docs/requirements/PRD.md)',
    `本仓库共 ${EXPECTED_COUNT + 7} 个 Issue。详见 [PRD](docs/requirements/PRD.md)`,
  );
  withRepo(wrong, null, (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false, '写错的 Issue 总数没有被判失败');
    const hit = out.errors.find((e) => /README\.md/.test(e) && /Issue/.test(e));
    assert.ok(hit, `错误信息未点名文件与 Issue：${out.errors.join(' | ')}`);
    assert.match(hit, new RegExp(String(EXPECTED_COUNT + 7)), '错误信息未包含文档里写的错值');
    assert.match(hit, new RegExp(String(EXPECTED_COUNT)), '错误信息未包含期望值');
  });
});

test('#31 README 写错的用例数必须被判失败（用例数随代码变，不许手抄）', () => {
  const wrong = README_OK.replace(
    '详见 [PRD](docs/requirements/PRD.md)',
    '全量 999 个用例全绿。详见 [PRD](docs/requirements/PRD.md)',
  );
  withRepo(wrong, null, (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false, '写错的用例数没有被判失败');
    const hit = out.errors.find((e) => /README\.md/.test(e) && /用例/.test(e));
    assert.ok(hit, `错误信息未点名文件与用例数：${out.errors.join(' | ')}`);
    assert.match(hit, /999/, '错误信息未包含文档里写的错值');
  });
});

test('#31 真实仓库的用例数必须等于实际跑出来的用例数，不接受手抄', () => {
  const out = checkDocs(ROOT);
  assert.equal(out.ok, true, out.errors.join('; '));
  assert.ok(Number.isInteger(out.testCount) && out.testCount > 0, `未回读用例数：${out.testCount}`);
  // 与真实跑一次的结果对齐：读回当前仓库里实际存在的用例数量。
  const actual = countRepoTests(ROOT);
  assert.equal(out.testCount, actual, `回读用例数 ${out.testCount} 与实际 ${actual} 不一致`);
});

test('#31 发布说明里的用例数必须等于实际跑出来的用例数（不写死 177）', () => {
  const text = readFileSync(join(ROOT, RELEASE), 'utf8');
  const written = [...text.matchAll(/(\d+)\s*个用例/g)].map((m) => Number(m[1]));
  assert.ok(written.length > 0, '发布说明没有写用例数，无法校验');
  const actual = countRepoTests(ROOT);
  for (const n of written) {
    assert.equal(n, actual, `发布说明里的用例数 ${n} 与实际跑出来的 ${actual} 不一致`);
  }
});

test('#31 发布说明里的 Issue 总数同样受守护', () => {
  const bad = RELEASE_OK.replace('- 六页界面与 AI 草稿流程。', `- 六页界面与 AI 草稿流程，共 ${EXPECTED_COUNT + 3} 个 Issue。`);
  withRepo(undefined, (dir) => writeFileSync(join(dir, RELEASE), bad), (dir) => {
    const out = checkDocs(dir);
    assert.equal(out.ok, false, '发布说明里的错 Issue 总数没有被判失败');
    assert.match(out.errors.join(' '), new RegExp(RELEASE.replace(/\//g, '\\/')), '错误信息未点名发布说明文件');
  });
});
