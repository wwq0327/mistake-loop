// #71 AI 阶段任务的 HTTP 入口。
// 这里只回答「排了什么任务、跑到哪、能重试吗」；确认与教学推进不在这里（#74）。
import { Router } from 'express';
import { assert, checkId, notFound, HttpError } from '../lib/validation.mjs';
import { createTask, getTask, listTasks, STAGE_KINDS } from '../ai/tasks.mjs';

const TARGET_TYPES = ['mistake', 'draft', 'batch'];

export function createAiRouter({ db, pipeline = null, aiControl = null }) {
  const router = Router();

  function requireAi() {
    if (!pipeline || !aiControl || aiControl.enabled !== true) {
      throw new HttpError(409, 'AI_DISABLED', 'AI 已关闭，先用原图与手工路径');
    }
  }

  router.post('/ai/tasks', (req, res) => {
    requireAi();
    const body = req.body ?? {};
    const kind = String(body.kind ?? '');
    assert(STAGE_KINDS.includes(kind), `kind 必须是 ${STAGE_KINDS.join(' / ')} 之一`, 'INVALID_KIND');
    const targetType = body.target_type === undefined ? 'mistake' : String(body.target_type);
    assert(TARGET_TYPES.includes(targetType), `target_type 必须是 ${TARGET_TYPES.join(' / ')} 之一`, 'INVALID_TARGET_TYPE');
    const targetId = checkId(body.target_id);

    if (targetType === 'mistake') {
      const exists = db.prepare('SELECT id FROM mistakes WHERE id = ?').get(targetId);
      if (!exists) notFound('错题不存在');
    }

    const { task, reused } = createTask(db, {
      kind, targetType, targetId, quota: pipeline.quota ?? null,
    });
    res.status(reused ? 200 : 201).json({ task, reused });
  });

  router.get('/ai/tasks', (req, res) => {
    const targetType = req.query.target_type === undefined ? 'mistake' : String(req.query.target_type);
    assert(TARGET_TYPES.includes(targetType), 'target_type 不合法', 'INVALID_TARGET_TYPE');
    const targetId = checkId(req.query.target_id);
    res.json({ tasks: listTasks(db, { targetType, targetId }) });
  });

  // 重试只对 failed / blocked 开放：queued 与 running 重复点会重复消耗。
  router.post('/ai/tasks/:id/retry', (req, res) => {
    const id = checkId(req.params.id);
    const task = getTask(db, id);
    if (!task) notFound('任务不存在');
    if (!['failed', 'blocked'].includes(task.status)) {
      throw new HttpError(409, 'INVALID_STATE', '只有失败或被挡下的任务能重试');
    }
    db.prepare(`
      UPDATE ai_tasks SET status = 'queued', error_code = NULL, error_message = NULL,
        finished_at = NULL, started_at = NULL
      WHERE id = ?
    `).run(id);
    res.json({ task: getTask(db, id) });
  });


  // 老师记一句学生原话，用来修正分析草稿。原话是老师听来的，不是 AI 生成的；
  // 版本记在草稿的 revisions 里，旧版本照样看得见。
  router.post('/ai/tasks/:id/note', (req, res) => {
    const id = checkId(req.params.id);
    const task = getTask(db, id);
    if (!task) notFound('任务不存在');
    if (task.kind !== 'analysis') {
      throw new HttpError(400, 'INVALID_KIND', '只有分析草稿能补学生原话');
    }
    if (task.status !== 'done' || !task.result_json) {
      throw new HttpError(409, 'INVALID_STATE', '任务还没有可用草稿');
    }
    const quote = String(req.body?.student_quote ?? '').trim();
    assert(quote.length > 0, '请写一句学生的原话', 'EMPTY_QUOTE');
    assert(quote.length <= 200, '原话太长了，记一句就够', 'QUOTE_TOO_LONG');

    const draft = JSON.parse(task.result_json);
    const revision = { quote, at: new Date().toISOString(), by: 'teacher' };
    const next = {
      ...draft,
      teacher_quote: quote,
      revisions: [...(Array.isArray(draft.revisions) ? draft.revisions : []), revision],
    };
    db.prepare('UPDATE ai_tasks SET result_json = ? WHERE id = ?').run(JSON.stringify(next), id);
    res.json({ task: getTask(db, id), draft: next });
  });

  return router;
}
