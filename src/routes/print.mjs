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
// #70：学生版的 image_path 不是原卷照片——解析优先级为
// 老师确认的净图 > 老师确认无作答痕迹的原图 > 不出图。
// 原图本身只供教师侧核对，永远不走这条投影。
function resolveSheetImage(row) {
  if (row.clean_image_path) return row.clean_image_path;
  if (row.sheet_image_ok) return row.image_path;
  return null;
}

// 需图判定：识别草稿标了 has_figure，或题干为空（图即题）。
// 几何图可以顶上；既无几何图又无可上纸的图，就明确阻止成卷。
function needsFigure(row) {
  if (!String(row.prompt || '').trim()) return true;
  if (row.recognition_draft_id) {
    const draft = db.prepare('SELECT has_figure FROM recognition_drafts WHERE id = ?').get(row.recognition_draft_id);
    if (draft?.has_figure) return true;
  }
  return false;
}

function pickStudentCard(row, variants) {
  const sheetImage = resolveSheetImage(row);
  const source = {
    id: row.id,
    subject: row.subject,
    unit_title: row.unit_title,
    prompt: row.prompt,
    image_path: sheetImage,
    geometry_svg: safeGeometry(row.geometry_spec),
    variants: variants.map((item) => ({
      level: item.level,
      prompt: item.prompt,
    })),
  };
  const card = {};
  for (const key of STUDENT_CARD_FIELDS) card[key] = source[key];
  return { card, blocked: needsFigure(row) && !sheetImage && !source.geometry_svg };
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
    const cards = [];
    const blocked = [];
    for (const row of rows) {
      const { card, blocked: isBlocked } = pickStudentCard(row, variantStmt.all(row.id));
      if (isBlocked) {
        blocked.push({
          id: row.id,
          reason: '这道题需要图形，但还没有确认可上纸的净图：请上传净图、确认原图可上纸，或补一张几何图。',
        });
        continue;
      }
      cards.push(card);
    }
    res.json({ mode: 'student', total: cards.length, cards, blocked });
  });

  return router;
}
