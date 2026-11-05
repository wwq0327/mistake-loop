import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso } from '../lib/dates.mjs';
import {
  applyVariantResults, VARIANT_REVIEW_FROM, STATUS_LABEL, STUDENT_RESULTS,
} from '../state-machine.mjs';
import {
  assert, checkId, checkLevel, checkText, notFound, conflict,
} from '../lib/validation.mjs';

// #67 契约：审核是「题目本身成立吗」，作答是「学生这一轮真实做出来了吗」。
// 两条路径都只在「诊断中 / 纠错中」开放；推进复习需要三层质量 pass
// 加三层学生 independent 作答，外加学生关键结论非空（总闸门，规则在路由查库判断）。
export function createVariantsRouter({ db }) {
  const router = Router();

  // 评估当前是否满足推进条件。只读，不写库。
  // 返回 next（状态机结果，null = 不推进）与 missing（人话清单，告诉老师还差什么）。
  function evaluateAdvance(mistake) {
    const rows = db.prepare(`
      SELECT level, result, student_result FROM variants
      WHERE mistake_id = ? AND reviewed = 1 AND result IS NOT NULL
    `).all(mistake.id);
    const all = db.prepare('SELECT reviewed, student_result FROM variants WHERE mistake_id = ?').all(mistake.id);
    const next = applyVariantResults({
      mistake,
      results: rows.map((r) => ({ level: r.level, quality: r.result, student: r.student_result })),
      today: today(),
    });
    const missing = [];
    const unreviewed = all.filter((v) => !v.reviewed).length;
    if (unreviewed) missing.push(`${unreviewed} 条变式还没通过质量审核`);
    const noAttempt = all.filter((v) => v.reviewed && !v.student_result).length;
    if (noAttempt) missing.push(`${noAttempt} 条变式还没登记学生作答`);
    if (!mistake.student_conclusion) missing.push('学生关键结论还是空的，先带学生自己说出关键结论');
    // 总闸门：结论为空时状态机就算放行也不推进。
    const blocked = next && !mistake.student_conclusion;
    return { next: blocked ? null : next, missing, blockedByConclusion: Boolean(blocked) };
  }

  function advanceIfReady(mistake, now) {
    const { next, missing } = evaluateAdvance(mistake);
    if (next) {
      db.prepare(`
        UPDATE mistakes SET status = ?, review_round = ?, next_review = ?, mastered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(next.status, next.review_round, next.next_review, next.mastered_at, now, mistake.id);
      db.prepare(`
        INSERT OR IGNORE INTO sessions (mistake_id, kind, due_on, started_at)
        VALUES (?, 'variant', ?, ?)
      `).run(mistake.id, today(), now);
    }
    return { next, missing };
  }

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
          reviewed = 0, result = NULL, attempted_at = NULL, student_result = NULL,
          student_note = NULL, student_verified_at = NULL WHERE id = ?
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

  // 质量审核：只回答「这道变式题本身成不成立」。
  // 不写 attempted_at（那是作答时间，#67 起归 attempt 路径管）；
  // quality fail 时把 fail 时间记进 attempted_at，作为 #68 回落的时间边界。
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
    const mistake = db.prepare('SELECT id, status, student_conclusion FROM mistakes WHERE id = ?').get(variant.mistake_id);
    if (!mistake) notFound('错题不存在');
    if (!VARIANT_REVIEW_FROM.includes(mistake.status)) {
      conflict(`当前状态是「${STATUS_LABEL[mistake.status] ?? mistake.status}」，不能审核变式。变式审核只能在「${VARIANT_REVIEW_FROM.map((s) => STATUS_LABEL[s] ?? s).join('」或「')}」进行。`);
    }

    const now = nowIso();
    const out = withTransaction(db, () => {
      // fail 的时间是回落边界，pass 不写作答时间。
      db.prepare('UPDATE variants SET reviewed = 1, result = ?, attempted_at = ? WHERE id = ?')
        .run(result, result === 'fail' ? now : variant.attempted_at, id);
      return advanceIfReady(mistake, now);
    });
    res.json({
      ...out,
      mistake: db.prepare('SELECT id, status, review_round, next_review FROM mistakes WHERE id = ?')
        .get(variant.mistake_id),
    });
  });

  // 学生作答登记：老师看着学生做完这一轮后如实记一档。
  // independent 才参与推进；unmet 留下时间戳，作为 #68 证据周期的回落边界。
  router.patch('/variants/:id/attempt', (req, res) => {
    const id = checkId(req.params.id);
    const result = req.body?.result;
    assert(STUDENT_RESULTS.includes(result), 'result 必须是 independent / hinted / unmet / unjudged 之一', 'INVALID_STUDENT_RESULT');
    const note = checkText(req.body?.note, '学生作答记录');
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(id);
    if (!variant) notFound('变式不存在');

    if (!(variant.reviewed === 1 && variant.result === 'pass')) {
      conflict('这条变式还没通过质量审核，先审核题目本身，再登记学生作答。');
    }

    const mistake = db.prepare('SELECT id, status, student_conclusion FROM mistakes WHERE id = ?').get(variant.mistake_id);
    if (!mistake) notFound('错题不存在');
    if (!VARIANT_REVIEW_FROM.includes(mistake.status)) {
      conflict(`当前状态是「${STATUS_LABEL[mistake.status] ?? mistake.status}」，不能登记学生作答。只能在「${VARIANT_REVIEW_FROM.map((s) => STATUS_LABEL[s] ?? s).join('」或「')}」进行。`);
    }

    const now = nowIso();
    const out = withTransaction(db, () => {
      db.prepare(`
        UPDATE variants SET student_result = ?, student_note = ?, student_verified_at = ?, attempted_at = ?
        WHERE id = ?
      `).run(result, note, now, now, id);
      return advanceIfReady(mistake, now);
    });
    res.json({
      ...out,
      mistake: db.prepare('SELECT id, status, review_round, next_review FROM mistakes WHERE id = ?')
        .get(variant.mistake_id),
    });
  });

  return router;
}
