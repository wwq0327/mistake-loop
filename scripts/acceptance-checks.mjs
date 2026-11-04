// #37 实现：把验收脚本里会漂的判定抽成纯函数，让「口径」本身可被测试盯住。
// 背景：原 B10 用「磁盘图片文件总数 == 19」判断旧库数据是否丢，
// 但 v2 起 images/ 分 legacy 原图与 derived 派生图两层，两层相加必然不等于 19，
// 于是验收长期挂着一个自相矛盾的 FAIL（证据写 22 张、判定要求 19 张）。
// 这里改成同口径比较：旧库原图 19 张，且孤儿与缺文件都是 0。
export const LEGACY_STATUS_LINES = 28;
export const LEGACY_MISTAKES = 19;
export const LEGACY_VARIANTS = 6;
export const LEGACY_NODES = 25;

export function evaluateB10({ legacyStatusLines, dbCounts, imageCounts }) {
  const counts = imageCounts ?? {};
  const legacyImages = counts.legacy ?? 0;
  const orphan = counts.orphan ?? 0;
  const missing = counts.missing ?? 0;

  const problems = [];
  if (legacyStatusLines !== LEGACY_STATUS_LINES) {
    problems.push(`旧库 git status 是 ${legacyStatusLines} 项，应为 ${LEGACY_STATUS_LINES} 项（全程只读）`);
  }
  if (dbCounts?.mistakes !== LEGACY_MISTAKES) {
    problems.push(`错题 ${dbCounts?.mistakes ?? 0} 道，应为 ${LEGACY_MISTAKES} 道`);
  }
  if (dbCounts?.variants !== LEGACY_VARIANTS) {
    problems.push(`变式 ${dbCounts?.variants ?? 0} 条，应为 ${LEGACY_VARIANTS} 条`);
  }
  if (dbCounts?.textbook_nodes !== LEGACY_NODES) {
    problems.push(`教材节点 ${dbCounts?.textbook_nodes ?? 0} 个，应为 ${LEGACY_NODES} 个`);
  }
  if (legacyImages !== LEGACY_MISTAKES) {
    problems.push(`旧库原图 ${legacyImages} 张，应为 ${LEGACY_MISTAKES} 张`);
  }
  if (orphan !== 0) problems.push(`孤儿图片 ${orphan} 张（磁盘有、库无引用）`);
  if (missing !== 0) problems.push(`缺文件 ${missing} 张（库有引用、磁盘没有）`);

  const evidence = `旧库 git status 仍 ${legacyStatusLines} 项（全程只读）；v1 数据回读 ${dbCounts?.mistakes ?? 0} 题 / ${dbCounts?.variants ?? 0} 变式 / ${dbCounts?.textbook_nodes ?? 0} 个教材节点；图片分层：旧库原图 ${legacyImages} 张 / 压缩派生图 ${counts.derived ?? 0} 张 / 新收件原图 ${counts.root ?? 0} 张 / 被引用 ${counts.referenced ?? 0} 张 / 孤儿 ${orphan} 张 / 缺文件 ${missing} 张`;

  return {
    ok: problems.length === 0,
    evidence: problems.length ? `${evidence}；不通过：${problems.join('；')}` : evidence,
    problems,
  };
}
