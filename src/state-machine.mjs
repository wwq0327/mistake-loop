import { addDays } from './lib/dates.mjs';

export const STATUSES = ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered'];
export const SUBJECTS = ['math', 'chinese', 'english'];
export const CATEGORIES = ['conceptual', 'procedural', 'metacognitive', 'factual'];
export const LEVELS = ['surface', 'structure', 'context'];
export const EVIDENCE_KINDS = [
  'retell', 'same_structure_variant', 'spaced_recall', 'self_check_method', 'teach_others',
];

// round -> 距今天数。第 4 轮做对但无证据时仍按 30 天再约一次，不卡死。
export const INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 30 };

export function canMaster(round, evidenceCount) {
  return round >= 4 && evidenceCount >= 1;
}

function resetToDiagnosing() {
  return { status: 'diagnosing', review_round: 0, next_review: null, mastered_at: null };
}

// 迟到不重置：函数不读 due_on，只看当前 review_round。
export function applyReview({ mistake, result, today, evidenceCount = 0 }) {
  if (result === 'wrong') return resetToDiagnosing();
  if (result !== 'correct') throw new Error(`invalid review result: ${result}`);

  const round = Math.min((Number(mistake.review_round) || 0) + 1, 4);
  if (canMaster(round, evidenceCount)) {
    return { status: 'mastered', review_round: round, next_review: null, mastered_at: today };
  }
  return {
    status: 'reviewing',
    review_round: round,
    next_review: addDays(today, INTERVALS[round]),
    mastered_at: null,
  };
}

// results: [{level, result}]，只接受已审核的变式。返回 null 表示暂不推进状态。
export function applyVariantResults({ results, today }) {
  const byLevel = new Map();
  for (const item of results) {
    if (!LEVELS.includes(item.level)) throw new Error(`invalid level: ${item.level}`);
    if (!['pass', 'fail'].includes(item.result)) throw new Error(`invalid variant result: ${item.result}`);
    byLevel.set(item.level, item.result);
  }
  if ([...byLevel.values()].includes('fail')) return resetToDiagnosing();
  if (!LEVELS.every((level) => byLevel.get(level) === 'pass')) return null;
  return {
    status: 'reviewing',
    review_round: 0,
    next_review: addDays(today, 1),
    mastered_at: null,
  };
}
