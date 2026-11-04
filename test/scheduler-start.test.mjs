// #55 测试先行：常驻调度器本身要能被测。
//
// 红灯背景：test/scheduler.test.mjs 只 import 了 runDaily，
// startScheduler 从来没被测过——而「让状态自己往前走」是本项目的核心承诺
// （AGENTS.md），其中「容器重启不漏」全靠 startScheduler 里的启动补算。
// 变异验证：把那行删掉，原有 361 例全绿，没有任何测试锁住它。
//
// 本文件用一套假时钟（不真的等到 00:05，也不篡改全局 setTimeout）：
// 定时器接口注入进 startScheduler，测试自己掌握「什么时候触发、延迟多少」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, closeDb } from '../src/db.mjs';
import { startScheduler } from '../src/scheduler.mjs';
import { nextRunDelay } from '../src/lib/dates.mjs';

// 兜底：被测代码若还没接上注入的假时钟、走了全局 setTimeout，
// 那条真定时器会挂几个小时，把测试进程吊死——报出来的是「超时」，
// 而不是「哪条断言红了」，等于把红灯变成了噪音。
// 给全局定时器加 unref，进程仍能退出，失败就会以断言的形式报出来。
// （node --test 每个文件一个进程，这个补丁只影响本文件。）
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const timer = realSetTimeout(...args);
  timer.unref?.();
  return timer;
};

const AT = '2026-11-05T00:05:00.000Z';

// 上海时间 23:00 —— 距下一个本地 00:05 正好 65 分钟。
const NOW_23H = new Date('2026-11-04T15:00:00.000Z');
// 上海时间次日 00:04:30 —— 距 00:05 还有 30 秒。
const NOW_000430 = new Date('2026-11-04T16:04:30.000Z');

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

// 假时钟：记录每次排的定时器（回调 + 延迟），测试自己决定何时触发。
// 用「取出即移除」模拟真实定时器：触发过的那条不再算在待触发队列里。
function fakeClock() {
  const pending = [];
  let seq = 0;
  return {
    setTimer(fn, delay) {
      seq += 1;
      const id = seq;
      pending.push({ id, fn, delay });
      return id;
    },
    clearTimer(id) {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    live: () => pending.length,
    delays: () => pending.map((p) => p.delay),
    fireNext() {
      const entry = pending.shift();
      assert.ok(entry, '没有待触发的定时器');
      entry.fn();
      return entry;
    },
  };
}

// 给 db 套一层：数 runDaily 跑了几次（它每次开一个事务），
// 并允许在指定时刻让 prepare 抛错，模拟「数据库那一刻不可用」。
function instrumentedDb(db) {
  const spy = { ticks: 0, failOnPrepare: false };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (...args) => {
          if (String(args[0] ?? '').startsWith('BEGIN')) spy.ticks += 1;
          return target.exec(...args);
        };
      }
      if (prop === 'prepare') {
        return (...args) => {
          if (spy.failOnPrepare) throw new Error('模拟数据库不可用');
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, spy };
}

function queuedIds(db) {
  return db.prepare("SELECT mistake_id FROM sessions WHERE kind='due'").all().map((r) => r.mistake_id);
}

test('#55 启动补算：容器重启不漏，到期题立刻留痕', () => {
  const { db, ids } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  scheduler.stop();

  assert.ok(scheduler.state.lastRunAt, '启动后应记录一次运行时间');
  assert.ok(scheduler.state.lastResult, '启动后应记录一次运行结果');
  assert.deepEqual(queuedIds(db), [ids.due], '到期题应在启动时留痕');
  closeDb(db);
});

test('#55 启动补算幂等：同一天重复启动不重复留痕', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const a = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  a.stop();
  const b = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  b.stop();

  const count = db.prepare("SELECT COUNT(*) c FROM sessions WHERE kind='due'").get().c;
  assert.equal(count, 1, '同一天重复启动不该重复留痕');
  // 光看行数不够：UNIQUE 约束本来就能拦下重复行，会把「INSERT OR IGNORE
  // 退化成 INSERT」这个改动藏起来——行数照样是 1，但错误被吞进了 lastError。
  // 所以要正面断言「重复留痕被静默忽略，不算错」。
  assert.equal(b.state.lastError, null, '重复启动不该报错：重复行应被静默忽略');
  assert.equal(b.state.lastResult.inserted, 0, '重复启动不该再插入新行');
  closeDb(db);
});

test('#55 启动补算只留到期且在复习中的题', () => {
  const { db, ids } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  scheduler.stop();

  const queued = queuedIds(db);
  assert.ok(!queued.includes(ids.future), '未到期的题不该入队');
  assert.ok(!queued.includes(ids.mastered), '已掌握的题不该入队');
  assert.ok(!queued.includes(ids.diagnosing), '诊断中的题不该入队');
  closeDb(db);
});

test('#55 定时器链只建一条：两条链会让每日推进跑两遍', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(clock.live(), 1, '启动后只应有一条定时器链');
  scheduler.stop();
  closeDb(db);
});

test('#55 首次延迟按当下算，落在下一个本地 00:05', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, {
    now: NOW_23H, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  assert.deepEqual(clock.delays(), [65 * 60000], '上海 23:00 应排到 65 分钟后');
  scheduler.stop();
  closeDb(db);

  const { db: db2 } = makeDb();
  const clock2 = fakeClock();
  const scheduler2 = startScheduler(db2, {
    now: NOW_000430, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer,
  });
  assert.deepEqual(clock2.delays(), [30000], '上海 00:04:30 应排到 30 秒后');
  scheduler2.stop();
  closeDb(db2);
});

test('#55 触发后重排一条新链，延迟按当下重新算', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, {
    now: NOW_23H, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  clock.fireNext();
  assert.equal(clock.live(), 1, '触发后应重新排一条链，不多不少');
  assert.equal(clock.delays()[0], nextRunDelay(), '重排的延迟应按触发当下的时间算');
  scheduler.stop();
  closeDb(db);
});

test('#55 触发一次只跑一次 tick', () => {
  const { db } = makeDb();
  const { db: spyDb, spy } = instrumentedDb(db);
  const clock = fakeClock();
  const scheduler = startScheduler(spyDb, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const before = spy.ticks;
  clock.fireNext();
  assert.equal(spy.ticks - before, 1, '触发一次应只跑一次留痕');
  scheduler.stop();
  closeDb(db);
});

test('#55 stop() 清掉定时器：不留残链吊住进程', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  scheduler.stop();
  assert.equal(clock.live(), 0, 'stop() 之后不应残留定时器');
  closeDb(db);
});

test('#55 stop() 之后链不复活', () => {
  const { db } = makeDb();
  const { db: spyDb, spy } = instrumentedDb(db);
  const clock = fakeClock();
  const scheduler = startScheduler(spyDb, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const alreadyDispatched = clock.fireNext(); // 先触发一次，让链进入「已排下一棒」的状态
  scheduler.stop();

  const before = spy.ticks;
  // 模拟「回调已被派发、还没执行就调用了 stop()」的竞态：
  // 即使这条回调真的跑了，也不该再留痕、不该再排下一棒。
  alreadyDispatched.fn();
  assert.equal(spy.ticks, before, 'stop() 之后不该再自动跑');
  assert.equal(clock.live(), 0, 'stop() 之后不该再排出定时器');
  closeDb(db);
});

test('#55 一次失败不掐断每日链：错误记进 lastError，下一棒照排', () => {
  const { db } = makeDb();
  const { db: spyDb, spy } = instrumentedDb(db);
  const clock = fakeClock();
  const scheduler = startScheduler(spyDb, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  spy.failOnPrepare = true;
  clock.fireNext();
  assert.ok(scheduler.state.lastError, '出错应记进 lastError，而不是把异常抛到进程级');
  assert.equal(clock.live(), 1, '出错后每日链应继续排下一棒');
  assert.equal(scheduler.state.running, true, '出错不该把调度器标记成已停');

  spy.failOnPrepare = false;
  clock.fireNext();
  assert.equal(scheduler.state.lastError, null, '恢复正常后 lastError 应清空');
  scheduler.stop();
  closeDb(db);
});

test('#55 runNow 手动再跑一次，stop() 之后仍可用', () => {
  const { db } = makeDb();
  const clock = fakeClock();
  const scheduler = startScheduler(db, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  scheduler.stop();
  // stop 之后手动跑一次仍然有效：runNow 是给运维用的开关。
  scheduler.runNow();
  assert.equal(clock.live(), 0, 'runNow 不该新建定时器');
  const count = db.prepare("SELECT COUNT(*) c FROM sessions WHERE kind='due'").get().c;
  assert.equal(count, 1, 'runNow 应能再跑一次留痕，且不重复留痕');
  closeDb(db);
});
