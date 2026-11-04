// 教学法红线守门：静态扫描 AI 相关源码 + 运行前后计数快照比对。
// 这不是权限控制，是给 CI 和回归测试用的一把尺子：AI 路径永远不能替学生下结论。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FORBIDDEN_WRITES = [
  [/\bINSERT\s+INTO\s+(?:mastery_evidence|review_events|sessions)\b/i, '写入掌握证据 / 复习事件 / 会话表'],
  [/\bUPDATE\s+mistakes\s+SET\s+status\b/i, '改写已有错题状态'],
  [/\bDELETE\s+FROM\s+mistakes\b/i, '删除错题'],
  [/\bmastered_at\s*=/i, '设置掌握时间'],
  [/\bstudent_conclusion\s*=/i, '替学生写关键结论'],
];

export function scanAiSource(root) {
  const aiDir = join(root, 'src', 'ai');
  const files = [
    ...readdirSync(aiDir).filter((name) => name.endsWith('.mjs')).map((name) => join(aiDir, name)),
    join(root, 'src', 'routes', 'recognitions.mjs'),
  ];
  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, message] of FORBIDDEN_WRITES) {
      if (pattern.test(source)) violations.push(`${relative(root, file)}: ${message}`);
    }
  }
  return violations;
}

export function snapshot(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  return {
    mastery_evidence: count('mastery_evidence'),
    review_events: count('review_events'),
    sessions: count('sessions'),
    mistakes: count('mistakes'),
    statuses: db.prepare('SELECT id, status FROM mistakes ORDER BY id').all(),
  };
}

export function diffRedlines(before, after) {
  const violations = [];
  for (const table of ['mastery_evidence', 'review_events', 'sessions']) {
    const delta = after[table] - before[table];
    if (delta !== 0) violations.push(`${table} 变化 ${delta}`);
  }
  for (const row of before.statuses) {
    const current = after.statuses.find((item) => item.id === row.id);
    if (current && current.status !== row.status) {
      violations.push(`已有错题 #${row.id} 状态 ${row.status} → ${current.status}`);
    }
  }
  return violations;
}
