import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso, daysBetween } from '../lib/dates.mjs';
import { applyReview } from '../state-machine.mjs';
import {
  assert, checkId, checkResult, checkEvidence, checkText, checkDate, notFound, conflict,
} from '../lib/validation.mjs';

// #68 本轮证据的起点：一次「回落」把证据周期清零。
// 回落有两种：复习登记为做错，或变式审核不过（后者直接打回诊断，轮次也归零）。
// 取两者中较晚的时间戳——旧证据留在库里不删，但不再参与本轮的掌握判定。
export function cycleStartedAt(db, mistakeId) {
  const wrong = db.prepare(
    "SELECT MAX(done_at) AS t FROM review_events WHERE mistake_id = ? AND result = 'wrong'",
  ).get(mistakeId).t;
  const failedVariant = db.prepare(
    "SELECT MAX(attempted_at) AS t FROM variants WHERE mistake_id = ? AND result = 'fail'",
  ).get(mistakeId).t;
  const marks = [wrong, failedVariant].filter(Boolean).sort();
  return marks.length ? marks[marks.length - 1] : null;
}

// 只数本轮证据。时间戳统一是 ISO 8601，可直接按字符串比大小。
export function countCycleEvidence(db, mistakeId) {
  const since = cycleStartedAt(db, mistakeId);
  if (!since) {
    return db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(mistakeId).c;
  }
  return db.prepare(
    'SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ? AND created_at > ?',
  ).get(mistakeId, since).c;
}

export function createReviewsRouter({ db }) {
  const router = Router();

  router.get('/reviews/today', (req, res) => {
    const date = today();
    const rows = db.prepare(`
      SELECT * FROM mistakes
      WHERE status = 'reviewing' AND next_review IS NOT NULL AND next_review <= ?
      ORDER BY next_review, id
    `).all(date);
    res.json({
      date,
      total: rows.length,
      items: rows.map((row) => ({ ...row, overdue_days: daysBetween(row.next_review, date) })),
    });
  });

  router.post('/reviews/:id/result', (req, res) => {
    const id = checkId(req.params.id);
    const body = req.body ?? {};
    const result = checkResult(body.result);
    // #68 契约：做错时带证据整请求拒掉，不写库。
    // 「默默忽略」看起来更宽容，实际会让老师以为自己记上了证据——
    // 证据是以后判掌握的依据，宁可当场报错，也不收下一张空头支票。
    assert(
      !(result === 'wrong' && body.evidence_type),
      '做错了不能同时记掌握证据：证据只跟「做对」一起提交。',
      'EVIDENCE_NOT_ALLOWED',
    );
    const evidenceType = body.evidence_type ? checkEvidence(body.evidence_type) : null;
    const note = checkText(body.note, '备注');
    const evidenceNote = checkText(body.evidence_note, '证据说明');
    // #56：「这次复习」的身份是它针对的到期日。
    // 传了就查重——同一次复习只记一遍，老师手快连点两下不会记成两轮。
    // 不传则行为完全不变：连做多轮（v1 的 P7 连发 4 次）仍然可用。
    // 从数据上分不清「连点两下」与「连做 4 轮」，判据只能由前端给。
    const dueOn = body.due_on ? checkDate(body.due_on) : null;

    const current = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
    if (!current) notFound('错题不存在');
    if (current.status !== 'reviewing') conflict('只有复习中的题可以提交复习结果');

    const now = nowIso();
    const date = today();
    const next = withTransaction(db, () => {
      if (dueOn) {
        // 判重放在事务里：两个并发请求只有一个能过。
        const done = db.prepare('SELECT id FROM review_events WHERE mistake_id = ? AND due_on = ?').get(id, dueOn);
        if (done) conflict('这次复习已经记过了，别重复点。');
        if (current.next_review !== dueOn) {
          conflict(current.next_review
            ? '这次复习的到期日对不上，请刷新页面后再记。'
            : '这道题没有排期，不能记复习结果。');
        }
      }
      let evidenceCount = countCycleEvidence(db, id);
      if (evidenceType) {
        db.prepare(`
          INSERT INTO mastery_evidence (mistake_id, kind, note, created_at) VALUES (?, ?, ?, ?)
        `).run(id, evidenceType, evidenceNote, now);
        // 刚写进去的这条也在本周期里——直接加一，避免再查一遍。
        evidenceCount += 1;
      }
      const computed = applyReview({ mistake: current, result, today: date, evidenceCount });
      db.prepare(`
        UPDATE mistakes SET status = ?, review_round = ?, next_review = ?, mastered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(computed.status, computed.review_round, computed.next_review, computed.mastered_at, now, id);
      db.prepare(`
        INSERT INTO review_events (mistake_id, round, due_on, done_at, result, note, evidence_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, computed.review_round, current.next_review, now, result, note, evidenceType);
      db.prepare(`
        INSERT OR IGNORE INTO sessions (mistake_id, kind, due_on, started_at, notes, evidence_type)
        VALUES (?, 'spaced', ?, ?, ?, ?)
      `).run(id, date, now, note, evidenceType);
      return computed;
    });
    res.json({ mistake_id: id, ...next });
  });

  return router;
}
