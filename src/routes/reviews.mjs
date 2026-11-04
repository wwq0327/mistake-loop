import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso, daysBetween } from '../lib/dates.mjs';
import { applyReview } from '../state-machine.mjs';
import {
  checkId, checkResult, checkEvidence, checkText, notFound, conflict,
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

    const current = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
    if (!current) notFound('错题不存在');
    if (current.status !== 'reviewing') conflict('只有复习中的题可以提交复习结果');

    const now = nowIso();
    const date = today();
    const next = withTransaction(db, () => {
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
