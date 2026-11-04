// #27 实现：README 引用链接、文档索引、v2 描述与发布说明的静态校验。
// #31 追加：文档里会漂的数字（Issue 总数、用例数）也由这里校验，数字不许手抄。
// 由 test/docs-check.test.mjs 测试先行定义行为；也可单独执行做提交前检查。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, sep } from 'node:path';
import { EXPECTED_COUNT } from './check-issue-map.mjs';
import { countTests } from './count-tests.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RELEASE_NOTES = 'docs/releases/2026-11-04-v2.md';

const PAGE_TERMS = ['工作台', '收件箱', '题目详情', '打印', '题库', '设置'];
const FLOW_TERMS = ['AI 图片识别', '草稿', '确认'];
const STALE_LINES = ['当前 `main` 是已可运行的 v1', 'v2 正在按'];
const RELEASE_TERMS = ['已完成', '未验证', 'MIT', '数据'];

// 文档里只要写了这两个总数，就必须等于真实来源；没写不强制。
const ISSUE_COUNT_RE = /(\d+)\s*个\s*(?:Issue|编号)/g;
const CASE_COUNT_RE = /(\d+)\s*个用例/g;

function localLinks(readme) {
  const links = [];
  for (const match of readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().split(/\s+/)[0];
    if (/^(https?:\/\/|mailto:|#)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target || target.startsWith('/')) continue;
    links.push(target);
  }
  return [...new Set(links)];
}

function docFiles(root, rel = 'docs') {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const relPath = `${rel}/${entry}`;
    if (statSync(path).isDirectory()) found.push(...docFiles(root, relPath));
    else if (/\.(md|html)$/i.test(entry)) found.push(relPath);
  }
  return found.sort();
}

// #31：只查「当前状态类」文档（README 与发布说明）。
// 历史档案（plans / audits / 交接文档）记的是当时的事实，不拿现在的数字去卡它们。
function numberedDocs(root) {
  const targets = ['README.md'];
  const relDir = join(root, 'docs', 'releases');
  if (existsSync(relDir)) {
    for (const entry of readdirSync(relDir).sort()) {
      if (entry.endsWith('.md')) targets.push(`docs/releases/${entry}`);
    }
  }
  return targets;
}

// #31：文档里写了总数就必须等于真实来源，错了要点名文件、行号与两个数字。
function checkNumbers(root, issueCount, testCount) {
  const errors = [];
  for (const rel of numberedDocs(root)) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const m of line.matchAll(ISSUE_COUNT_RE)) {
        const written = Number(m[1]);
        if (written !== issueCount) {
          errors.push(`${rel} 第 ${index + 1} 行：Issue 总数写的是 ${written} 个，实际应为 ${issueCount} 个`);
        }
      }
      for (const m of line.matchAll(CASE_COUNT_RE)) {
        const written = Number(m[1]);
        if (written !== testCount) {
          errors.push(`${rel} 第 ${index + 1} 行：用例数写的是 ${written} 个，实际应为 ${testCount} 个`);
        }
      }
    });
  }
  return errors;
}

export function checkDocs(root = DEFAULT_ROOT) {
  const errors = [];
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    return { ok: false, links: 0, docs: 0, issueCount: EXPECTED_COUNT, testCount: 0, errors: ['README.md 不存在'] };
  }
  const readme = readFileSync(readmePath, 'utf8');

  // 1. README 引用的每个本地文档路径都必须真实存在。
  const links = localLinks(readme);
  for (const target of links) {
    const path = resolve(root, target);
    if (!path.startsWith(resolve(root) + sep)) {
      errors.push(`链接越出仓库：${target}`);
      continue;
    }
    if (!existsSync(path)) errors.push(`链接目标缺失：${target}`);
  }

  // 2. docs/ 下每份文档都必须出现在 README 索引里。
  const docs = docFiles(root);
  for (const rel of docs) {
    if (!readme.includes(rel)) errors.push(`文档索引缺条目：${rel}`);
  }

  // 3. README 必须描述 v2 六页与 AI 草稿流程，不能还写着 v1 主版本口径。
  for (const term of PAGE_TERMS) {
    if (!readme.includes(term)) errors.push(`README 缺 v2 页面：${term}`);
  }
  for (const term of FLOW_TERMS) {
    if (!readme.includes(term)) errors.push(`README 缺 AI 草稿流程要素：${term}`);
  }
  for (const line of STALE_LINES) {
    if (readme.includes(line)) errors.push(`README 仍是 v1 口径：${line}`);
  }

  // 4. 发布说明必须被引用、存在，且列全四项内容。
  if (!links.includes(RELEASE_NOTES)) errors.push(`README 未链接发布说明：${RELEASE_NOTES}`);
  const releasePath = join(root, RELEASE_NOTES);
  if (!existsSync(releasePath)) {
    errors.push(`发布说明链接目标缺失：${RELEASE_NOTES}`);
  } else {
    const text = readFileSync(releasePath, 'utf8');
    for (const term of RELEASE_TERMS) {
      if (!text.includes(term)) errors.push(`发布说明缺章节或关键词：${term}`);
    }
  }

  // 5. #31 数字一致性：Issue 总数取唯一事实源，用例数取实际跑出来的用例数。
  const counted = countTests(root);
  if (!counted.ok) {
    errors.push(`用例数没能取到：${counted.errors.join('；')}`);
  }
  errors.push(...checkNumbers(root, EXPECTED_COUNT, counted.total));

  return {
    ok: errors.length === 0,
    links: links.length,
    docs: docs.length,
    issueCount: EXPECTED_COUNT,
    testCount: counted.total,
    errors,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const out = checkDocs();
  if (out.ok) {
    console.log(`docs-check: PASS (links=${out.links} docs=${out.docs} issues=${out.issueCount} cases=${out.testCount})`);
  } else {
    console.error(`docs-check: FAIL (links=${out.links} docs=${out.docs} issues=${out.issueCount} cases=${out.testCount})`);
    for (const e of out.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}
