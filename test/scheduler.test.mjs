import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { runDaily } from '../src/scheduler.mjs';
import { nextRunDelay } from '../src/lib/dates.mjs';

const DAY = '2026-11-04';
const AT = '2026-11-04T00:05:00.000Z';

function makeDb() {
  const db = openDb(':memory:');
  migrate(db);
  const insert = db.prepare(`
    INSERT INTO mistakes (subject, prompt, status, review_round, next_review, created_at, updated_at)
    VALUES ('math', ?, ?, ?, ?, ?, ?)
  `);
  const ids = {};
  ids.due = Number(insert.run('到期题', 'reviewing', 1, '2026-11-01', AT, AT).lastInsertRowid);
  ids.future = Number(insert.run('未到期题', 'reviewing', 1, '2026-12-01', AT, AT).lastInsertRowid);
  ids.mastered = Number(insert.run('已掌握题', 'mastered', 4, '2026-11-01', AT, AT).lastInsertRowid);
  ids.diagnosing = Number(insert.run('诊断中题', 'diagnosing', 0, '2026-11-01', AT, AT).lastInsertRowid);
  return { db, ids };
}

describe('常驻调度：每日自动推进', () => {
  it('C1 启动补算把到期题写入 due 会话', () => {
    const { db, ids } = makeDb();
    const result = runDaily(db, { date: DAY, at: AT });
    assert.equal(result.due, 1);
    assert.equal(result.inserted, 1);
    const rows = db.prepare("SELECT mistake_id FROM sessions WHERE kind='due'").all();
    assert.deepEqual(rows.map((r) => r.mistake_id), [ids.due]);
    closeDb(db);
  });

  it('C2 同日重复执行不重复插入', () => {
    const { db } = makeDb();
    runDaily(db, { date: DAY, at: AT });
    const second = runDaily(db, { date: DAY, at: AT });
    assert.equal(second.due, 1);
    assert.equal(second.inserted, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE kind='due'").get().c, 1);
    closeDb(db);
  });

  it('C3/C4 未到期、已掌握、诊断中的题都不入队', () => {
    const { db, ids } = makeDb();
    runDaily(db, { date: DAY, at: AT });
    const queued = db.prepare("SELECT mistake_id FROM sessions WHERE kind='due'").all().map((r) => r.mistake_id);
    for (const key of ['future', 'mastered', 'diagnosing']) {
      assert.equal(queued.includes(ids[key]), false, `${key} 不应入队`);
    }
    closeDb(db);
  });

  it('C5 下次运行时间落在 (0, 24h]，且按上海时区算到 00:05', () => {
    for (const iso of ['2026-11-04T15:00:00.000Z', '2026-11-04T16:04:00.000Z', '2026-11-04T18:00:00.000Z']) {
      const delay = nextRunDelay(new Date(iso));
      assert.ok(delay > 0 && delay <= 86400000, `${iso} -> ${delay}`);
    }
    // 本地 23:00 到次日 00:05 = 65 分钟
    assert.equal(nextRunDelay(new Date('2026-11-04T15:00:00.000Z')), 65 * 60000);
  });
});
