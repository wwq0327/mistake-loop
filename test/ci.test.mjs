// #25 测试先行：CI 版本矩阵、check+test 守护、违规 CSS 能让 CI 转红的本地等价验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('#25 CI 工作流跑 npm run check（含 check-ui）与 npm test', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run check/, 'CI 未跑 npm run check');
  assert.match(ci, /npm test/, 'CI 未跑 npm test');
  assert.match(ci, /npm ci/, 'CI 未用锁文件安装');
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.check, /check-ui\.mjs/, 'npm run check 未覆盖 UI 静态规范');
  assert.match(pkg.scripts.check, /check-issue-map\.mjs/, 'npm run check 未覆盖 Issue 映射');
});

test('#25 Node 22 必绿，26 作为前瞻矩阵，fail-fast=false 互不取消', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /strategy:/, '缺 strategy');
  assert.match(ci, /fail-fast:\s*false/, '一个版本失败会取消另一个，22 不一定跑完');
  assert.match(ci, /matrix:/, '缺版本矩阵');
  assert.match(ci, /node:\s*\[[^\]]*'22'[^\]]*\]/, '矩阵缺 Node 22');
  assert.match(ci, /node:\s*\[[^\]]*'26'[^\]]*\]/, '矩阵缺 Node 26 前瞻验证');
  assert.match(ci, /node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/, 'setup-node 未用矩阵版本');
});

test('#25 CI 最小权限与并发收敛', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /permissions:/, '缺最小权限声明');
  assert.match(ci, /contents:\s*read/, '权限未收紧到只读');
  assert.match(ci, /concurrency:/, '缺并发收敛');
});

// Node 22 的 node:test 输出 `# pass 28`，Node 26 输出 `ℹ pass 28`。
// 真实 CI run 41836692050 在 Node 26 上因硬编码 TAP 前缀红了，故先把解析契约写成测试。
test('#25 Node 22/26 两种 reporter 都能解析出同一份 v1 回归摘要', async () => {
  const mod = await import('../scripts/parse-test-summary.mjs');
  assert.equal(typeof mod.parseTestSummary, 'function', '缺跨版本摘要解析函数');
  const tap22 = '# tests 28\n# suites 6\n# pass 28\n# fail 0\n';
  const spec26 = 'ℹ tests 28\nℹ suites 6\nℹ pass 28\nℹ fail 0\n';
  assert.deepEqual(mod.parseTestSummary(tap22), { tests: 28, pass: 28, fail: 0 });
  assert.deepEqual(mod.parseTestSummary(spec26), { tests: 28, pass: 28, fail: 0 });
  assert.equal(mod.parseTestSummary('ℹ pass 27\nℹ fail 1\n').fail, 1, '解析不出失败数会放过回归红灯');
});

test('#25 v1 回归检查不再硬编码单一 reporter 前缀', () => {
  const source = read('test/redlines.test.mjs');
  assert.match(source, /parseTestSummary/, '未使用跨版本摘要解析');
  assert.doesNotMatch(source, /# pass 28/, '仍硬编码 Node 22 的 TAP 前缀');
  assert.doesNotMatch(source, /# fail 0/, '仍硬编码 Node 22 的 TAP 前缀');
});

test('#25 本地违规样例：check-ui 退出码 1，等价于 CI 转红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ml-ci-violation-'));
  try {
    writeFileSync(join(dir, 'bad.css'), '.bad { color: #ff0000; }\n');
    const result = spawnSync(process.execPath, ['scripts/check-ui.mjs', '--root', dir], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, '违规 CSS 没有让检查失败');
    assert.match(result.stdout, /硬编码色值/, '未报出具体违规项');
    assert.match(result.stdout, /ui-check:\s*FAIL/, '未输出 FAIL 结论');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #29 CI 迁到 Node 24 runtime，并把容器构建纳入 CI ───────────────────────

test('#29 CI 不再使用任何 node20 runtime 的 action 版本', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /actions\/checkout@v[1-4]\b/, '仍用 node20 runtime 的 checkout');
  assert.doesNotMatch(ci, /actions\/setup-node@v[1-4]\b/, '仍用 node20 runtime 的 setup-node');
  assert.match(ci, /actions\/checkout@v[5-9]/, 'checkout 未升到 node24 runtime 的主版本');
  assert.match(ci, /actions\/setup-node@v[5-9]/, 'setup-node 未升到 node24 runtime 的主版本');
});

test('#29 CI 里有独立的多架构容器构建 job', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /docker\/setup-qemu-action@v4/, '缺 QEMU（arm64 模拟运行）');
  assert.match(ci, /docker\/setup-buildx-action@v4/, '缺 buildx');
  assert.match(ci, /docker\/build-push-action@v[6-9]/, '缺 build-push-action');
  assert.match(ci, /platforms:\s*linux\/amd64,\s*linux\/arm64/, '没有同时构建 amd64 与 arm64');
  assert.doesNotMatch(ci, /push:\s*true/, 'CI 不得推送镜像到 registry');
  assert.match(ci, /check-oci-platforms\.mjs/, '没有用脚本回读多架构产物');
});

test('#29 容器构建 job 里必须真的跑一次容器并回读 /health', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /docker run/, '没有真正跑起容器');
  assert.match(ci, /\/health/, '没有回读 /health');
  assert.match(ci, /db.*ok|"db":"ok"/, '没有断言健康响应里的 db=ok');
});

test('#29 Dockerfile 以非 root 用户跑 node:26-slim，并暴露 8080', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /FROM node:26-slim/, '基础镜像不是 node:26-slim');
  assert.match(dockerfile, /^USER node$/m, '容器没有切到非 root 用户');
  assert.match(dockerfile, /EXPOSE 8080/, '没有暴露 8080');
  assert.match(dockerfile, /npm ci --omit=dev/, '生产镜像没有只装运行期依赖');
});
