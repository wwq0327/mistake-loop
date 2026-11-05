// #71 后台 AI 多阶段任务编排（F32）。
//
// 三条硬规矩：
//   1. 本模块只写 ai_tasks。绝不写 mistakes 状态、variants.student_result、
//      mastery_evidence、review_events —— 那些是教师事件与学生真实作答的地盘。
//   2. 所有输出都是草稿：confirmed_at 为空即未确认，未确认内容不得进入练习与统计。
//   3. 幂等身份 = 阶段:对象类型:对象 id:输入指纹；输入变了，旧任务作废但不删行。
import { createHash } from 'node:crypto';

export const STAGE_KINDS = ['analysis', 'practice', 'validation', 'delayed'];

// 阶段依赖：分析 → 备题 → 校验；延迟新题挂在备题之后。
// 上游输入一变，下游整体作废（但分析自己不受备题影响）。
const DOWNSTREAM = {
  analysis: ['practice', 'validation', 'delayed'],
  practice: ['validation', 'delayed'],
  validation: [],
  delayed: [],
};

const NEXT_STAGE = { analysis: 'practice', practice: 'validation' };

const TOUCHED_COLUMNS = `
  subject, prompt, student_answer, correct_answer, image_path, clean_image_path,
  student_conclusion, error_category, error_subtype, updated_at
`;

function fingerprint(parts) {
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

function dayStartIso(nowIso) {
  const shifted = new Date(new Date(nowIso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(`${shifted}T00:00:00+08:00`).toISOString();
}

// 配额口径：识别任务与 AI 阶段任务合并计数。合并的理由是它们共用同一个上游额度，
// 分开数会让「今日已用 X 次」在界面上忽多忽少。
export function dailyUsed(db, nowIso = new Date().toISOString()) {
  const since = dayStartIso(nowIso);
  const jobs = db.prepare('SELECT COUNT(*) c FROM recognition_jobs WHERE attempts > 0 AND created_at >= ?').get(since).c;
  const tasks = db.prepare('SELECT COUNT(*) c FROM ai_tasks WHERE attempts > 0 AND created_at >= ?').get(since).c;
  return jobs + tasks;
}

function upstreamVersion(db, { targetType, targetId, kind }) {
  if (kind === 'analysis') return '';
  const upstreamKind = kind === 'practice' ? 'analysis' : 'practice';
  const row = db.prepare(`
    SELECT input_version FROM ai_tasks
    WHERE target_type = ? AND target_id = ? AND kind = ?
    ORDER BY id DESC LIMIT 1
  `).get(targetType, targetId, upstreamKind);
  return row?.input_version ?? 'none';
}

function latestResult(db, { targetType, targetId, kind }) {
  const row = db.prepare(`
    SELECT result_json FROM ai_tasks
    WHERE target_type = ? AND target_id = ? AND kind = ? AND result_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(targetType, targetId, kind);
  return row?.result_json ?? '';
}

// 输入指纹：只取真正影响本阶段结果的字段。
// 老师改题干、单位、否定词、换图或补学生结论，指纹都会变，旧任务随之作废。
export function inputVersion(db, { kind, targetType = 'mistake', targetId }) {
  const mistake = db.prepare(`SELECT ${TOUCHED_COLUMNS} FROM mistakes WHERE id = ?`).get(targetId);
  const core = mistake
    ? [
      mistake.subject, mistake.prompt, mistake.student_answer, mistake.correct_answer,
      mistake.image_path, mistake.clean_image_path, mistake.updated_at,
    ].join('|')
    : `missing:${targetType}:${targetId}`;

  const parts = [kind, targetType, String(targetId), core];
  if (kind !== 'analysis') parts.push(mistake?.student_conclusion ?? '');
  if (kind === 'practice') parts.push(upstreamVersion(db, { targetType, targetId, kind }));
  if (kind === 'validation') {
    parts.push(upstreamVersion(db, { targetType, targetId, kind }));
    parts.push(fingerprint([latestResult(db, { targetType, targetId, kind: 'practice' })]));
  }
  if (kind === 'delayed') parts.push(upstreamVersion(db, { targetType, targetId, kind }));
  return fingerprint(parts);
}

function supersedeOutdated(db, { kind, targetType, targetId, idemKey, now }) {
  const kinds = [kind, ...DOWNSTREAM[kind]];
  const placeholders = kinds.map(() => '?').join(', ');
  db.prepare(`
    UPDATE ai_tasks
    SET status = 'superseded', superseded_at = ?
    WHERE target_type = ? AND target_id = ? AND kind IN (${placeholders})
      AND status != 'superseded' AND idem_key != ?
  `).run(now, targetType, targetId, ...kinds, idemKey);
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(id);
}

export function listTasks(db, { targetType = 'mistake', targetId }) {
  return db.prepare(`
    SELECT * FROM ai_tasks WHERE target_type = ? AND target_id = ? ORDER BY id
  `).all(targetType, targetId);
}

// 建任务：同幂等键直接复用（不重复消耗额度），输入变了才新建并作废旧任务。
// 额度不足不抛错，落一条 blocked —— 界面要显示「待处理」，不是弹一个失败框。
export function createTask(db, {
  kind, targetType = 'mistake', targetId, now = new Date().toISOString(), quota = null,
}) {
  if (!STAGE_KINDS.includes(kind)) {
    throw Object.assign(new Error(`未知阶段：${kind}`), { code: 'INVALID_KIND' });
  }
  const version = inputVersion(db, { kind, targetType, targetId });
  const idemKey = `${kind}:${targetType}:${targetId}:${version}`;

  const existing = db.prepare('SELECT * FROM ai_tasks WHERE idem_key = ?').get(idemKey);
  if (existing) return { task: existing, reused: true };

  const limit = quota === null || quota === undefined ? null : Number(quota);
  const overQuota = limit !== null && Number.isFinite(limit) && dailyUsed(db, now) >= limit;

  supersedeOutdated(db, { kind, targetType, targetId, idemKey, now });

  const info = db.prepare(`
    INSERT INTO ai_tasks (kind, target_type, target_id, input_version, idem_key, status, error_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind, targetType, targetId, version, idemKey,
    overQuota ? 'blocked' : 'queued',
    overQuota ? 'QUOTA_EXCEEDED' : null,
    now,
  );
  return { task: getTask(db, Number(info.lastInsertRowid)), reused: false };
}

// 重启恢复：上次进程死在 running 的任务要能接着跑。
// 未超次数的回队；超次数的直接 failed，别让它无限空转。
export function recoverStaleTasks(db, {
  now = () => new Date().toISOString(), staleMs = 30 * 60 * 1000, maxAttempts = 3,
} = {}) {
  const nowMs = Date.parse(now());
  const rows = db.prepare("SELECT * FROM ai_tasks WHERE status = 'running'").all();
  let requeued = 0;
  let failed = 0;

  for (const row of rows) {
    const started = row.started_at ? Date.parse(row.started_at) : 0;
    if (Number.isFinite(started) && nowMs - started < staleMs) continue;

    if (row.attempts >= maxAttempts) {
      db.prepare(`
        UPDATE ai_tasks SET status = 'failed', error_code = 'MAX_ATTEMPTS', finished_at = ? WHERE id = ?
      `).run(now(), row.id);
      failed += 1;
    } else {
      db.prepare("UPDATE ai_tasks SET status = 'queued', started_at = NULL WHERE id = ?").run(row.id);
      requeued += 1;
    }
  }
  return { requeued, failed };
}

function buildInput(db, task) {
  const mistake = db.prepare(`SELECT ${TOUCHED_COLUMNS} FROM mistakes WHERE id = ?`).get(task.target_id);
  const upstream = task.kind === 'analysis'
    ? null
    : latestResult(db, { targetType: task.target_type, targetId: task.target_id, kind: task.kind === 'practice' ? 'analysis' : 'practice' });
  return { kind: task.kind, mistake, upstream };
}

// 跑一条排队任务。成功写 result_json（仍为草稿），失败记错误码；两种情况都不碰学习记录。
export async function runTaskOnce({ db, provider, now = () => new Date().toISOString() }) {
  const task = db.prepare("SELECT * FROM ai_tasks WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  if (!task) return { ran: false, reason: 'empty' };

  if (!provider || provider.isEnabled === false) {
    db.prepare("UPDATE ai_tasks SET status = 'blocked', error_code = 'AI_DISABLED', finished_at = ? WHERE id = ?")
      .run(now(), task.id);
    return { ran: false, reason: 'disabled', task: getTask(db, task.id) };
  }
  // 只接了识别的 provider 还不能跑分析/备题；先挡住，等 #72/#73 补上阶段实现。
  if (typeof provider.runStage !== 'function') {
    db.prepare("UPDATE ai_tasks SET status = 'blocked', error_code = 'NOT_CONFIGURED', finished_at = ? WHERE id = ?")
      .run(now(), task.id);
    return { ran: false, reason: 'no-stage', task: getTask(db, task.id) };
  }

  db.prepare('UPDATE ai_tasks SET status = ?, attempts = attempts + 1, started_at = ? WHERE id = ?')
    .run('running', now(), task.id);

  try {
    const output = await provider.runStage(buildInput(db, task));
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    db.prepare("UPDATE ai_tasks SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?")
      .run(text, now(), task.id);

    const next = NEXT_STAGE[task.kind];
    if (next) {
      createTask(db, { kind: next, targetType: task.target_type, targetId: task.target_id, now: now() });
    }
    return { ran: true, task: getTask(db, task.id) };
  } catch (err) {
    db.prepare(`
      UPDATE ai_tasks SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?
    `).run(err?.code ?? 'UPSTREAM_ERROR', String(err?.message ?? err), now(), task.id);
    return { ran: true, task: getTask(db, task.id) };
  }
}
