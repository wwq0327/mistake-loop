import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso } from '../lib/dates.mjs';
import { EDITIONS } from '../lib/subjects.mjs';
import { saveImage } from '../lib/images.mjs';
import {
  assert, checkSubject, checkCategory, checkStatus, checkId, checkText,
  notFound, conflict,
} from '../lib/validation.mjs';

const COLUMNS = [
  'source_ref', 'student_id', 'textbook_node_id', 'subject', 'edition', 'grade', 'semester',
  'unit_no', 'unit_title', 'lesson_title', 'page_no', 'question_type', 'difficulty', 'prompt',
  'student_answer', 'correct_answer', 'image_path', 'source_paper', 'knowledge_tags',
  'error_category', 'error_subtype', 'error_reason', 'diagnosis_note', 'student_conclusion',
  'geometry_spec', 'status', 'review_round', 'needs_textbook_ref', 'created_at', 'updated_at',
];
const INSERT_SQL = `INSERT INTO mistakes (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`;

export function createMistakesRouter({ db, dataDir }) {
  const router = Router();

  router.post('/mistakes', (req, res) => {
    const body = req.body ?? {};
    const subject = checkSubject(body.subject);
    const prompt = checkText(body.prompt, '题干', { required: true });
    const imagePath = body.image ? saveImage(body.image, dataDir) : null;
    const now = nowIso();

    let nodeRow = null;
    let textbookNodeId = null;
    if (body.textbook_node_id !== undefined && body.textbook_node_id !== null && body.textbook_node_id !== '') {
      textbookNodeId = checkId(body.textbook_node_id);
      nodeRow = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(textbookNodeId);
      if (!nodeRow) notFound('教材节点不存在');
      assert(nodeRow.subject === subject, '教材节点科目与错题科目不一致', 'SUBJECT_MISMATCH');
    }

    const student = db.prepare('SELECT id FROM students ORDER BY id LIMIT 1').get();
    const values = Object.fromEntries(COLUMNS.map((c) => [c, null]));
    Object.assign(values, {
      source_ref: null,
      student_id: student?.id ?? null,
      textbook_node_id: textbookNodeId,
      subject,
      edition: body.edition ?? nodeRow?.edition ?? EDITIONS[subject],
      grade: body.grade ?? nodeRow?.grade ?? 4,
      semester: body.semester ?? nodeRow?.semester ?? 1,
      unit_no: body.unit_no ?? nodeRow?.unit_no ?? null,
      unit_title: body.unit_title ?? nodeRow?.unit_title ?? null,
      lesson_title: checkText(body.lesson_title, '课题'),
      page_no: checkText(body.page_no, '页码'),
      question_type: checkText(body.question_type, '题型'),
      difficulty: checkText(body.difficulty, '难度'),
      prompt,
      student_answer: checkText(body.student_answer, '学生答案'),
      correct_answer: checkText(body.correct_answer, '正确答案'),
      image_path: imagePath,
      source_paper: checkText(body.source_paper, '试卷来源'),
      knowledge_tags: Array.isArray(body.knowledge_tags) ? JSON.stringify(body.knowledge_tags) : null,
      geometry_spec: body.geometry_spec ? JSON.stringify(body.geometry_spec) : null,
      status: 'new',
      review_round: 0,
      needs_textbook_ref: 0,
      created_at: now,
      updated_at: now,
    });

    const id = withTransaction(db, () => Number(db.prepare(INSERT_SQL).run(values).lastInsertRowid));
    res.status(201).json(db.prepare('SELECT id, status, image_path, created_at FROM mistakes WHERE id = ?').get(id));
  });

  // 批量补教材定位：整批校验、整批写入，挂错科目的节点一律拒绝，不留半批数据。
  router.post('/mistakes/batch-textbook-ref', (req, res) => {
    const body = req.body ?? {};
    const rawIds = body.ids;
    assert(
      Array.isArray(rawIds) && rawIds.length > 0 && rawIds.length <= 200,
      'ids 必须是 1-200 个题目编号',
      'INVALID_IDS',
    );
    const ids = [...new Set(rawIds.map((raw) => checkId(raw)))];
    const nodeId = checkId(body.textbook_node_id);
    const node = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(nodeId);
    if (!node) notFound('教材节点不存在');

    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, subject, textbook_node_id, needs_textbook_ref
      FROM mistakes WHERE id IN (${placeholders})
    `).all(...ids);
    assert(rows.length === ids.length, '有题目不存在，整批不处理', 'INVALID_IDS');
    const mismatched = rows.filter((row) => row.subject !== node.subject);
    assert(
      mismatched.length === 0,
      `挂错科目：${mismatched.map((row) => row.id).join(', ')} 不是 ${node.subject} 的题`,
      'SUBJECT_MISMATCH',
    );

    // 已挂到同一节点且已清标记的题跳过，重复点不会制造多余写入。
    const toUpdate = rows.filter((row) => row.textbook_node_id !== nodeId || row.needs_textbook_ref !== 0);
    const now = nowIso();
    withTransaction(db, () => {
      const stmt = db.prepare(`
        UPDATE mistakes
        SET textbook_node_id = ?, edition = ?, grade = ?, semester = ?, unit_no = ?,
            unit_title = ?, lesson_title = ?, needs_textbook_ref = 0, updated_at = ?
        WHERE id = ?
      `);
      for (const row of toUpdate) {
        stmt.run(nodeId, node.edition, node.grade, node.semester, node.unit_no,
          node.unit_title, node.lesson_title, now, row.id);
      }
    });
    res.json({
      updated: toUpdate.length,
      skipped: rows.length - toUpdate.length,
      nodeId,
      ids,
      node: { id: node.id, subject: node.subject, unit_no: node.unit_no, unit_title: node.unit_title },
    });
  });

  router.get('/mistakes', (req, res) => {
    const clauses = [];
    const params = [];
    if (req.query.status) {
      clauses.push('status = ?');
      params.push(checkStatus(req.query.status));
    }
    if (req.query.subject) {
      clauses.push('subject = ?');
      params.push(checkSubject(req.query.subject));
    }
    if (req.query.needs_textbook_ref !== undefined) {
      clauses.push('needs_textbook_ref = ?');
      params.push(String(req.query.needs_textbook_ref) === '1' ? 1 : 0);
    }
    if (req.query.textbook_node_id !== undefined && req.query.textbook_node_id !== '') {
      clauses.push('textbook_node_id = ?');
      params.push(checkId(req.query.textbook_node_id));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const items = db.prepare(`SELECT * FROM mistakes ${where} ORDER BY id DESC LIMIT 500`).all(...params);
    res.json({ total: items.length, items });
  });

  router.get('/mistakes/:id', (req, res) => {
    const id = checkId(req.params.id);
    const row = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
    if (!row) notFound('错题不存在');
    res.json({
      ...row,
      variants: db.prepare('SELECT * FROM variants WHERE mistake_id = ? ORDER BY id').all(id),
      review_events: db.prepare('SELECT * FROM review_events WHERE mistake_id = ? ORDER BY id').all(id),
      sessions: db.prepare('SELECT * FROM sessions WHERE mistake_id = ? ORDER BY id').all(id),
      mastery_evidence: db.prepare('SELECT * FROM mastery_evidence WHERE mistake_id = ? ORDER BY id').all(id),
    });
  });

  // 支架式：学生没说出关键结论，不许推进到 correcting。
  router.patch('/mistakes/:id/diagnosis', (req, res) => {
    const id = checkId(req.params.id);
    const body = req.body ?? {};
    const target = body.status ? checkStatus(body.status) : 'diagnosing';
    assert(['diagnosing', 'correcting'].includes(target), '诊断接口只允许 diagnosing / correcting', 'INVALID_TARGET');
    if (body.error_category !== undefined && body.error_category !== null && body.error_category !== '') {
      checkCategory(body.error_category);
    }
    const current = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
    if (!current) notFound('错题不存在');
    assert(['new', 'diagnosing', 'correcting'].includes(current.status), '当前状态不允许再诊断', 'INVALID_STATE');

    const conclusion = body.student_conclusion !== undefined
      ? checkText(body.student_conclusion, '学生结论')
      : current.student_conclusion;
    if (target === 'correcting') {
      if (!conclusion || !String(conclusion).trim()) {
        conflict('学生未说出关键结论，不能进入纠错中');
      }
    }
    if (body.textbook_node_id) {
      const node = db.prepare('SELECT id FROM textbook_nodes WHERE id = ?').get(checkId(body.textbook_node_id));
      if (!node) notFound('教材节点不存在');
    }

    const allowed = [
      'error_category', 'error_subtype', 'error_reason', 'diagnosis_note', 'student_conclusion',
      'textbook_node_id', 'unit_no', 'unit_title', 'lesson_title', 'page_no',
    ];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    sets.push('status = ?', 'updated_at = ?');
    params.push(target, nowIso());
    if (body.textbook_node_id) sets.push('needs_textbook_ref = 0');
    params.push(id);

    withTransaction(db, () => {
      db.prepare(`UPDATE mistakes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      db.prepare(`
        INSERT OR IGNORE INTO sessions (mistake_id, kind, due_on, started_at)
        VALUES (?, ?, ?, ?)
      `).run(id, target === 'correcting' ? 'correcting' : 'diagnosing', today(), nowIso());
    });
    res.json(db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id));
  });

  return router;
}
