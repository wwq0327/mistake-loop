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

  return router;
}
