import { addDays } from './lib/dates.mjs';

export const STATUSES = ['new', 'diagnosing', 'correcting', 'reviewing', 'mastered'];

// 状态中文名。报错时给老师看中文，不给 new / correcting 这种内部值。
export const STATUS_LABEL = {
  new: '新录入',
  diagnosing: '诊断中',
  correcting: '纠错中',
  reviewing: '复习中',
  mastered: '已掌握',
};
export const SUBJECTS = ['math', 'chinese', 'english'];
export const CATEGORIES = ['conceptual', 'procedural', 'metacognitive', 'factual'];
export const LEVELS = ['surface', 'structure', 'context'];
export const EVIDENCE_KINDS = [
  'retell', 'same_structure_variant', 'spaced_recall', 'self_check_method', 'teach_others',
];

// round -> 距今天数。第 4 轮做对但无证据时仍按 30 天再约一次，不卡死。
export const INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 30 };

// AI 识别任务的人工重试上限。
// 依据 docs/requirements/AI-vision-spec.md 第 86 行：failed → queued（人工重试，最多 2 次）。
// 每次人工重试都会再走一遍 provider、消耗调用额度，所以次数要封顶并记在库里
// （recognition_jobs.manual_retries）。
export const MANUAL_RETRY_LIMIT = 2;

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

// 允许做诊断的状态白名单：这三态才能记错因、才能推进到「纠错中」。
// 复习中与已掌握的题不再走诊断流程——把它们推回纠错中等于作废已有的复习成果。
// 后端 PATCH /mistakes/:id/diagnosis 与详情页的动作按钮共用这一份：
// 服务端通过 /api/meta 下发，前端本地那份只是兜底，两处由测试锁住必须一致（#57）。
export const DIAGNOSABLE_STATUSES = ['new', 'diagnosing', 'correcting'];

// 变式审核允许的前置状态：诊断中与纠错中。
// 拦的是那三种「审核变式会毁掉已有成果或跳过诊断」的状态：
//   new      —— 刚录入、还没诊断，直接三层全过就进复习中，等于跳过诊断阶段；
//   reviewing—— 已在复习，审核变式会把复习轮次归零，破坏 1-3-7-30 的节奏；
//   mastered —— 已掌握，审核变式会把掌握成果清空（fail 打回诊断还会抹掉 mastered_at 与掌握证据）。
// 注意 diagnosing 必须在允许列表里：v1 的接口流程就是
// 「录入 → diagnosing → 审核三层 → reviewing」，这条既有测试一个都不能改。
export const VARIANT_REVIEW_FROM = ['diagnosing', 'correcting'];

// results: [{level, result}]，只接受已审核的变式。返回 null 表示暂不推进状态。
// mistake 可选：传了就自己守闸门（规则的归属地在这里），
// 不传则只做纯计算——v1 的状态机测试是这么调的，既有行为不能变。
export function applyVariantResults({ mistake, results, today }) {
  if (mistake !== undefined && mistake !== null) {
    const status = mistake.status;
    if (!VARIANT_REVIEW_FROM.includes(status)) {
      throw new Error(`invalid variant review state: ${status}（只能在「${VARIANT_REVIEW_FROM.map((s) => STATUS_LABEL[s] ?? s).join(' / ')}」状态下审核变式）`);
    }
  }
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
