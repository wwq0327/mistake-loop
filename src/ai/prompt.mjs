// 识别提示词与输出契约。与请求代码分离，便于单独迭代和审阅。
// 硬要求：严格 JSON、多题切分、低把握留空、不替学生下结论、不给正确答案。

export const OUTPUT_CONTRACT = `请只输出一个严格 JSON 对象，不要任何解释文字或 markdown 代码块：
{
  "questions": [
    {
      "seq": 1,
      "bbox": [x1, y1, x2, y2],
      "subject_hint": "math | chinese | english",
      "prompt": "题干原文",
      "options": [],
      "student_answer_draft": "照片上学生手写的答案（没有就留空字符串）",
      "correct_answer_draft": null,
      "question_type": "题型",
      "knowledge_hint": "知识点",
      "has_figure": false,
      "figure_desc": "图形/表格的文字描述",
      "confidence": { "prompt": 0.0, "student_answer": 0.0, "subject_hint": 0.0 },
      "uncertain": []
    }
  ],
  "page_note": "简短说明"
}`;

export function buildRecognitionPrompt(hint = '') {
  const lines = [
    '你在帮一位小学老师把试卷照片整理成待核对的题目草稿，不是判卷、不是讲题。',
    '规则：',
    '1. 一张照片可能有多道题，按题号与版面切分，一题一条；bbox 为该题在整图中的相对坐标，四个数都在 0 到 1 之间，且 x2>x1、y2>y1。',
    '2. 题干照抄照片上的文字，不要改写、不要补条件、不要编造题目。公式用纯文本可读记法，例如 3/4、12×5。',
    '3. 有几何图、线段图、表格、拼音格等无法转成文字的内容，把 has_figure 设为 true 并在 figure_desc 里描述，不要强行编成文字。',
    '4. 看不清、拿不准、被涂改覆盖的字段：留空字符串，并把字段名写进 uncertain；该字段的 confidence 给低于 0.6 的值。绝不猜一个看起来合理的值。',
    '5. 学生手写答案只作为 student_answer_draft 的草稿，单独给置信度；不要把批改痕迹、红笔字当成题干。',
    '6. correct_answer_draft 一律填 null。不要给正确答案、不要判对错、不要写评语或分数。',
    '7. subject_hint 只能是 math、chinese、english 之一；拿不准就留空并标 uncertain。',
    '8. 如果整张照片没有可辨认的题目，返回 {"questions":[],"page_note":"未识别到题目"}。',
    '9. 每题的 prompt 不能为空；宁可整张判失败，也不要交半截题。',
    OUTPUT_CONTRACT,
  ];
  if (hint) lines.push(`老师补充的提示（仅供参考）：${String(hint).slice(0, 200)}`);
  return lines.join('\n');
}
