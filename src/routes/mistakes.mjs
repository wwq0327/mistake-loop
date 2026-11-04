import { Router } from 'express';
import { withTransaction } from '../db.mjs';
import { today, nowIso } from '../lib/dates.mjs';
import { EDITIONS } from '../lib/subjects.mjs';
import { saveImage } from '../lib/images.mjs';
import {
  assert, checkSubject, checkCategory, checkStatus, checkId, checkText, checkSubtype,
  notFound, conflict, assertTextbookCompatible, textbookFieldsFromNode,
} from '../lib/validation.mjs';
import { DIAGNOSABLE_STATUSES } from '../state-machine.mjs';

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
    // 教材字段以节点为准：请求体里手写的教材字段一律忽略，避免主键被伪造值污染。
    const textbook = nodeRow ? textbookFieldsFromNode(nodeRow) : {};
    Object.assign(values, {
      source_ref: null,
      student_id: student?.id ?? null,
      textbook_node_id: textbookNodeId,
      subject,
      edition: textbook.edition ?? body.edition ?? EDITIONS[subject],
      grade: textbook.grade ?? body.grade ?? 4,
      semester: textbook.semester ?? body.semester ?? 1,
      unit_no: textbook.unit_no ?? body.unit_no ?? null,
      unit_title: textbook.unit_title ?? body.unit_title ?? null,
      lesson_title: textbook.lesson_title ?? checkText(body.lesson_title, '课题'),
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
      SELECT id, subject, grade, semester, textbook_node_id, needs_textbook_ref
      FROM mistakes WHERE id IN (${placeholders})
    `).all(...ids);
    assert(rows.length === ids.length, '有题目不存在，整批不处理', 'INVALID_IDS');
    const mismatched = rows.filter((row) => row.subject !== node.subject);
    assert(
      mismatched.length === 0,
      `挂错科目：${mismatched.map((row) => row.id).join(', ')} 不是 ${node.subject} 的题`,
      'SUBJECT_MISMATCH',
    );
    // 教材定位是主键：年级/册次不一致一律整批拒绝，不静默覆盖错题的册次属性。
    for (const row of rows) {
      assertTextbookCompatible(row, node, { ids: [row.id] });
    }

    // 已挂到同一节点且已清标记的题跳过，重复点不会制造多余写入。
    const toUpdate = rows.filter((row) => row.textbook_node_id !== nodeId || row.needs_textbook_ref !== 0);
    const now = nowIso();
    const fields = textbookFieldsFromNode(node);
    withTransaction(db, () => {
      const stmt = db.prepare(`
        UPDATE mistakes
        SET textbook_node_id = ?, edition = ?, grade = ?, semester = ?, unit_no = ?,
            unit_title = ?, lesson_title = ?, needs_textbook_ref = 0, updated_at = ?
        WHERE id = ?
      `);
      for (const row of toUpdate) {
        stmt.run(nodeId, fields.edition, fields.grade, fields.semester, fields.unit_no,
          fields.unit_title, fields.lesson_title, now, row.id);
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
    const current = db.prepare('SELECT * FROM mistakes WHERE id = ?').get(id);
    if (!current) notFound('错题不存在');
    assert(DIAGNOSABLE_STATUSES.includes(current.status), '当前状态不允许再诊断', 'INVALID_STATE');

    // 错因大类与子类必须同科目同大类：语文不能挂数学的「计算失误」。
    // 这次没碰错因字段就不校验，避免旧数据挡住改别的字段。
    const patch = { ...body };
    if (body.error_category !== undefined) {
      patch.error_category = body.error_category === null || body.error_category === ''
        ? null
        : checkCategory(body.error_category);
    }
    if (body.error_subtype !== undefined) {
      patch.error_subtype = body.error_subtype === null || body.error_subtype === '' ? null : body.error_subtype;
    }
    if (body.error_reason !== undefined) patch.error_reason = checkText(body.error_reason, '错因说明');
    if (body.error_category !== undefined || body.error_subtype !== undefined) {
      const effectiveCategory = patch.error_category !== undefined ? patch.error_category : current.error_category;
      const effectiveSubtype = patch.error_subtype !== undefined ? patch.error_subtype : current.error_subtype;
      checkSubtype(current.subject, effectiveCategory, effectiveSubtype);
    }

    const conclusion = body.student_conclusion !== undefined
      ? checkText(body.student_conclusion, '学生结论')
      : current.student_conclusion;
    if (target === 'correcting') {
      if (!conclusion || !String(conclusion).trim()) {
        conflict('学生未说出关键结论，不能进入纠错中');
      }
    }
    let nodeRow = null;
    if (body.textbook_node_id) {
      nodeRow = db.prepare('SELECT * FROM textbook_nodes WHERE id = ?').get(checkId(body.textbook_node_id));
      if (!nodeRow) notFound('教材节点不存在');
      // 科目/册次不一致一律拒绝；教材字段随后从节点回填，不采信请求体里手写的值。
      assertTextbookCompatible(current, nodeRow, { ids: [id] });
    }

    const allowed = [
      'error_category', 'error_subtype', 'error_reason', 'diagnosis_note', 'student_conclusion',
      'textbook_node_id', 'unit_no', 'unit_title', 'lesson_title', 'page_no',
    ];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      // 挂了节点时，教材字段由节点决定，请求体里的同名字段忽略。
      if (nodeRow && ['unit_no', 'unit_title', 'lesson_title'].includes(key)) continue;
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(patch[key]);
      }
    }
    if (nodeRow) {
      const fields = textbookFieldsFromNode(nodeRow);
      sets.push('edition = ?', 'grade = ?', 'semester = ?');
      params.push(fields.edition, fields.grade, fields.semester);
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
