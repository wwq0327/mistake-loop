// 草稿确认失败的每一种原因：机器码 → 老师看得懂的一句话 + 能不能靠「再点一次」解决。
//
// 单一事实源：路由只吐机器码，界面只显示这里写好的中文。
// 两边都不各写一份映射表——写两份就会漂，漂了就等于没做分类。
//
// retryable 只给「老师改完再来一次能成」的失败：
// 输入类（没选科目、题干空、题干过长）改了就好，值得给重试；
// 状态类（已处理、已不存在、编号不对）原样再试必然同样失败，
// 给按钮就是个死循环——这正是 #59 要治的毛病。
export const DRAFT_FAILURES = {
  NOT_FOUND: {
    text: '这条草稿已经不在了（可能已被丢弃）。要入库请回到照片上重新框选。',
    retryable: false,
  },
  INVALID_STATE: {
    text: '这条草稿已经被处理过，不能重复入库。要入库请回照片上重新框选。',
    retryable: false,
  },
  INVALID_ID: {
    text: '这条草稿的编号不对，没法处理。',
    retryable: false,
  },
  SUBJECT_REQUIRED: {
    text: '还没选科目：选好科目后再确认入库。',
    retryable: true,
  },
  PROMPT_REQUIRED: {
    text: '题干是空的：把题干手填上再确认入库。',
    retryable: true,
  },
  TOO_LONG: {
    text: '题干超过 2000 字：改短一点再确认入库。',
    retryable: true,
  },
};

// 没登记过的码走这里：也必须是中文，且默认不可重试。
// 宁可少给一个按钮，也别给一个必然再失败一次的死循环。
export const UNKNOWN_FAILURE = {
  text: '确认失败，原因不明：请在这条草稿上单独确认，看具体提示。',
  retryable: false,
};

export function draftFailure(code) {
  return DRAFT_FAILURES[code] ?? UNKNOWN_FAILURE;
}

export function draftFailureText(code) {
  return draftFailure(code).text;
}
