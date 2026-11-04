// #18 / #19 测试先行：识别收件箱的左图右表核对与逐题确认交互。
// 浏览器交互无法在 Node 里跑 DOM，故用静态 DOM + 源码契约断言，配合 API 侧真实链路测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'public', 'inbox.html'), 'utf8');
const js = () => (existsSync(join(root, 'public', 'js', 'pages', 'inbox.js'))
  ? readFileSync(join(root, 'public', 'js', 'pages', 'inbox.js'), 'utf8') : '');

test('#18 收件箱静态骨架含图区、识别框叠层、草稿表单、降级入口与上传控件', () => {
  for (const id of ['inbox-upload', 'inbox-figure', 'inbox-bboxes', 'inbox-drafts', 'inbox-fallback']) {
    assert.ok(html.includes(`id="${id}"`), `inbox.html 缺 #${id}`);
  }
  assert.match(html, /<label\s+for="inbox-file"/, '上传控件缺 label');
  assert.match(html, /<img\b/, '图区没有 img 元素');
});

test('#18 原图带相对坐标识别框，点框定位对应草稿', () => {
  const source = js();
  assert.ok(source, 'inbox.js 不存在');
  assert.match(source, /\.bbox\b/, '缺识别框组件类');
  assert.match(source, /style\.left|style\.top|style\.width|style\.height/, '识别框未按相对坐标定位');
  assert.match(source, /%/, '识别框未用百分比相对坐标');
  assert.match(source, /scrollIntoView|focus\(/, '点框未定位到对应草稿');
});

test('#18 低置信度字段留空并标「请手填」，不预填猜测值', () => {
  const source = js();
  assert.match(source, /confidence--low/, '缺低置信度视觉标记');
  assert.match(source, /请手填/, '缺「请手填」提示文案');
  assert.match(source, /uncertain/, '未按 uncertain 字段判定');
  assert.match(source, /value\s*=\s*''/, '低置信度字段没有留空');
});

test('#18 可裁剪单题重识别、删除与合并草稿；失败有手工录入入口', () => {
  const source = js();
  for (const name of ['cropAndRetry', 'discardDraft', 'mergeDrafts']) {
    assert.match(source, new RegExp(`\\b${name}\\b`), `缺交互函数 ${name}`);
  }
  assert.match(source, /改为手工录入|手工录入/, '缺降级入口文案');
  assert.match(source, /\/api\/recognitions/, '未引用识别上传接口');
  assert.match(source, /\/api\/recognition-drafts\//, '未引用草稿接口');
});

test('#33 草稿可拆成另一题：按题干选区拆分，有选区校验', () => {
  const source = js();
  assert.match(source, /\bsplitDraft\b/, '缺拆分交互函数');
  assert.match(source, /selectionStart/, '没有读取题干选区起点');
  assert.match(source, /selectionEnd/, '没有读取题干选区终点');
  assert.match(source, /\/recognition-drafts\/\$\{[^}]+\}\/split/, '未调用拆分接口');
  assert.match(source, /拆成另一题/, '缺「拆成另一题」入口文案');
  assert.match(source, /选中/, '缺选区校验提示');
});

test('#18 页面仍遵守 UI 静态规范（无硬编码色值、无 innerHTML 赋值）', () => {
  const source = js();
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'JS 内出现硬编码色值');
  assert.doesNotMatch(source, /\.innerHTML\s*=/, '出现不安全的 DOM 写入');
  assert.match(html, /data-page="inbox"/);
});

// #19：逐题 / 批量确认的幂等交互与失败重试。
test('#19 提交期防重复点击：在途集合与按钮禁用', () => {
  const source = js();
  assert.match(source, /\binFlight\b/, '缺在途提交集合，连点会重复请求');
  assert.match(source, /\.disabled\s*=\s*true/, '提交时未禁用按钮');
  assert.match(source, /finally/, '提交结束后未恢复按钮');
});

test('#19 逐题确认走 commit，全部确认走 batch-commit', () => {
  const source = js();
  assert.match(source, /\/commit\b/, '未引用逐题 commit 接口');
  assert.match(source, /\/api\/recognition-drafts\/batch-commit/, '未引用批量确认接口');
  assert.match(source, /async function batchCommit/, '缺批量确认函数');
});

test('#19 确认后给出入库编号并能跳到题目详情', () => {
  const source = js();
  assert.match(source, /mistakeId/, '未展示入库编号');
  assert.match(source, /\/mistake\//, '缺题目详情跳转');
  assert.match(source, /link\('看这道题/, '缺跳转链接');
});

test('#19 幂等响应有专门文案，失败项可一键重试', () => {
  const source = js();
  assert.match(source, /idempotent/, '未处理幂等返回');
  assert.match(source, /无需重复确认|已入库/, '幂等结果没有明确文案');
  assert.match(source, /retryFailed/, '缺失败项重试函数');
  assert.match(source, /重试/, '失败提示没有重试说明');
  assert.match(source, /catch/, '确认失败未捕获');
});
