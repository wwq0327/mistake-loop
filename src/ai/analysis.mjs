// #72 AI 错步分析草稿的清洗与校验。
//
// 模型输出不可直接进界面：空泛结论（粗心、基础差）、凭空引用、一次问好几个问题，
// 都会让老师误以为「分析已经成立」。这里把模型输出压成固定结构，并把不可信的地方
// 显式标出来——宁可停在「待核对」，也不给一个看着像结论的猜测。
//
// 红线：本模块不产生学生第一人称结论，也不写任何学习状态。

export const ANALYSIS_FLAGS = {
  VAGUE_REASON: 'VAGUE_REASON',
  NO_PROCESS: 'NO_PROCESS',
  BASIS_MISMATCH: 'BASIS_MISMATCH',
  MULTI_QUESTION: 'MULTI_QUESTION',
};

// 空泛说法：说了等于没说。命中不等于分析错了，只是不能当结论用。
const VAGUE_PATTERNS = [/粗心/, /马虎/, /不认真/, /态度不端/, /基础差/, /太笨/, /没有认真/];

const PENDING_STEP = '待核实：只给了空泛说法，得先定位具体错在哪一步';
const FALLBACK_HYPOTHESIS = '待验证：错步还没定位，先用一个验证问题问清楚';

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function asList(value) {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value);
  return text ? [text] : [];
}

function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 从「依据」里抽出可核对的片段：引号里的文字与分数/数字。它们必须真的出现在原题或学生作答里。
function quotedFragments(text) {
  const out = [];
  for (const m of text.matchAll(/[「『"'“]([^」』"'”]{1,40})[」』"'”]/g)) out.push(m[1]);
  for (const m of text.matchAll(/\d+\/\d+|\d+(?:\.\d+)?/g)) out.push(m[0]);
  return out;
}

function basisMismatch(basis, source) {
  const text = basis.join('\n');
  const fragments = quotedFragments(text);
  if (fragments.length === 0) return false;
  // 只要有一个引用片段在原题与学生作答里都找不到，就说明模型在编。
  return fragments.some((fragment) => !source.includes(fragment));
}

export function normalizeAnalysis(raw, { mistake = {}, now = new Date().toISOString() } = {}) {
  const data = safeParse(raw);
  const flags = [];

  let errorStep = asText(data.error_step);
  if (VAGUE_PATTERNS.some((re) => re.test(errorStep))) {
    flags.push(ANALYSIS_FLAGS.VAGUE_REASON);
    errorStep = PENDING_STEP;
  }

  const basis = asList(data.basis ?? data.evidence);
  const source = `${mistake.prompt ?? ''}\n${mistake.student_answer ?? ''}\n${mistake.correct_answer ?? ''}`;
  if (basisMismatch(basis, source)) flags.push(ANALYSIS_FLAGS.BASIS_MISMATCH);

  // 没有学生作答痕迹，就不可能知道错在哪一步，只能给假设。
  if (!mistake.student_answer) flags.push(ANALYSIS_FLAGS.NO_PROCESS);

  const rawQuestions = Array.isArray(data.verification_question)
    ? data.verification_question
    : (data.verification_questions ?? data.verification_question);
  const questions = asList(rawQuestions);
  if (questions.length > 1) flags.push(ANALYSIS_FLAGS.MULTI_QUESTION);
  // 一次一问：多给的只留第一个，不合并成一句话糊弄过去。
  const verificationQuestion = questions[0] ?? '';

  let hypotheses = asList(data.hypotheses ?? data.hypothesis);
  if (flags.includes(ANALYSIS_FLAGS.VAGUE_REASON) && hypotheses.length === 0) {
    hypotheses = [FALLBACK_HYPOTHESIS];
  }

  const needsCheck = flags.some((f) => f !== ANALYSIS_FLAGS.MULTI_QUESTION);

  return {
    kind: 'analysis',
    status: needsCheck ? 'needs_check' : 'ok',
    definitive: !flags.includes(ANALYSIS_FLAGS.NO_PROCESS),
    target_ability: asText(data.target_ability),
    error_step: errorStep,
    basis,
    uncertainties: asList(data.uncertainties ?? data.pending),
    verification_question: verificationQuestion,
    question_count: verificationQuestion ? 1 : 0,
    hypotheses,
    flags,
    teacher_quote: null,
    revisions: [],
    normalized_at: now,
  };
}

// 真实 provider 用的提示词（#72 只定义结构；密钥与外发开关仍由 provider 管）。
export function buildAnalysisPrompt(mistake) {
  return [
    '你是小学老师的助教，只做「错步分析」草稿，不下定论。',
    '只输出 JSON，字段：target_ability, error_step, basis[], uncertainties[], verification_question, hypotheses[]。',
    '要求：',
    '1) 引用必须来自原题或学生作答，不要编造；',
    '2) 过程不足时只给假设，不要写「粗心」「基础差」这类空话；',
    '3) verification_question 只能一个，用来问清关键一步；',
    '4) 不要替学生写第一人称结论。',
    `科目：${mistake.subject ?? ''}`,
    `题干：${mistake.prompt ?? ''}`,
    `学生作答：${mistake.student_answer ?? '（没有作答痕迹）'}`,
    `正确答案：${mistake.correct_answer ?? ''}`,
  ].join('\n');
}
