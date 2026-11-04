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

// 定时器接口可以注入，测试才能用假时钟控制「什么时候触发、延迟多少」，
// 不必真的等到 00:05（生产环境走默认的全局 setTimeout/clearTimeout）。
export function startScheduler(db, {
  now = new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const state = { running: true, lastRunAt: null, lastResult: null, lastError: null };

  // 一次失败不该掐断每日链：记下错误，下一棒照排。
  // 与 AI worker 的 state.lastError 同一套范式，/api/health 会把 scheduler 整份透出。
  const tick = () => {
    try {
      state.lastResult = runDaily(db);
      state.lastRunAt = nowIso();
      state.lastError = null;
    } catch (error) {
      state.lastError = error?.message ?? String(error);
    }
  };

  tick(); // 启动补算一次，容器重启不漏

  let timer = null;
  const schedule = (delay) => {
    timer = setTimer(() => {
      if (!state.running) return; // stop() 之后不再自动跑
      tick();
      if (!state.running) return; // tick 期间被 stop() 了，不再排下一棒
      schedule(nextRunDelay());
    }, delay);
  };
  schedule(nextRunDelay(now));

  return {
    state,
    runNow: tick,
    stop() {
      state.running = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
