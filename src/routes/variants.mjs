import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso } from '../lib/dates.mjs';
import { applyVariantResults, VARIANT_REVIEW_FROM, STATUS_LABEL } from '../state-machine.mjs';
import {
  assert, checkId, checkLevel, checkText, notFound, conflict,
} from '../lib/validation.mjs';

export function createVariantsRouter({ db }) {
  const router = Router();

  router.post('/mistakes/:id/variants', (req, res) => {
    const id = checkId(req.params.id);
    if (!db.prepare('SELECT id FROM mistakes WHERE id = ?').get(id)) notFound('错题不存在');

    const list = req.body?.variants;
    assert(Array.isArray(list) && list.length >= 1 && list.length <= 3, 'variants 需为 1-3 条', 'INVALID_VARIANTS');
    const seen = new Set();
    const prepared = list.map((item) => {
      const level = checkLevel(item.level);
      assert(!seen.has(level), `level ${level} 重复`, 'DUPLICATE_LEVEL');
      seen.add(level);
      return {
        level,
        prompt: checkText(item.prompt, '变式题干', { required: true }),
        answer: checkText(item.correct_answer, '参考答案'),
        hint: checkText(item.scaffold_hint, '引导提示'),
      };
    });

    withTransaction(db, () => {
      const find = db.prepare('SELECT id FROM variants WHERE mistake_id = ? AND level = ? AND source_ref IS NULL');
      const insert = db.prepare(`
        INSERT INTO variants (mistake_id, level, prompt, correct_answer, scaffold_hint, reviewed, result)
        VALUES (?, ?, ?, ?, ?, 0, NULL)
      `);
      const update = db.prepare(`
        UPDATE variants SET prompt = ?, correct_answer = ?, scaffold_hint = ?,
          reviewed = 0, result = NULL, attempted_at = NULL WHERE id = ?
      `);
      for (const item of prepared) {
        const existing = find.get(id, item.level);
        if (existing) update.run(item.prompt, item.answer, item.hint, existing.id);
        else insert.run(id, item.level, item.prompt, item.answer, item.hint);
      }
    });
    res.status(201).json({
      mistake_id: id,
      variants: db.prepare('SELECT * FROM variants WHERE mistake_id = ? ORDER BY id').all(id),
    });
  });

  // 教师审核闸门：未审核的变式不参与状态推进。
  router.patch('/variants/:id/review', (req, res) => {
    const id = checkId(req.params.id);
    const result = req.body?.result;
    assert(['pass', 'fail'].includes(result), 'result 必须是 pass / fail', 'INVALID_RESULT');
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(id);
    if (!variant) notFound('变式不存在');

    // 教学法闸门：变式审核是第二条能改 mistakes.status 的路径，
    // 不看所属错题的状态就会绕过诊断（new 直跳 reviewing），
    // 还会把已掌握的题打回并清空掌握成果（mastered → diagnosing）。
    // 这里先拦一道，状态机 applyVariantResults 里再守一道——
    // 规则要住在规则的归属地，不能只靠调用方自觉。
    const mistake = db.prepare('SELECT id, status FROM mistakes WHERE id = ?').get(variant.mistake_id);
    if (!mistake) notFound('错题不存在');
    if (!VARIANT_REVIEW_FROM.includes(mistake.status)) {
      conflict(`当前状态是「${STATUS_LABEL[mistake.status] ?? mistake.status}」，不能审核变式。变式审核只能在「${VARIANT_REVIEW_FROM.map((s) => STATUS_LABEL[s] ?? s).join('」或「')}」进行。`);
    }

    const now = nowIso();
    const date = today();
    const out = withTransaction(db, () => {
      db.prepare('UPDATE variants SET reviewed = 1, result = ?, attempted_at = ? WHERE id = ?')
        .run(result, now, id);
      const reviewed = db.prepare(`
        SELECT level, result FROM variants
        WHERE mistake_id = ? AND reviewed = 1 AND result IS NOT NULL
      `).all(variant.mistake_id);
      const next = applyVariantResults({ mistake, results: reviewed, today: date });
      let advanced = false;
      if (next) {
        db.prepare(`
          UPDATE mistakes SET status = ?, review_round = ?, next_review = ?, mastered_at = ?, updated_at = ?
          WHERE id = ?
        `).run(next.status, next.review_round, next.next_review, next.mastered_at, now, variant.mistake_id);
        db.prepare(`
          INSERT OR IGNORE INTO sessions (mistake_id, kind, due_on, started_at)
          VALUES (?, 'variant', ?, ?)
        `).run(variant.mistake_id, date, now);
        advanced = true;
      }
      return { advanced, reviewed_count: reviewed.length, next };
    });
    res.json({
      ...out,
      mistake: db.prepare('SELECT id, status, review_round, next_review FROM mistakes WHERE id = ?')
        .get(variant.mistake_id),
    });
  });

  return router;
}
