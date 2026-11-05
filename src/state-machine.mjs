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
// #67 学生本轮作答档位：独立完成 / 提示后完成 / 未完成 / 暂未判断。
export const STUDENT_RESULTS = ['independent', 'hinted', 'unmet', 'unjudged'];

// round -> 距今天数。第 4 轮做对但无证据时仍按 30 天再约一次，不卡死。
export const INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 30 };

// AI 识别任务的人工重试上限。
// 依据 docs/requirements/AI-vision-spec.md 第 86 行：failed → queued（人工重试，最多 2 次）。
// 每次人工重试都会再走一遍 provider、消耗调用额度，所以次数要封顶并记在库里
// （recognition_jobs.manual_retries）。
export const MANUAL_RETRY_LIMIT = 2;

// #69 方案 A（已确认）：掌握闸门 = 第 4 轮的 30 天间隔任务真实完成 + 本轮证据。
// prevRound 是这次做对之前的轮次：只有它已经是 4，这次做对完成的才是那次 +30 的长间隔任务；
// 第一次从 3 走到 4 只是「排下 +30」，不算完成等待。
export function canMaster(prevRound, evidenceCount) {
  return prevRound >= 4 && evidenceCount >= 1;
}

function resetToDiagnosing() {
  return { status: 'diagnosing', review_round: 0, next_review: null, mastered_at: null };
}

// 迟到不重置：函数不读 due_on，只看当前 review_round。
// #69：长间隔任务的「真实完成」还要求等待真的过去——登记当天必须已到或已过
// 该任务排的到期日（next_review）。提前登记不消失，只是不算完成等待，重新排 +30。
export function applyReview({ mistake, result, today, evidenceCount = 0 }) {
  if (result === 'wrong') return resetToDiagnosing();
  if (result !== 'correct') throw new Error(`invalid review result: ${result}`);

  const prevRound = Number(mistake.review_round) || 0;
  const round = Math.min(prevRound + 1, 4);
  const waitElapsed = Boolean(mistake.next_review) && String(today) >= String(mistake.next_review);
  if (canMaster(prevRound, evidenceCount) && waitElapsed) {
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

// results: [{level, quality, student}]，quality 是质量审核结论，student 是学生本轮作答档位。
// 兼容旧调用形状 {level, result}：result 视为 quality，缺 student 视为未登记作答。
// 返回 null 表示暂不推进状态。
// mistake 可选：传了就自己守闸门（规则的归属地在这里），
// 不传则只做纯计算——v1 的状态机测试是这么调的，既有行为不能变。
//
// #67 推进条件（设计提案已确认）：
//   三层质量全 pass + 三层学生作答全是 independent（只审核不推进、提示后不推进、未完成不推进）。
//   学生关键结论非空的检查在路由层（要查库），状态机只认传入的作答结果。
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
    const quality = item.quality ?? item.result;
    if (!['pass', 'fail'].includes(quality)) throw new Error(`invalid variant result: ${quality}`);
    if (item.student != null && !STUDENT_RESULTS.includes(item.student)) {
      throw new Error(`invalid student result: ${item.student}`);
    }
    byLevel.set(item.level, { quality, student: item.student ?? null });
  }
  if ([...byLevel.values()].some((v) => v.quality === 'fail')) return resetToDiagnosing();
  if (!LEVELS.every((level) => byLevel.has(level))) return null;
  if (!LEVELS.every((level) => byLevel.get(level).student === 'independent')) return null;
  return {
    status: 'reviewing',
    review_round: 0,
    next_review: addDays(today, 1),
    mastered_at: null,
  };
}
