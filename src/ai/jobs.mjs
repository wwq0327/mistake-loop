// 进程内单并发 worker：扫 queued → 调 provider → normalize 清洗 → 写草稿。
// 红线：本模块只写 recognition_jobs / recognition_drafts，绝不碰 mistakes、
// review_events、mastery_evidence 或已有错题状态。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { withTransaction } from '../db.mjs';
import { normalizeRecognition } from './normalize.mjs';

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export function backoffDelay(attempt, baseMs = 1000) {
  return baseMs * (2 ** Math.max(0, attempt - 1));
}

// 任何失败都不丢原图，也给老师留一条可手填的空白草稿：纯手工路径永远等价可用。
export function ensureManualDraft(db, jobId, nowIso = new Date().toISOString()) {
  const existing = db.prepare("SELECT COUNT(*) c FROM recognition_drafts WHERE job_id = ? AND status = 'pending'").get(jobId).c;
  if (existing > 0) return null;
  const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 s FROM recognition_drafts WHERE job_id = ?').get(jobId).s;
  const info = db.prepare("INSERT INTO recognition_drafts (job_id, seq, prompt, status, created_at) VALUES (?, ?, '', 'pending', ?)")
    .run(jobId, seq, nowIso);
  return Number(info.lastInsertRowid);
}

function dayStartIso(nowIso) {
  const shifted = new Date(new Date(nowIso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(`${shifted}T00:00:00+08:00`).toISOString();
}

function defaultReadImage(job, dataDir) {
  const original = join(dataDir, job.image_path);
  const derived = join(dirname(original), 'derived', basename(original));
  const useDerived = existsSync(derived);
  const path = useDerived ? derived : original;
  return {
    base64: readFileSync(path).toString('base64'),
    mime: useDerived ? 'image/jpeg' : (MIME_BY_EXT[extname(original).toLowerCase()] || 'image/jpeg'),
  };
}

export function createJobWorker({ db, provider, dataDir = null, options = {} } = {}) {
  const config = {
    dailyLimit: Number(options.dailyLimit) > 0 ? Number(options.dailyLimit) : 30,
    maxAttempts: Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 2,
    pollIntervalMs: Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : 3000,
    backoffBaseMs: Number(options.backoffBaseMs) >= 0 ? Number(options.backoffBaseMs) : 1000,
    now: options.now || (() => new Date().toISOString()),
    nowMs: options.nowMs || (() => Date.now()),
    sleep: options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    readImage: options.readImage || ((job) => defaultReadImage(job, dataDir)),
  };

  const state = {
    running: false,
    stopped: false,
    activeJobId: null,
    lastError: null,
    lastRunAt: null,
  };
  let timer = null;
  let activeController = null;
  let activePromise = null;

  function dailyUsed() {
    return db.prepare('SELECT COUNT(*) c FROM recognition_jobs WHERE attempts > 0 AND created_at >= ?')
      .get(dayStartIso(config.now())).c;
  }

  function pickNext() {
    return db.prepare("SELECT * FROM recognition_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  }

  function markFailed(job, code, { attempts } = {}) {
    db.prepare('UPDATE recognition_jobs SET status = ?, error_code = ?, finished_at = ?, attempts = ? WHERE id = ?')
      .run('failed', code, config.now(), attempts ?? job.attempts, job.id);
    ensureManualDraft(db, job.id, config.now());
  }

  function writeDrafts(job, result, status) {
    const insert = db.prepare(`
      INSERT INTO recognition_drafts (
        job_id, seq, bbox, subject, prompt, options, student_answer_draft,
        correct_answer_draft, question_type, knowledge_hint, has_figure,
        figure_desc, confidence, uncertain, raw_excerpt, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    withTransaction(db, () => {
      for (const q of result.questions) {
        insert.run(
          job.id, q.seq,
          q.bbox === null ? null : JSON.stringify(q.bbox),
          q.subject, q.prompt, JSON.stringify(q.options),
          q.student_answer_draft, q.correct_answer_draft,
          q.question_type, q.knowledge_hint, q.has_figure, q.figure_desc,
          JSON.stringify(q.confidence), JSON.stringify(q.uncertain),
          result.rawExcerpt, config.now(),
        );
      }
      const partial = result.questions.some((q) => q.bbox === null || q.uncertain.length > 0);
      db.prepare('UPDATE recognition_jobs SET status = ?, token_estimate = ?, finished_at = ?, error_code = NULL WHERE id = ?')
        .run(partial ? 'partial' : status, Math.ceil(result.rawExcerpt.length / 4), config.now(), job.id);
    });
  }

  async function processJob(job) {
    state.activeJobId = job.id;
    activeController = new AbortController();
    let attempts = job.attempts;

    try {
      while (attempts < config.maxAttempts && !state.stopped) {
        if (dailyUsed() >= config.dailyLimit) {
          markFailed(job, 'QUOTA_EXCEEDED', { attempts });
          state.lastError = 'QUOTA_EXCEEDED';
          return;
        }
        attempts += 1;
        db.prepare("UPDATE recognition_jobs SET status = 'running', attempts = ?, provider = ?, model = ?, error_code = NULL WHERE id = ?")
          .run(attempts, provider.providerName || 'openai-compatible', provider.model || null, job.id);

        try {
          const image = await config.readImage(job);
          const raw = await provider.recognize({
            imageBase64: image.base64,
            mime: image.mime,
            signal: activeController.signal,
          });
          const result = normalizeRecognition(raw);
          if (!result.ok) {
            throw Object.assign(new Error('识别结果不可用'), { code: result.errorCode });
          }
          writeDrafts(job, result, 'done');
          state.lastError = null;
          return;
        } catch (error) {
          const code = error?.code || error?.name || 'UPSTREAM_ERROR';
          state.lastError = code;
          // 关闭信号优先：不把「人为中止」记成识别失败，状态恢复为 queued 以便下次接着跑。
          if (state.stopped || activeController.signal.aborted) {
            db.prepare("UPDATE recognition_jobs SET status = 'queued', error_code = NULL WHERE id = ?").run(job.id);
            return;
          }
          await config.sleep(backoffDelay(attempts, config.backoffBaseMs));
          if (attempts >= config.maxAttempts) {
            markFailed(job, String(code).slice(0, 40), { attempts });
            return;
          }
        }
      }
    } finally {
      state.activeJobId = null;
      activeController = null;
    }
  }

  async function drain() {
    if (state.running || state.stopped) return;
    // 未启用时零调用：job 留在 queued，给每个待办 job 补一条可手填的空白草稿。
    if (!provider.isEnabled) {
      for (const job of db.prepare("SELECT id FROM recognition_jobs WHERE status = 'queued'").all()) {
        ensureManualDraft(db, job.id, config.now());
      }
      return;
    }
    state.running = true;
    activePromise = (async () => {
      let guard = 0;
      try {
        while (!state.stopped && guard < 200) {
          guard += 1;
          const job = pickNext();
          if (!job) break;
          await processJob(job);
        }
      } finally {
        state.running = false;
        state.lastRunAt = config.now();
      }
    })();
    await activePromise;
  }

  function start() {
    if (timer) return;
    state.stopped = false;
    void drain();
    timer = setInterval(() => void drain(), config.pollIntervalMs);
    if (timer.unref) timer.unref();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    state.stopped = true;
    if (activeController && !activeController.signal.aborted) activeController.abort();
    if (activePromise) {
      try { await activePromise; } catch { /* 关闭阶段不抛给调用方 */ }
    }
    state.running = false;
    // 关闭时仍处于 running 的 job 一律恢复 queued，重启可继续。
    // 数据库可能已被调用方关闭，此处不因收尾而抛错。
    try {
      db.prepare("UPDATE recognition_jobs SET status = 'queued' WHERE status = 'running'").run();
    } catch {
      // 已关闭则下次启动自己会重新扫到 queued。
    }
  }

  return { start, stop, drain, processJob, state, aiEnabled: Boolean(provider.isEnabled) };
}
