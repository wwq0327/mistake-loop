import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso, daysBetween } from '../lib/dates.mjs';
import { applyReview } from '../state-machine.mjs';
import {
  checkId, checkResult, checkEvidence, checkText, checkDate, notFound, conflict,
} from '../lib/validation.mjs';

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
      let evidenceCount = db.prepare('SELECT COUNT(*) c FROM mastery_evidence WHERE mistake_id = ?').get(id).c;
      if (evidenceType) {
        db.prepare(`
          INSERT INTO mastery_evidence (mistake_id, kind, note, created_at) VALUES (?, ?, ?, ?)
        `).run(id, evidenceType, evidenceNote, now);
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
