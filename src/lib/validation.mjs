import { SUBJECTS, CATEGORIES, LEVELS, EVIDENCE_KINDS, STATUSES } from '../state-machine.mjs';

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

// 转义用户内容，前端一律用 textContent；此处给需要拼 HTML 的几何图用。
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
