// 三科错因与变式规则分列，不把数学的题型结构套到语文、英语上。
export const UNCLASSIFIED = '待归类';

// 教材版本定死（四上）。册次允许多册共存，旧 19 题是三下。
export const EDITIONS = { math: '人教版', chinese: '统编版', english: '人教版PEP' };

// 数学子类型来自 mistake-wiki/wiki/error-types.md 已验证条目；
// 语文只收旧库 3 道错题里实际出现过的；英语第一版留空，等真实错题积累后再补。
export const ERROR_SUBTYPES = {
  math: {
    conceptual: ['单位混淆', '概念混淆', '进率混淆', '倍数混淆'],
    procedural: ['计算失误', '步骤错用', '审题失误', '步骤遗漏'],
    metacognitive: ['畏难放弃', '思路卡壳', '时间管理'],
    factual: ['公式遗忘', '进率遗忘'],
  },
  chinese: {
    conceptual: ['近义词混淆'],
    procedural: [],
    metacognitive: [],
    factual: ['部首遗忘'],
  },
  english: {
    conceptual: [],
    procedural: [],
    metacognitive: [],
    factual: [],
  },
};

// 出题方向提示，只给教师看，永不出现在学生版打印页。
export const VARIANT_RULES = {
  math: {
    surface: '只换数字和单位，题型与解法不变',
    structure: '换一个解题角度，或增加一步推理',
    context: '换到真实生活场景，条件重新叙述',
  },
  chinese: {
    surface: '换一个词或一句话，考点不变',
    structure: '换一种问法或表达顺序',
    context: '换到另一篇课文或真实语境',
  },
  english: {
    surface: '换单词或数字，句型不变',
    structure: '换句型或时态',
    context: '换到真实对话场景',
  },
};

export function subtypesFor(subject, category) {
  return [...(ERROR_SUBTYPES[subject]?.[category] ?? []), UNCLASSIFIED];
}

// 某科目全部可用子类型（跨大类去重），用于报错时告诉老师「这个科目能选什么」。
export function allSubtypesFor(subject) {
  const byCategory = ERROR_SUBTYPES[subject] ?? {};
  const all = [...new Set(Object.values(byCategory).flat())];
  return [...all, UNCLASSIFIED];
}

export const SUBJECT_LABEL = { math: '数学', chinese: '语文', english: '英语' };
