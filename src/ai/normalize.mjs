// 识别结果清洗器：纯函数，零 IO、零网络、不读环境变量。
// 唯一职责是把上游给的文本变成「可以进 recognition_drafts 的干净结构」。
// 教学法红线：任何模型给出的答案都只是草稿，一律标 needs_teacher_check。

export const LOW_CONFIDENCE = 0.6;
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_TEXT_LENGTH = 500;
export const MAX_QUESTIONS = 20;

const SUBJECTS = new Set(['math', 'chinese', 'english']);
const CONFIDENCE_FIELDS = ['prompt', 'student_answer', 'subject_hint', 'options', 'question_type', 'knowledge_hint'];
const UNCERTAIN_FIELDS = new Set([
  'prompt', 'student_answer', 'subject_hint', 'options', 'question_type',
  'knowledge_hint', 'bbox', 'has_figure', 'figure_desc',
]);
const CLEAR_TARGET = {
  prompt: 'prompt',
  student_answer: 'student_answer_draft',
  subject_hint: 'subject',
  options: 'options',
  question_type: 'question_type',
  knowledge_hint: 'knowledge_hint',
  bbox: 'bbox',
  has_figure: 'has_figure',
  figure_desc: 'figure_desc',
};

function text(value, max = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

function clamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function bboxOf(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null;
  const [x1, y1, x2, y2] = nums;
  if (x2 <= x1 || y2 <= y1) return null;
  return nums;
}

function optionsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => text(item, 200)).filter(Boolean);
}

function confidenceOf(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const map = {};
  const provided = new Set();
  for (const field of CONFIDENCE_FIELDS) {
    map[field] = clamp(source[field]);
    if (typeof source[field] === 'number' && Number.isFinite(source[field])) provided.add(field);
  }
  return { map, provided };
}

function uncertainOf(raw, low) {
  const declared = Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && UNCERTAIN_FIELDS.has(item)) : [];
  return [...new Set([...declared, ...low])];
}

function clearField(draft, field) {
  const target = CLEAR_TARGET[field];
  if (!target) return;
  if (target === 'options') draft.options = [];
  else if (target === 'bbox') draft.bbox = null;
  else if (target === 'subject') draft.subject = null;
  else if (target === 'has_figure') draft.has_figure = 0;
  else draft[target] = '';
}

function excerpt(raw) {
  return text(
    String(raw ?? '')
      .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[图片数据已省略]')
      .replace(/\s+/g, ' '),
    500,
  );
}

// 从可能带解释文字、markdown 代码块的上游文本里提取第一个完整 JSON 对象。
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeQuestion(raw, index) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const { map, provided } = confidenceOf(source.confidence);
  const low = [...provided].filter((field) => map[field] < LOW_CONFIDENCE);
  const uncertain = uncertainOf(source.uncertain, low);

  const draft = {
    seq: index + 1,
    bbox: bboxOf(source.bbox),
    subject: SUBJECTS.has(source.subject_hint) ? source.subject_hint : null,
    prompt: text(source.prompt, MAX_PROMPT_LENGTH),
    options: optionsOf(source.options),
    student_answer_draft: text(source.student_answer_draft),
    correct_answer_draft: text(source.correct_answer_draft),
    correct_answer_needs_teacher_check: true,
    question_type: text(source.question_type),
    knowledge_hint: text(source.knowledge_hint),
    has_figure: source.has_figure === true ? 1 : 0,
    figure_desc: text(source.figure_desc),
    confidence: map,
    uncertain,
  };

  for (const field of uncertain) clearField(draft, field);
  return draft;
}

export function normalizeRecognition(raw) {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errorCode: 'INVALID_JSON', rawExcerpt: excerpt(raw) };
  }
  const list = parsed.questions;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, errorCode: 'EMPTY_QUESTIONS', rawExcerpt: excerpt(raw) };
  }
  if (list.length > MAX_QUESTIONS) {
    return { ok: false, errorCode: 'TOO_MANY_QUESTIONS', rawExcerpt: excerpt(raw) };
  }
  const questions = list.map(normalizeQuestion);
  if (questions.some((q) => q.prompt.length === 0)) {
    return { ok: false, errorCode: 'EMPTY_PROMPT', rawExcerpt: excerpt(raw) };
  }
  return {
    ok: true,
    errorCode: null,
    questions,
    pageNote: text(parsed.page_note),
    rawExcerpt: excerpt(raw),
  };
}
