// 只读导入 mistake-wiki：绝不写入、不修改、不删除、不移动旧库任何文件。
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, closeDb, withTransaction } from '../src/db.mjs';
import { copyLegacyImage } from '../src/lib/images.mjs';
import { nowIso } from '../src/lib/dates.mjs';
import { EDITIONS } from '../src/lib/subjects.mjs';
import { CATEGORIES } from '../src/state-machine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEGACY_ROOT = '/Users/walt/codes/my/mistake-wiki';
const TEXTBOOK_FILES = [
  { subject: 'math', path: 'wiki/textbooks/math/人教版-四年级上册.md' },
  { subject: 'chinese', path: 'wiki/textbooks/chinese/统编版-四年级上册.md' },
  { subject: 'english', path: 'wiki/textbooks/english/人教版PEP-四年级上册.md' },
];
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (CN_DIGITS[text[1]] ?? 0);
  if (text.endsWith('十')) return (CN_DIGITS[text[0]] ?? 0) * 10;
  return CN_DIGITS[text] ?? 0;
}

// 只解析旧库实际出现的 YAML 子集：标量、短横线列表、两级嵌套对象。
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  let currentKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      currentKey = top[1];
      meta[currentKey] = top[2].trim() === '' ? {} : top[2].trim();
      continue;
    }
    const listItem = /^\s+-\s+(.+)$/.exec(line);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(listItem[1].trim());
      continue;
    }
    const nested = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (nested && currentKey && !Array.isArray(meta[currentKey]) && typeof meta[currentKey] === 'object') {
      meta[currentKey][nested[1]] = nested[2].trim();
    }
  }
  // 空值字段（如 next_review: / mastered_at:）会被暂记成空对象，统一收敛为空字符串。
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      meta[key] = '';
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

export function parseSections(body) {
  const out = {};
  for (const part of body.split(/^## /m).slice(1)) {
    const newline = part.indexOf('\n');
    const title = (newline < 0 ? part : part.slice(0, newline)).trim();
    out[title] = newline < 0 ? '' : part.slice(newline + 1);
  }
  return out;
}

// 只取题干，截掉「学生作答 / 结果：通过」等历史记录，不伪造成本系统复习事件。
export function parseVariants(section) {
  if (!section) return [];
  const out = [];
  for (const part of section.split(/^### /m).slice(1)) {
    const newline = part.indexOf('\n');
    const heading = newline < 0 ? part : part.slice(0, newline);
    const level = /表面/.test(heading) ? 'surface' : /结构/.test(heading) ? 'structure' : /情境/.test(heading) ? 'context' : null;
    if (!level) continue;
    let content = newline < 0 ? '' : part.slice(newline + 1);
    const cut = content.search(/\*\*学生作答：|\*\*结果：|^---/m);
    if (cut >= 0) content = content.slice(0, cut);
    const prompt = content.trim();
    if (prompt) out.push({ level, prompt });
  }
  return out;
}

export function parseTextbookNodes(legacyRoot) {
  const nodes = [];
  for (const file of TEXTBOOK_FILES) {
    const absolute = join(legacyRoot, file.path);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    const { meta } = parseFrontmatter(text);
    for (const line of text.split(/\r?\n/)) {
      const m = /^\|\s*(?:第([一二三四五六七八九十]+)单元|Unit\s*(\d+)|Recycle\s*(\d+))\s*\|\s*([^|]+?)\s*\|\s*(p?\d+(?:-\d+)?)\s*\|/i.exec(line);
      if (!m) continue;
      const unitNo = m[1] ? cnNumber(m[1]) : m[2] ? Number(m[2]) : 90 + Number(m[3]);
      nodes.push({
        subject: file.subject,
        edition: meta.edition || EDITIONS[file.subject],
        grade: Number(meta.grade) || 4,
        semester: Number(meta.semester) || 1,
        unit_no: unitNo,
        unit_title: m[4].trim(),
        lesson_title: '', // 第一版只到单元级；课题与页码录入时手填
        page_start: m[5].trim(),
        source_ref: file.path,
      });
    }
  }
  return nodes;
}

const MISTAKE_COLUMNS = [
  'source_ref', 'student_id', 'textbook_node_id', 'subject', 'edition', 'grade', 'semester',
  'question_type', 'difficulty', 'prompt', 'student_answer', 'correct_answer', 'image_path',
  'source_paper', 'knowledge_tags', 'error_category', 'error_reason', 'diagnosis_note',
  'legacy_notes', 'status', 'review_round', 'next_review', 'mastered_at',
  'needs_textbook_ref', 'created_at', 'updated_at',
];

export function importLegacy({ legacyRoot, dataDir, db }) {
  mkdirSync(join(dataDir, 'images'), { recursive: true });
  const mistakeDir = join(legacyRoot, 'wiki', 'mistakes');
  const files = existsSync(mistakeDir)
    ? readdirSync(mistakeDir).filter((name) => /^M-.*\.md$/.test(name)).sort()
    : [];
  const now = nowIso();
  const nodes = parseTextbookNodes(legacyRoot);
  const added = {
    mistakes: 0, variants: 0, images: 0, textbookNodes: 0,
    awaitingTextbookRef: 0, missingImages: [], errors: [],
  };

  withTransaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO students (id, name, created_at) VALUES (1, '默认学生', ?)").run(now);

    const insertNode = db.prepare(`
      INSERT OR IGNORE INTO textbook_nodes
        (subject, edition, grade, semester, unit_no, unit_title, lesson_title, page_start, source_ref)
      VALUES (@subject, @edition, @grade, @semester, @unit_no, @unit_title, @lesson_title, @page_start, @source_ref)
    `);
    for (const node of nodes) added.textbookNodes += insertNode.run(node).changes;

    const insertMistake = db.prepare(`
      INSERT OR IGNORE INTO mistakes (${MISTAKE_COLUMNS.join(', ')})
      VALUES (${MISTAKE_COLUMNS.map((c) => `@${c}`).join(', ')})
    `);
    const findMistake = db.prepare('SELECT id FROM mistakes WHERE source_ref = ?');
    const insertVariant = db.prepare(`
      INSERT OR IGNORE INTO variants (mistake_id, level, prompt, source_ref, reviewed, result)
      VALUES (?, ?, ?, ?, 0, NULL)
    `);

    for (const file of files) {
      const raw = readFileSync(join(mistakeDir, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const sec = parseSections(body);
      const subject = ['math', 'chinese', 'english'].includes(meta.subject) ? meta.subject : 'math';

      let imagePath = null;
      if (meta.image_path) {
        const src = join(legacyRoot, meta.image_path);
        if (existsSync(src)) {
          const target = join(dataDir, 'images', 'legacy', basename(meta.image_path));
          const existed = existsSync(target);
          imagePath = copyLegacyImage(src, dataDir);
          if (!existed) added.images += 1;
        } else {
          added.missingImages.push(`${file}: ${meta.image_path}`);
        }
      }

      const preliminary = typeof meta.preliminary_diagnosis === 'object' && !Array.isArray(meta.preliminary_diagnosis)
        ? meta.preliminary_diagnosis.reason : null;
      const values = {
        source_ref: meta.id,
        student_id: 1,
        textbook_node_id: null, // 旧题是三下，四上节点挂不上，不猜
        subject,
        edition: EDITIONS[subject],
        grade: Number(meta.grade) || 3,
        semester: Number(meta.semester) || 2,
        question_type: meta.type || null,
        difficulty: meta.difficulty || null,
        prompt: (sec['原题'] || '').trim() || `（旧库未记录原题）${meta.id}`,
        student_answer: (sec['学生答案'] || '').trim() || null,
        correct_answer: (sec['正确答案'] || '').trim() || null,
        image_path: imagePath,
        source_paper: meta.source_paper || null,
        knowledge_tags: JSON.stringify(Array.isArray(meta.knowledge_tags) ? meta.knowledge_tags : []),
        error_category: CATEGORIES.includes(meta.error_category) ? meta.error_category : null,
        error_reason: meta.error_reason || null,
        diagnosis_note: preliminary ? `旧库初步诊断，未经教师审核：${preliminary}` : null,
        legacy_notes: (sec['病因诊断'] || '').trim() || null,
        status: ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered'].includes(meta.status) ? meta.status : 'new',
        review_round: Math.min(Math.max(Number(meta.review_round) || 0, 0), 4),
        next_review: meta.next_review || null,
        mastered_at: meta.mastered_at || null,
        needs_textbook_ref: 1,
        created_at: /^\d{4}-\d{2}-\d{2}$/.test(meta.created || '') ? `${meta.created}T00:00:00.000Z` : now,
        updated_at: now,
      };
      const info = insertMistake.run(values);
      if (info.changes) {
        added.mistakes += 1;
        added.awaitingTextbookRef += 1;
      }

      const row = findMistake.get(meta.id);
      if (!row) {
        added.errors.push(`${file}: 无法定位导入后的错题`);
        continue;
      }
      for (const variant of parseVariants(sec['变式训练'])) {
        added.variants += insertVariant.run(
          row.id, variant.level, variant.prompt, `${meta.id}:${variant.level}`,
        ).changes;
      }
    }
  });

  const total = {
    mistakes: db.prepare('SELECT COUNT(*) c FROM mistakes').get().c,
    variants: db.prepare('SELECT COUNT(*) c FROM variants').get().c,
    textbookNodes: db.prepare('SELECT COUNT(*) c FROM textbook_nodes').get().c,
    awaitingTextbookRef: db.prepare('SELECT COUNT(*) c FROM mistakes WHERE needs_textbook_ref = 1').get().c,
    reviewing: db.prepare("SELECT COUNT(*) c FROM mistakes WHERE status = 'reviewing'").get().c,
  };
  return { added, total };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const legacyRoot = process.env.LEGACY_ROOT ? resolve(process.env.LEGACY_ROOT) : DEFAULT_LEGACY_ROOT;
  const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
  if (!existsSync(legacyRoot)) {
    console.error(`[import] 旧库目录不存在：${legacyRoot}`);
    process.exit(1);
  }
  const db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  const result = importLegacy({ legacyRoot, dataDir, db });
  console.log('[import] 本次新增：' + JSON.stringify(result.added));
  console.log('[import] 当前总量：' + JSON.stringify(result.total));
  console.log('[import] 旧库只读，未写入任何文件。');
  closeDb(db);
}
