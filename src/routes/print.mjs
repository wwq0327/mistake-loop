import { Router } from 'express';
import { renderGeometry } from '../geometry.mjs';
import { assert, checkId } from '../lib/validation.mjs';

// 学生版卡片的字段白名单：只有这几个能上纸，其余一律不上。
// 黑名单只能拦住「已经想到的字段」，白名单才能拦住「没想到的字段」——
// 往 cards 里多塞一个 textbook_node_id / source_paper / 将来新加的列，
// 白名单能挡住，黑名单挡不住。
// 这份清单必须与前端 public/js/pages/print.js 的 STUDENT_FIELDS 对得上，
// 两边各守一道：前端管投影，后端管响应体。
export const STUDENT_CARD_FIELDS = [
  'id', 'subject', 'unit_title', 'prompt', 'image_path', 'geometry_svg', 'variants',
];

// 变式上纸只保留层级与题干：参考答案与引导提示是给老师看的。
export const STUDENT_VARIANT_FIELDS = ['level', 'prompt'];

function safeGeometry(raw) {
  if (!raw) return '';
  try {
    return renderGeometry(JSON.parse(raw));
  } catch {
    return '';
  }
}

// 按白名单取字段：多出来的键一律不带。
function pickStudentCard(row, variants) {
  const source = {
    id: row.id,
    subject: row.subject,
    unit_title: row.unit_title,
    prompt: row.prompt,
    image_path: row.image_path,
    geometry_svg: safeGeometry(row.geometry_spec),
    variants: variants.map((item) => ({
      level: item.level,
      prompt: item.prompt,
    })),
  };
  const card = {};
  for (const key of STUDENT_CARD_FIELDS) card[key] = source[key];
  return card;
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
    const cards = rows.map((row) => pickStudentCard(row, variantStmt.all(row.id)));
    res.json({ mode: 'student', total: cards.length, cards });
  });

  return router;
}
