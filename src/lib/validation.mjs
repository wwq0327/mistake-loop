import { SUBJECTS, CATEGORIES, LEVELS, EVIDENCE_KINDS, STATUSES } from '../state-machine.mjs';
import { subtypesFor, allSubtypesFor, SUBJECT_LABEL, UNCLASSIFIED } from './subjects.mjs';

export class ValidationError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = 400;
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function assert(condition, message, code) {
  if (!condition) throw new ValidationError(message, code);
}

export function notFound(message) {
  throw new HttpError(404, 'NOT_FOUND', message);
}

export function conflict(message) {
  throw new HttpError(409, 'INVALID_STATE', message);
}

function oneOf(value, allowed, label) {
  assert(allowed.includes(value), `${label} 必须是 ${allowed.join(' / ')} 之一`, 'INVALID_ENUM');
  return value;
}

export const checkSubject = (v) => oneOf(v, SUBJECTS, 'subject');
export const checkCategory = (v) => oneOf(v, CATEGORIES, 'error_category');
export const checkLevel = (v) => oneOf(v, LEVELS, 'level');
export const checkStatus = (v) => oneOf(v, STATUSES, 'status');
export const checkEvidence = (v) => oneOf(v, EVIDENCE_KINDS, 'evidence_type');
export const checkResult = (v) => oneOf(v, ['correct', 'wrong'], 'result');

// 三科分开：错因子类型必须取自该科目该大类的字典，不共用数学那一套。
// 语文题挂「计算失误」这类越界写法一律拒绝，并告诉老师这个科目能选什么。
export function checkSubtype(subject, category, value) {
  if (value === undefined || value === null || value === '') return value ?? null;
  assert(typeof value === 'string', '错因子类型必须是文本', 'INVALID_TYPE');
  const allowed = category ? subtypesFor(subject, category) : [UNCLASSIFIED];
  if (!allowed.includes(value)) {
    const label = SUBJECT_LABEL[subject] ?? subject;
    const scope = category
      ? `该大类下可用：${allowed.join('、')}`
      : `还没定错因大类，只能填「${UNCLASSIFIED}」`;
    throw new ValidationError(
      `${label}没有「${value}」这个子类型，${label}可用：${allSubtypesFor(subject).join('、')}（${scope}）`,
      'INVALID_SUBTYPE',
    );
  }
  return value;
}

export function checkDate(v) {
  assert(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v), '日期格式应为 YYYY-MM-DD', 'INVALID_DATE');
  return v;
}

export function checkId(raw) {
  const id = Number(raw);
  assert(Number.isInteger(id) && id > 0, 'id 必须是正整数', 'INVALID_ID');
  return id;
}

export function checkText(value, label, { required = false, max = 20000 } = {}) {
  if (value === undefined || value === null || value === '') {
    assert(!required, `${label}不能为空`, 'REQUIRED');
    return value ?? null;
  }
  assert(typeof value === 'string', `${label}必须是文本`, 'INVALID_TYPE');
  assert(value.length <= max, `${label}超过 ${max} 字`, 'TOO_LONG');
  return value;
}

// 教材定位是数据主键：节点与错题必须同一科目、同一册次、同一版本。
// 三条写入路径（POST /mistakes、POST /mistakes/batch-textbook-ref、PATCH /mistakes/:id/diagnosis）
// 共用这一份判定，避免各处口径不一；不匹配就拒绝，不猜。
// 册次「未知」（NULL）不等于「冲突」：错题没记册次时，节点的册次就是正确值，直接回填。
export function assertTextbookCompatible(mistake, node, { ids = [] } = {}) {
  const label = ids.length ? `第 ${ids.join('、')} 题` : '错题';
  if (mistake.subject !== node.subject) {
    throw new ValidationError(
      `挂错科目：${label} 是 ${mistake.subject} 的题，不能挂到 ${node.subject} 的节点上`,
      'SUBJECT_MISMATCH',
    );
  }
  const known = (value) => value !== null && value !== undefined && value !== '';
  if (known(mistake.grade) && Number(mistake.grade) !== Number(node.grade)) {
    throw new ValidationError(
      `年级不一致：${label} 是 ${mistake.grade} 年级，节点是 ${node.grade} 年级`,
      'GRADE_MISMATCH',
    );
  }
  if (known(mistake.semester) && Number(mistake.semester) !== Number(node.semester)) {
    throw new ValidationError(
      `册次不一致：${label} 是第 ${mistake.semester} 册，节点是第 ${node.semester} 册`,
      'SEMESTER_MISMATCH',
    );
  }
  return true;
}

// 教材字段一律以节点为准：调用方手写的 grade/semester/unit_* 一律忽略。
export function textbookFieldsFromNode(node) {
  return {
    edition: node.edition,
    grade: node.grade,
    semester: node.semester,
    unit_no: node.unit_no,
    unit_title: node.unit_title,
    lesson_title: node.lesson_title ?? '',
  };
}

// 转义用户内容，前端一律用 textContent；此处给需要拼 HTML 的几何图用。
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
