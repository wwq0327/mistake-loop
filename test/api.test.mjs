import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { today, addDays } from '../src/lib/dates.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let dataDir;
let db;
let server;
let base;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ml-api-'));
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT INTO students (id, name, created_at) VALUES (1, '默认学生', '2026-11-04T00:00:00.000Z')").run();
  const app = createApp({
    db,
    dataDir,
    schedulerState: { running: true, lastRunAt: null, lastResult: { date: today(), due: 0, inserted: 0 } },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

describe('API 冒烟：真实 HTTP 全链路', () => {
  it('P1 /health 返回 200 且带调度状态', async () => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.db, 'ok');
    assert.equal(res.data.scheduler.running, true);
  });

  it('P2 /api/meta 统计为实时聚合值', async () => {
    const res = await call('/api/meta');
    assert.equal(res.status, 200);
    assert.equal(res.data.stats.total, 0);
    assert.equal(res.data.stats.byStatus.new, 0);
    assert.ok(Array.isArray(res.data.pendingVariants));
    assert.deepEqual(Object.keys(res.data.errorSubtypes), ['math', 'chinese', 'english']);
  });

  it('P3-P8 录入 → 诊断 → 变式审核 → 逾期队列 → 复习结果 → 学生版打印', async () => {
    // P3 录入（含图片与几何图）
    const created = await call('/api/mistakes', {
      method: 'POST',
      body: {
        subject: 'math',
        prompt: '一条路长 90 米，需要多少块砖？',
        student_answer: '300+2=302',
        correct_answer: '秘密答案：300×2=600',
        image: PNG,
        geometry_spec: { width: 100, height: 50, shapes: [{ type: 'text', x: 5, y: 20, text: '<script>alert(1)</script>' }] },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal(created.data.status, 'new');
    assert.ok(existsSync(join(dataDir, 'images', created.data.image_path.split('/').pop())), '图片应真实落盘');

    // P4 支架式闸门：结论为空不许进 correcting
    const blocked = await call(`/api/mistakes/${id}/diagnosis`, {
      method: 'PATCH',
      body: { status: 'correcting', student_conclusion: '' },
    });
    assert.equal(blocked.status, 409);
    const diagnosed = await call(`/api/mistakes/${id}/diagnosis`, {
      method: 'PATCH',
      body: { status: 'diagnosing', error_category: 'procedural', diagnosis_note: '先把已知条件列出来' },
    });
    assert.equal(diagnosed.status, 200);
    assert.equal(diagnosed.data.status, 'diagnosing');

    // P5 变式审核闸门：未审核不上打印纸，三层审核完才进复习队列
    const variants = await call(`/api/mistakes/${id}/variants`, {
      method: 'POST',
      body: {
        variants: [
          { level: 'surface', prompt: '换数字后的题干', correct_answer: 'A', scaffold_hint: '先看单位' },
          { level: 'structure', prompt: '换角度后的题干' },
          { level: 'context', prompt: '换场景后的题干' },
        ],
      },
    });
    assert.equal(variants.status, 201);
    assert.equal(variants.data.variants.length, 3);
    assert.equal((await call(`/api/print?ids=${id}`)).data.cards[0].variants.length, 0);
    for (const item of variants.data.variants) {
      const reviewed = await call(`/api/variants/${item.id}/review`, { method: 'PATCH', body: { result: 'pass' } });
      assert.equal(reviewed.status, 200);
    }
    const afterReview = await call(`/api/mistakes/${id}`);
    assert.equal(afterReview.data.status, 'reviewing');
    assert.equal(afterReview.data.next_review, addDays(today(), 1));

    // P6 模拟逾期后，今日复习自动出现（不依赖人打开页面之外的额外操作）
    db.prepare('UPDATE mistakes SET next_review = ? WHERE id = ?').run(addDays(today(), -1), id);
    const todayList = await call('/api/reviews/today');
    assert.equal(todayList.status, 200);
    assert.ok(todayList.data.items.some((item) => item.id === id));

    // P7 做对 + 一条掌握证据：事件与证据都落库
    const result = await call(`/api/reviews/${id}/result`, {
      method: 'POST',
      body: { result: 'correct', evidence_type: 'retell', note: '学生自己复述了解法' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.review_round, 1);
    assert.equal(result.data.next_review, addDays(today(), 1));
    const detail = await call(`/api/mistakes/${id}`);
    assert.equal(detail.data.review_events.length, 1);
    assert.equal(detail.data.mastery_evidence.length, 1);
    assert.equal(detail.data.sessions.length > 0, true);

    // P8 学生版打印页不含答案、不含引导提示，且几何图已转义
    const printed = await call(`/api/print?ids=${id}`);
    assert.equal(printed.status, 200);
    const text = JSON.stringify(printed.data);
    for (const forbidden of ['correct_answer', 'scaffold_hint', '秘密答案', '先看单位', '300+2=302']) {
      assert.equal(text.includes(forbidden), false, `学生版不应包含 ${forbidden}`);
    }
    assert.equal(printed.data.cards[0].variants.length, 3);
    assert.ok(printed.data.cards[0].geometry_svg.includes('&lt;script&gt;'), '几何图文本必须转义');

    // 掌握闸门：再做对 3 次到第 4 轮，有证据才 mastered
    for (let i = 0; i < 3; i += 1) {
      const step = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'correct' } });
      assert.equal(step.status, 200);
    }
    const mastered = await call(`/api/mistakes/${id}`);
    assert.equal(mastered.data.status, 'mastered');
    assert.equal(mastered.data.review_round, 4);
    assert.equal(mastered.data.next_review, null);
    const rejected = await call(`/api/reviews/${id}/result`, { method: 'POST', body: { result: 'wrong' } });
    assert.equal(rejected.status, 409);
  });

  it('P9 非法入参返回 400，不泄漏堆栈', async () => {
    const badSubject = await call('/api/mistakes', { method: 'POST', body: { subject: 'physics', prompt: 'x' } });
    assert.equal(badSubject.status, 400);
    assert.ok(badSubject.data.error.code);
    assert.equal((await call('/api/print?mode=teacher')).status, 400);
    assert.equal((await call('/api/mistakes/abc')).status, 400);
    assert.equal((await call('/api/mistakes/999999')).status, 404);
  });
});
