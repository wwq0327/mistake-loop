// #59 测试先行：批量确认的每一条失败都要有中文原因，并说清能不能重试。
//
// 红灯预期：src/lib/draft-failures.mjs 还不存在，模块解析即失败。
//
// 要锁住的三件事：
//   1. 每条失败都带 reason（机器码）、message（中文）、retryable（能不能靠再点一次解决）。
//   2. 中文原因必须具体，不能是「原因不明」的兜底，也不能把机器码原样丢给老师。
//   3. 状态类失败（已处理 / 已不存在）不给重试——原样再试必然同样失败，
//      给按钮就是死循环；输入类失败（没选科目 / 题干空）可以改完再来一次。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { DRAFT_FAILURES, UNKNOWN_FAILURE, draftFailure } from '../src/lib/draft-failures.mjs';

let dataDir, db, server, base;
const ids = {};

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON 按空对象 */ }
  return { status: response.status, data, text };
}

function addDraft(seq, { subject = 'math', prompt = '1+1=?', status = 'pending' } = {}) {
  const info = db.prepare(`
    INSERT INTO recognition_drafts (job_id, seq, subject, prompt, status, created_at)
    VALUES (1, ?, ?, ?, ?, '2026-11-05T00:00:00.000Z')
  `).run(seq, subject, prompt, status);
  return Number(info.lastInsertRowid);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-bcr-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-05T00:00:00.000Z')").run();
  db.prepare(`
    INSERT INTO recognition_jobs (id, image_path, status, created_at)
    VALUES (1, 'images/a.png', 'done', '2026-11-05T00:00:00.000Z')
  `).run();

  ids.ok = addDraft(1);
  ids.noSubject = addDraft(2, { subject: null });
  ids.noPrompt = addDraft(3, { prompt: '' });
  ids.tooLong = addDraft(4, { prompt: '长'.repeat(2001) });
  ids.discarded = addDraft(5, { status: 'discarded' });
  ids.missing = 999999;

  const app = createApp({ db, dataDir });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('#59 批量确认：逐条说清失败原因', () => {
  it('每条失败都带中文原因与可重试标记', async () => {
    const res = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST',
      body: { ids: [ids.ok, ids.noSubject, ids.noPrompt, ids.discarded, ids.missing, 'abc'] },
    });
    assert.equal(res.status, 200, res.text);

    for (const item of res.data.results.filter((r) => !r.ok)) {
      assert.equal(typeof item.reason, 'string', '失败项缺 reason');
      assert.ok(item.reason.length > 0, '失败项的 reason 是空的');
      assert.equal(typeof item.message, 'string', `失败项 ${item.id} 缺中文原因`);
      assert.ok(item.message.trim().length > 0, `失败项 ${item.id} 的中文原因是空的`);
      assert.notEqual(item.message.trim(), item.reason, '中文原因不能就是机器码');
      assert.equal(typeof item.retryable, 'boolean', `失败项 ${item.id} 缺 retryable 标记`);
    }
  });

  it('中文原因必须具体，不能是「原因不明」的兜底', async () => {
    const res = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST',
      body: { ids: [ids.noSubject, ids.noPrompt, ids.tooLong, ids.discarded, ids.missing, 'abc'] },
    });
    for (const item of res.data.results.filter((r) => !r.ok)) {
      assert.notEqual(
        item.message.trim(),
        UNKNOWN_FAILURE.text.trim(),
        `失败项 ${item.id}（${item.reason}）走了兜底文案，说明后端没把它登记进失败原因表`,
      );
      assert.match(item.message, /[一-龥]/, `失败项 ${item.id} 的原因不是中文：${item.message}`);
    }
  });

  it('输入类失败可重试，状态类失败不可重试', async () => {
    const res = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST',
      body: { ids: [ids.noSubject, ids.noPrompt, ids.tooLong, ids.discarded, ids.missing, 'abc'] },
    });
    const by = (id) => res.data.results.find((r) => String(r.id) === String(id));

    assert.equal(by(ids.noSubject).retryable, true, '没选科目：改完就能重来，必须可重试');
    assert.equal(by(ids.noPrompt).retryable, true, '题干为空：填完就能重来，必须可重试');
    assert.equal(by(ids.tooLong).retryable, true, '题干过长：改短就能重来，必须可重试');

    assert.equal(by(ids.discarded).retryable, false, '已处理的草稿原样再试必然同样失败，不该给重试');
    assert.equal(by(ids.missing).retryable, false, '不存在的草稿原样再试必然同样失败，不该给重试');
    assert.equal(by('abc').retryable, false, '编号不对原样再试必然同样失败，不该给重试');
  });

  it('失败原因表里每一项都有中文说法，且没有把机器码写成中文', () => {
    for (const [code, failure] of Object.entries(DRAFT_FAILURES)) {
      assert.equal(typeof failure.text, 'string', `${code} 缺中文说法`);
      assert.ok(failure.text.trim().length > 0, `${code} 的中文说法是空的`);
      assert.match(failure.text, /[一-龥]/, `${code} 的说法不是中文`);
      assert.notEqual(failure.text.trim(), code, `${code} 把机器码原样当成了中文说法`);
      assert.equal(typeof failure.retryable, 'boolean', `${code} 缺 retryable`);
    }
    // 未登记的码走兜底：兜底也必须是中文，且默认不可重试（宁可不给按钮，也别给个死循环）。
    assert.match(UNKNOWN_FAILURE.text, /[一-龥]/, '兜底文案不是中文');
    assert.equal(UNKNOWN_FAILURE.retryable, false, '兜底文案默认给了重试，会变成死循环');
    assert.equal(draftFailure('SOMETHING_NEW').text, UNKNOWN_FAILURE.text);
    assert.equal(draftFailure('SOMETHING_NEW').retryable, false);
  });

  it('逐题确认与批量确认说的是同一句话', async () => {
    // 同一件事、两个入口，说法必须一致：老师从哪条路看到的都是同一句中文。
    // 写两份文案就会漂，漂了就等于「说法」这件事没做。
    const single = await call(`/api/recognition-drafts/${ids.noSubject}/commit`, { method: 'POST', body: {} });
    assert.equal(single.status, 400, single.text);
    assert.equal(
      single.data.error.message,
      DRAFT_FAILURES.SUBJECT_REQUIRED.text,
      '逐题确认的说法与失败原因表对不上',
    );

    const batch = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST', body: { ids: [ids.noSubject] },
    });
    const item = batch.data.results.find((r) => String(r.id) === String(ids.noSubject));
    assert.equal(item.message, single.data.error.message, '批量与逐题的说法不一致');
  });

  it('一条失败不影响其余：成功的照常入库，失败的不写半截数据', async () => {
    // 用一条全新的草稿：前面几条用例已经提交过 ids.ok，
    // 再提交它只会拿到幂等结果，committed 会是 0，测不出「成功的照常入库」。
    const fresh = addDraft(6);
    const before = db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    const res = await call('/api/recognition-drafts/batch-commit', {
      method: 'POST',
      body: { ids: [fresh, ids.noSubject, ids.discarded] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.committed, 1, '只有一条该入库');
    const after = db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;
    assert.equal(after - before, 1, '失败项不该留下错题');

    const ok = res.data.results.find((r) => r.id === fresh);
    assert.equal(ok.ok, true);
    assert.ok(ok.mistakeId > 0, '成功项该给出入库编号');

    const stillPending = db.prepare('SELECT status FROM recognition_drafts WHERE id = ?').get(ids.noSubject);
    assert.equal(stillPending.status, 'pending', '失败项的草稿状态被改动了');
  });
});
