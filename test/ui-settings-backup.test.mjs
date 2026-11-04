// #50 测试先行：设置页的备份结果必须回显恢复演练的图片核对。
// 红灯预期：界面只显示一个图片总数（result.images）加一句「恢复演练 通过/未通过」，
// 演练到底核对了多少张图、缺了哪几张，一个字都没有。
// 背景：#43 给恢复演练加了图片核对（备份丢了照片不再报「恢复成功」），
// 但信息到了接口，界面不显示——新能力被白白浪费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, textOf } from './helpers/dom.mjs';

const dom = installDom();
const { mount } = await import('../public/js/pages/settings.js');

const IDS = [
  'settings-ai-toggle', 'settings-ai-configured', 'settings-ai-usage', 'settings-ai-error',
  'settings-backup-action', 'settings-backup-result', 'settings-health-action', 'settings-health-result',
];

function drillResult(overrides = {}) {
  return {
    ok: true,
    target: 'backup-20261105-120000-000',
    database: { mistakes: 19, variants: 6 },
    images: 19,
    restore: {
      ok: true,
      mismatches: [],
      images: {
        expected: { legacy: 19, derived: 0, root: 0, referenced: 19, orphan: 0, missing: 0 },
        actual: { legacy: 19, derived: 0, root: 0, referenced: 19, orphan: 0, missing: 0 },
        missing: [],
        mismatches: [],
      },
      ...overrides,
    },
  };
}

async function mountWith(result) {
  const root = dom.byId('settings-root');
  const api = async (path) => {
    if (path === '/api/ai/status') {
      return { configured: false, enabled: false, todayUsed: 0, dailyLimit: 30, pendingDrafts: 0, lastError: null };
    }
    if (path === '/api/backup') return result;
    if (path === '/health') return { ok: true };
    if (path === '/api/meta') return { stats: {} };
    throw new Error(`不该调这个接口：${path}`);
  };
  await mount({ root, api });
  return root;
}

test('#50 备份结果要回显恢复演练的图片分层数字', async () => {
  const root = await mountWith(drillResult());
  const button = dom.byId('settings-backup-action');
  await Promise.all(button.click());

  const text = textOf(dom.byId('settings-backup-result'));
  assert.match(text, /恢复演练/, '要说明演练结论');
  assert.match(text, /旧库原图 19 张/, '要回显旧库原图张数');
  assert.match(text, /被引用 19 张/, '要回显被引用张数');
  assert.match(text, /缺文件 0 张/, '要回显缺文件张数');
});

test('#50 演练通过要写「通过」，不通过要写「未通过」并逐条列出差异', async () => {
  const root = await mountWith(drillResult({
    ok: false,
    mismatches: ['备份里缺 2 张被引用的图片：images/legacy/a.png'],
  }));
  const button = dom.byId('settings-backup-action');
  await Promise.all(button.click());

  const text = textOf(dom.byId('settings-backup-result'));
  assert.match(text, /未通过/, '演练失败要写明「未通过」');
  assert.match(text, /缺 2 张/, '要列出差异内容');
  assert.match(text, /images\/legacy\/a\.png/, '要点名缺哪张');
});

test('#50 备份结果不能只报记录数：记录数与图片数要分开说', async () => {
  const root = await mountWith(drillResult());
  const button = dom.byId('settings-backup-action');
  await Promise.all(button.click());

  const text = textOf(dom.byId('settings-backup-result'));
  assert.match(text, /记录数|快照/, '要保留快照与记录数信息');
  assert.doesNotMatch(text, /图片 19 张，恢复演练/, '不能把图片总数与演练结论挤成一句');
});
