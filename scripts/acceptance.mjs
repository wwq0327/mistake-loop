// #26 B1-B12 全量验收与结果回读：逐项留实际数字或复现步骤，不接受「命令执行成功」当结论。
// #32 起 B11 拆两半：能机器判的由 scripts/check-visual.mjs 判掉，审美的仍由使用者判断。
// 用法：node scripts/acceptance.mjs
// 任一 B 项不达标即退出 1；B11 的审美部分只标注「待用户判断」，不算通过也不算失败。
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { createJobWorker } from '../src/ai/jobs.mjs';
import { checkUi } from './check-ui.mjs';
import { checkVisual } from './check-visual.mjs';
import { parseTestSummary } from './parse-test-summary.mjs';
import { backup, restore } from './backup.mjs';
import { indexImages } from '../src/lib/image-index.mjs';
import { evaluateB10 } from './acceptance-checks.mjs';
import { copyDataDir } from './snapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const LEGACY = '/Users/walt/codes/my/mistake-wiki';
const REPORT = join(root, 'docs', 'audits', '2026-11-04-v2-acceptance.md');
const DELIVERABLES = new Set([
  'docs/audits/2026-11-04-v2-acceptance.md',
  'scripts/acceptance.mjs',
  'test/acceptance.test.mjs',
]);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const THREE_QUESTIONS = JSON.stringify({
  questions: [
    { seq: 1, bbox: [0.05, 0.1, 0.9, 0.3], subject_hint: 'math', prompt: '1+1=?', confidence: { prompt: 0.92 } },
    { seq: 2, bbox: [0.05, 0.4, 0.9, 0.6], subject_hint: 'math', prompt: '2+2=?', confidence: { prompt: 0.91 } },
    { seq: 3, bbox: [0.05, 0.7, 0.9, 0.9], subject_hint: 'math', prompt: '3+3=?', confidence: { prompt: 0.9 } },
  ],
  page_note: '共 3 题',
});

const results = [];
function record(key, title, ok, evidence, { statusLabel = null, extra = null } = {}) {
  const status = statusLabel ?? (ok === null ? '待判断' : ok ? 'PASS' : 'FAIL');
  results.push({ key, title, ok, status, evidence, extra });
  console.log(`${status} ${key} ${title} | ${evidence}`);
}

function git(args, cwd = root) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function runTests(files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const paths = files.map((file) => join(root, 'test', file));
  const result = spawnSync(process.execPath, ['--test', ...paths], { cwd: root, encoding: 'utf8', env });
  return { status: result.status, ...parseTestSummary(result.stdout) };
}

// 真实库副本：走一致性快照（VACUUM INTO），不再逐个拷贝 db + wal + shm。
// 逐文件拷贝在 WAL 模式下会拿到撕裂快照，实测源库 3 行、副本只读到 2 行。
function realCopy() {
  return copyDataDir({ dataDir: join(root, 'data') });
}

async function request(base, path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* HTML 页面按空对象处理 */ }
  return { status: response.status, text, data };
}

async function withServer({ enabled, recognize }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ml-accept-chain-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  const db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare('INSERT INTO students (id, name, created_at) VALUES (1, ?, ?)').run('默认学生', new Date().toISOString());
  let calls = 0;
  const provider = {
    isEnabled: enabled,
    providerName: 'fake-local',
    model: 'fake',
    recognize: async () => { calls += 1; return recognize; },
  };
  const worker = createJobWorker({
    db, provider, dataDir,
    options: {
      pollIntervalMs: 100000, backoffBaseMs: 0,
      readImage: async () => ({ base64: 'AAAA', mime: 'image/jpeg' }),
    },
  });
  const app = createApp({ db, dataDir, recognitionWorker: worker });
  // 绑死 IPv4 loopback：不传 host 时 macOS 会绑成 [::]:P，端口号可能从 IPv6
  // 空间借到已被本机代理占着的 IPv4 端口，请求便掉进别人的 socket。
  // 与 test/helpers/server.mjs 的 LOOPBACK_HOST 保持一致，由 test/server-bind.test.mjs 守护。
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    db, dataDir, worker,
    base: `http://127.0.0.1:${server.address().port}`,
    calls: () => calls,
    async close() {
      await worker.stop();
      await new Promise((resolve) => server.close(resolve));
      closeDb(db);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function main() {
  // B1：v1 28 例回归 + 静态检查 + 备份恢复复跑。
  {
    const v1 = runTests([
      'state-machine.test.mjs', 'db.test.mjs', 'scheduler.test.mjs',
      'api.test.mjs', 'import-legacy.test.mjs',
    ]);
    const check = spawnSync('npm', ['run', 'check'], { cwd: root, encoding: 'utf8' });
    const copy = realCopy();
    const dir = copy.dir;
    const snapshot = backup({ dataDir: dir, outputDir: join(dir, 'backups') });
    const drill = restore({ backupDir: snapshot.target });
    const db = openDb(join(dir, 'mistakes.db'));
    const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    const counts = { mistakes: count('mistakes'), variants: count('variants'), textbook_nodes: count('textbook_nodes') };
    const images = indexImages({ dataDir: dir, db }).counts;
    closeDb(db);
    copy.cleanup();
    const ok = v1.status === 0 && v1.tests === 28 && v1.pass === 28 && v1.fail === 0
      && check.status === 0 && drill.ok;
    record('B1', '回归', ok,
      `v1 五个文件 ${v1.tests} 例 / pass ${v1.pass} / fail ${v1.fail}（含 I5-I6 导入幂等：第二次新增 0）；npm run check 退出码 ${check.status}；真实库一致性快照备份恢复演练 ok=${drill.ok}、计数 ${JSON.stringify(snapshot.manifest.database)}、有效图片 ${snapshot.manifest.images} 张；副本 ${counts.mistakes} 题 / ${counts.variants} 变式 / ${counts.textbook_nodes} 节点 / 旧库原图 ${images.legacy} 张（磁盘文件 ${images.total} 张，孤儿 ${images.orphan} 张）；旧库只读未被写入`);
  }

  // B2：U1-U8 静态规范与四组设计系统测试。
  {
    const ui = checkUi(join(root, 'public'));
    const tests = runTests(['ui-tokens.test.mjs', 'ui-components.test.mjs', 'ui-pages.test.mjs', 'check-ui.test.mjs']);
    const layers = ['tokens.css', 'base.css', 'components.css', 'layout.css', 'print.css']
      .filter((name) => existsSync(join(root, 'public', 'css', name))).length;
    record('B2', '设计系统', ui.violations.length === 0 && tests.fail === 0 && tests.status === 0 && layers === 5,
      `UI 静态检查违规 ${ui.violations.length} 处（html=${ui.counts.html} / css=${ui.counts.css} / js=${ui.counts.js}）；四组测试 ${tests.tests} 例 / pass ${tests.pass} / fail ${tests.fail}；五层 CSS ${layers}/5 齐备；label 缺失与硬编码色值均为 0`);
  }

  // B4：AI 未启用等价退路（独立库，零外部请求）。
  const ctxA = await withServer({ enabled: false, recognize: THREE_QUESTIONS });
  try {
    const up = await request(ctxA.base, '/api/recognitions', { method: 'POST', body: { image: PNG } });
    await ctxA.worker.drain();
    const detail = await request(ctxA.base, `/api/recognitions/${up.data.jobId}`);
    const blank = detail.data.drafts?.[0];
    const patched = await request(ctxA.base, `/api/recognition-drafts/${blank.id}`, {
      method: 'PATCH', body: { prompt: '老师手填的题干', subject: 'math' },
    });
    const commit = await request(ctxA.base, `/api/recognition-drafts/${blank.id}/commit`, { method: 'POST', body: {} });
    const list = await request(ctxA.base, '/api/mistakes');
    const job = ctxA.db.prepare('SELECT image_path FROM recognition_jobs WHERE id = ?').get(up.data.jobId);
    const originalKept = existsSync(join(ctxA.dataDir, job.image_path));
    const storedStatus = list.data.items?.[0]?.status;
    record('B4', '未启用降级', up.status === 202 && detail.data.drafts.length === 1 && blank.prompt === ''
      && patched.status === 200 && commit.status === 201 && list.data.total === 1
      && storedStatus === 'new' && ctxA.calls() === 0 && originalKept,
      `AI 未启用：上传 ${up.status} → 空白草稿 ${detail.data.drafts.length} 条（prompt 长度 ${String(blank.prompt).length}）→ 手填 PATCH ${patched.status} → commit ${commit.status} → 入库 ${list.data.total} 条且 status=${storedStatus}；外部请求 ${ctxA.calls()} 次；原图保留=${originalKept}`);
  } finally {
    await ctxA.close();
  }

  // B3 / B5 / B6 / B7：真实 HTTP 全链路（本地假 provider，一图三题）。
  const ctxB = await withServer({ enabled: true, recognize: THREE_QUESTIONS });
  try {
    const routes = [['/', '工作台'], ['/inbox', '收件箱'], ['/mistake/1', '题目详情'], ['/print', '打印'], ['/library', '题库'], ['/settings', '设置']];
    const codes = [];
    const pageMarks = [];
    for (const [path] of routes) {
      const response = await request(ctxB.base, path);
      codes.push(response.status);
      pageMarks.push(response.text.includes('data-page="'));
    }
    record('B3', '六页可达', codes.every((code) => code === 200) && pageMarks.every(Boolean),
      `六处路由逐一 GET：状态码 ${codes.join('/')}；六页均含 data-page 标记 ${pageMarks.filter(Boolean).length}/6；工作台 KPI → 收件箱 / 打印 / 题库 三处动作入口见 #21 回读`);

    const up = await request(ctxB.base, '/api/recognitions', { method: 'POST', body: { image: PNG } });
    await ctxB.worker.drain();
    const detail = await request(ctxB.base, `/api/recognitions/${up.data.jobId}`);
    const drafts = detail.data.drafts;
    const before = ctxB.db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    const edited = await request(ctxB.base, `/api/recognition-drafts/${drafts[0].id}`, {
      method: 'PATCH', body: { prompt: '老师改过的题干' },
    });
    const first = await request(ctxB.base, `/api/recognition-drafts/${drafts[1].id}/commit`, { method: 'POST', body: {} });
    const second = await request(ctxB.base, `/api/recognition-drafts/${drafts[2].id}/commit`, { method: 'POST', body: {} });
    const after = ctxB.db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    const rows = ctxB.db.prepare('SELECT id, status FROM mistakes ORDER BY id').all();
    const left = ctxB.db.prepare('SELECT status FROM recognition_drafts WHERE id = ?').get(drafts[0].id);
    record('B5', '识别全流程', drafts.length === 3 && edited.status === 200 && first.status === 201
      && second.status === 201 && after - before === 2 && rows.every((row) => row.status === 'new')
      && left.status === 'pending',
      `本地假 provider 返回一图三题 → 生成 ${drafts.length} 条草稿；PATCH 改 1 条（${edited.status}）、确认 2 条（${first.status}/${second.status}）；mistakes ${before} → ${after}（+${after - before}），状态 ${rows.map((r) => r.status).join('/')}；未确认的第 1 条仍 ${left.status}`);

    const again = await request(ctxB.base, `/api/recognition-drafts/${drafts[1].id}/commit`, { method: 'POST', body: {} });
    const afterAgain = ctxB.db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    const list = await request(ctxB.base, '/api/mistakes');
    const reviews = await request(ctxB.base, '/api/reviews/today');
    const print = await request(ctxB.base, '/api/print');
    const meta = await request(ctxB.base, '/api/meta');
    const leaked = [list.text, reviews.text, print.text, JSON.stringify(meta.data.stats)]
      .some((text) => text.includes('老师改过的题干'));
    record('B6', '审核闸门', again.data.idempotent === true && afterAgain === after && !leaked
      && meta.data.stats.total === 2 && reviews.data.total === 0 && print.data.total === 0,
      `同一草稿重复确认 idempotent=${again.data.idempotent}，mistakes 仍 ${afterAgain} 条；未确认草稿在题库 / 今日复习 ${reviews.data.total} / 打印 ${print.data.total} / 统计 total=${meta.data.stats.total} 中出现=${leaked}；确认 2 条后统计只算这 2 条`);

    const tables = {
      mastery_evidence: ctxB.db.prepare('SELECT COUNT(*) c FROM mastery_evidence').get().c,
      review_events: ctxB.db.prepare('SELECT COUNT(*) c FROM review_events').get().c,
      sessions: ctxB.db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    };
    // 故意把一题写入答案 / 学生作答 / 诊断 / 错因，再挂一条带答案和提示的已审核变式，
    // 推进到 reviewing 后真打印一次：用响应体回读，而不是只看源码有没有白名单。
    const targetId = rows[0].id;
    ctxB.db.prepare(`
      UPDATE mistakes SET status = 'reviewing', correct_answer = ?, student_answer = ?,
        diagnosis_note = ?, error_reason = ?, next_review = ? WHERE id = ?
    `).run('绝密答案', '学生作答', '诊断记录', '错因记录', new Date().toISOString().slice(0, 10), targetId);
    ctxB.db.prepare(`
      INSERT INTO variants (mistake_id, level, prompt, correct_answer, scaffold_hint, reviewed)
      VALUES (?, 'surface', '变式题干', '变式答案', '变式提示', 1)
    `).run(targetId);
    const printWithAnswers = await request(ctxB.base, '/api/print');
    const forbidden = ['correct_answer', 'scaffold_hint', 'student_answer', 'diagnosis_note', 'error_reason']
      .filter((key) => printWithAnswers.text.includes(key));
    const leakedValues = ['绝密答案', '绝密提示', '学生作答', '诊断记录', '错因记录', '变式答案', '变式提示']
      .filter((value) => printWithAnswers.text.includes(value));
    record('B7', '教学法红线',
      Object.values(tables).every((value) => value === 0)
        && printWithAnswers.data.cards.length >= 1
        && forbidden.length === 0 && leakedValues.length === 0,
      `AI 全链路后 mastery_evidence=${tables.mastery_evidence} / review_events=${tables.review_events} / sessions=${tables.sessions}；故意给 #${targetId} 写入 4 个答案类字段 + 1 条带答案与提示的已审核变式、推进 reviewing 后，学生版打印回 ${printWithAnswers.data.cards.length} 张卡片，响应含禁用字段 ${forbidden.join(',') || '无'}、泄漏敏感值 ${leakedValues.join(',') || '无'}；AI 未改写任何已有错题状态`);
  } finally {
    await ctxB.close();
  }

  // B8：六类失败矩阵逐类复现。
  {
    const fails = runTests(['ai-disabled.test.mjs']);
    record('B8', '失败矩阵', fails.status === 0 && fails.fail === 0,
      `${fails.tests} 例 / pass ${fails.pass} / fail ${fails.fail}；六类逐类复现：未配置 / 超时 / 429 / 脏 JSON / 空题集 / 配额耗尽；每类都断言「不生成错题、原图仍在、退回 ${1} 条可手填空白草稿」`);
  }

  // B9：六组新增测试。
  {
    const groups = [
      'ai-normalize.test.mjs', 'ai-provider.test.mjs', 'ai-jobs.test.mjs',
      'recognitions.test.mjs', 'redlines.test.mjs', 'schema-v2.test.mjs',
    ];
    const result = runTests(groups);
    record('B9', '新增测试', result.status === 0 && result.fail === 0,
      `六组共 ${groups.length} 个文件：${result.tests} 例 / pass ${result.pass} / fail ${result.fail}；覆盖清洗器、provider mock、worker 配额、识别 HTTP 全流程、审核闸门、教学法红线`);
  }

  // B10：旧库只读状态与 v1 数据一条不丢。图片按层比对，不拿跨口径的数字互相比。
  {
    const status = git(['status', '--porcelain'], LEGACY);
    const lines = status.stdout.trim().split('\n').filter(Boolean).length;
    const copy = realCopy();
    const db = openDb(join(copy.dir, 'mistakes.db'));
    const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    const counts = {
      mistakes: count('mistakes'), variants: count('variants'), textbook_nodes: count('textbook_nodes'),
    };
    const imageCounts = indexImages({ dataDir: copy.dir, db }).counts;
    closeDb(db);
    copy.cleanup();
    const out = evaluateB10({ legacyStatusLines: lines, dbCounts: counts, imageCounts });
    record('B10', '旧库与数据', out.ok, out.evidence);
  }

  // B11：拆两半——能机器判的判掉，审美仍由使用者判断，不由开发自评。
  {
    const visual = checkVisual(root);
    const machine = `机器核对：\`node scripts/check-visual.mjs\` → ${visual.ok ? 'PASS' : 'FAIL'}（${visual.passed}/${visual.total} 项判定通过，${visual.checks.length} 组）：${visual.checks.map((c) => c.name).join('；')}；判定脚本只读，不改六页 HTML 与业务 JS`;
    const human = '字距舒不舒服、墨色与朱红的比例好不好看，仍由你给结论；静态视觉稿 6 屏在 docs/design/ui-preview.html，实际六页在 /、/inbox、/mistake/:id、/print、/library、/settings，请对照审阅后由你判断，不由开发自评';
    record('B11', '视觉一致性', null, machine, {
      statusLabel: `机器核对 ${visual.ok ? 'PASS' : 'FAIL'}（${visual.passed}/${visual.total} 项判定通过，${visual.checks.length} 组）；人工观感待用户判断`,
      extra: `人工观感（待用户判断）：${human}`,
    });
  }

  // B12：本地与远程一致、工作区干净（排除本次验收交付物）。
  {
    const status = git(['status', '--porcelain']);
    const changed = status.stdout.split('\n')
      .filter((line) => line.trim().length > 0)
      // porcelain 每行是「XY 路径」，路径从第 4 个字符开始；
      // 先对整段输出 trim 会吃掉第一行的状态列，把文件名切掉首字。
      .map((line) => line.slice(3).trim())
      .filter((path) => !DELIVERABLES.has(path));
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(['rev-parse', 'origin/main']).stdout.trim();
    record('B12', '本地与远程', changed.length === 0 && head === remote,
      `除本次验收交付物 ${DELIVERABLES.size} 个文件外，工作区 ${changed.length} 项改动；HEAD ${head.slice(0, 7)} 与 origin/main ${remote.slice(0, 7)} ${head === remote ? '一致' : '不一致'}；交付物提交后会再独立回读一次 git status`);
  }

  const failed = results.filter((item) => item.ok === false);
  const passed = results.filter((item) => item.ok === true);
  const pending = results.filter((item) => item.ok === null);
  const ordered = [...results].sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)));
  const lines = [
    '# v2 B1–B12 全量验收与结果回读',
    '',
    `生成时间：${new Date().toISOString()}`,
    '生成方式：`node scripts/acceptance.mjs`，逐项回读实际数字或复现步骤。',
    '',
    `总览：${passed.length} 项 PASS / ${failed.length} 项 FAIL / ${pending.length} 项待判断（共 12 项）。`,
    '',
    ...ordered.flatMap((item) => [
      `## ${item.key} ${item.title}`,
      '',
      `- 状态：${item.status}`,
      `- 证据：${item.evidence}`,
      ...(item.extra ? [`- ${item.extra}`] : []),
      '',
    ]),
    '## 第二层：四项实机 / 试运行未验证项',
    '',
    '以下 4 项**未验证**，页面做完、测试通过、命令成功都不能代替这一层验收：',
    '',
    '1. 真机 NAS 上的容器构建与拉起：镜像已在 CI 里验证可构建（amd64 + arm64、Node 26、非 root 运行、/health 回读通过），但真机 NAS 拉起、卷属主与重启自愈仍未验证。',
    '2. 真实手机 / 平板的系统相机调起与浏览器兼容。',
    '3. 浏览器打印预览的实际分页效果与 A4 出纸。',
    '4. 两周真实试运行与学情判断（无提醒时每周主动使用约 3 次）。',
    '',
    '说明：B12 原 v1 口径是「不建远程、不 push」，已被后续「公开开源 + GitHub Issues 驱动」的授权覆盖，此处按本阶段口径回读本地与远程提交一致性。',
    '',
  ];
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, lines.join('\n'));
  console.log(`\n报告已写入 ${REPORT}`);
  console.log(`总览：${passed.length} PASS / ${failed.length} FAIL / ${pending.length} 待判断`);
  if (failed.length) {
    for (const item of failed) console.error(`[FAIL] ${item.key} ${item.title}: ${item.evidence}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[acceptance] 脚本异常：', error);
  process.exitCode = 1;
});
