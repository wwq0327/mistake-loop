import { Router } from 'express';
import { ERROR_SUBTYPES, VARIANT_RULES, EDITIONS, UNCLASSIFIED } from '../lib/subjects.mjs';
import { STATUSES, SUBJECTS, CATEGORIES, LEVELS, EVIDENCE_KINDS, DIAGNOSABLE_STATUSES } from '../state-machine.mjs';
import { today } from '../lib/dates.mjs';

const count = (db, sql, ...params) => db.prepare(sql).get(...params).c;

export function createMetaRouter({ db }) {
  const router = Router();

  router.get('/meta', (req, res) => {
    // 全部实时聚合，不存任何手写计数
    const byStatus = {};
    for (const status of STATUSES) {
      byStatus[status] = count(db, 'SELECT COUNT(*) c FROM mistakes WHERE status = ?', status);
    }
    const bySubject = {};
    for (const subject of SUBJECTS) {
      bySubject[subject] = count(db, 'SELECT COUNT(*) c FROM mistakes WHERE subject = ?', subject);
    }
    res.json({
      today: today(),
      subjects: SUBJECTS,
      statuses: STATUSES,
      // 允许做诊断的状态白名单：详情页的动作按钮按它设闸门，
      // 免得界面摆着注定被后端拒掉的按钮（#57）。
      diagnosableStatuses: DIAGNOSABLE_STATUSES,
      categories: CATEGORIES,
      levels: LEVELS,
      evidenceKinds: EVIDENCE_KINDS,
      editions: EDITIONS,
      unclassified: UNCLASSIFIED,
      errorSubtypes: ERROR_SUBTYPES,
      variantRules: VARIANT_RULES,
      textbookNodes: db.prepare('SELECT * FROM textbook_nodes ORDER BY subject, unit_no').all(),
      pendingVariants: db.prepare(`
        SELECT v.id, v.mistake_id, v.level, v.prompt, m.subject
        FROM variants v JOIN mistakes m ON m.id = v.mistake_id
        WHERE v.reviewed = 0 ORDER BY v.id LIMIT 100
      `).all(),
      stats: {
        total: count(db, 'SELECT COUNT(*) c FROM mistakes'),
        byStatus,
        bySubject,
        overdue: count(db, "SELECT COUNT(*) c FROM mistakes WHERE status = 'reviewing' AND next_review IS NOT NULL AND next_review <= ?", today()),
        awaitingTextbookRef: count(db, 'SELECT COUNT(*) c FROM mistakes WHERE needs_textbook_ref = 1'),
        variantsReviewed: count(db, 'SELECT COUNT(*) c FROM variants WHERE reviewed = 1'),
      },
    });
  });

  router.get('/textbook-nodes', (req, res) => {
    const items = db.prepare('SELECT * FROM textbook_nodes ORDER BY subject, unit_no').all();
    res.json({ total: items.length, items });
  });

  return router;
}
