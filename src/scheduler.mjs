import { withTransaction } from './db.mjs';
import { today, nowIso, nextRunDelay } from './lib/dates.mjs';

// 系统常开的价值在这里：不靠人打开页面，每天自己把到期题留痕。
// next_review 在无人提交结果时不被改写（迟到不重置）。
export function runDaily(db, { date = today(), at = nowIso() } = {}) {
  const rows = db.prepare(`
    SELECT id FROM mistakes
    WHERE status = 'reviewing'
      AND next_review IS NOT NULL
      AND next_review <= ?
    ORDER BY next_review, id
  `).all(date);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO sessions (mistake_id, kind, due_on, started_at)
    VALUES (?, 'due', ?, ?)
  `);
  let inserted = 0;
  withTransaction(db, () => {
    for (const row of rows) inserted += insert.run(row.id, date, at).changes;
  });
  return { date, due: rows.length, inserted };
}

export function startScheduler(db, { now = new Date() } = {}) {
  const state = { running: true, lastRunAt: null, lastResult: null };
  const tick = () => {
    state.lastResult = runDaily(db);
    state.lastRunAt = nowIso();
  };

  tick(); // 启动补算一次，容器重启不漏

  let timer;
  const schedule = () => {
    timer = setTimeout(() => {
      tick();
      schedule();
    }, nextRunDelay());
  };
  timer = setTimeout(() => {
    tick();
    schedule();
  }, nextRunDelay(now));

  return {
    state,
    runNow: tick,
    stop() {
      clearTimeout(timer);
      state.running = false;
    },
  };
}
