import { Router } from 'express';
import { renderGeometry } from '../geometry.mjs';
import { assert, checkId } from '../lib/validation.mjs';

function safeGeometry(raw) {
  if (!raw) return '';
  try {
    return renderGeometry(JSON.parse(raw));
  } catch {
    return '';
  }
}

export function createPrintRouter({ db }) {
  const router = Router();

  // 学生版：响应里永不出现正确答案、学生答案、错因、引导提示。
  router.get('/print', (req, res) => {
    const mode = req.query.mode ?? 'student';
    assert(mode === 'student', '第一版只提供学生版打印页', 'UNSUPPORTED_MODE');

    let rows;
    if (req.query.ids) {
      const ids = String(req.query.ids).split(',').map((part) => checkId(part.trim()));
      const placeholders = ids.map(() => '?').join(', ');
      rows = db.prepare(`SELECT * FROM mistakes WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
    } else {
      rows = db.prepare("SELECT * FROM mistakes WHERE status IN ('reviewing','correcting') ORDER BY id").all();
    }

    const variantStmt = db.prepare(`
      SELECT level, prompt FROM variants
      WHERE mistake_id = ? AND reviewed = 1
      ORDER BY CASE level WHEN 'surface' THEN 1 WHEN 'structure' THEN 2 ELSE 3 END
    `);
    const cards = rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      unit_title: row.unit_title,
      prompt: row.prompt,
      image_path: row.image_path,
      geometry_svg: safeGeometry(row.geometry_spec),
      variants: variantStmt.all(row.id), // 未审核的变式不上纸
    }));
    res.json({ mode: 'student', total: cards.length, cards });
  });

  return router;
}
