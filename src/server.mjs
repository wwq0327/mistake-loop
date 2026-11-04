import express from 'express';
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, closeDb } from './db.mjs';
import { startScheduler } from './scheduler.mjs';
import { nowIso } from './lib/dates.mjs';
import { createMetaRouter } from './routes/meta.mjs';
import { createMistakesRouter } from './routes/mistakes.mjs';
import { createVariantsRouter } from './routes/variants.mjs';
import { createReviewsRouter } from './routes/reviews.mjs';
import { createPrintRouter } from './routes/print.mjs';
import { createRecognitionsRouter } from './routes/recognitions.mjs';
import { createProvider } from './ai/provider.mjs';
import { createJobWorker } from './ai/jobs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function createApp({ db, dataDir, schedulerState = { running: false, lastRunAt: null, lastResult: null }, recognitionWorker = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));
  app.use('/images', express.static(join(dataDir, 'images')));

  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return res.status(500).json({ ok: false, db: 'error' });
    }
    return res.json({ ok: true, db: 'ok', scheduler: schedulerState, now: nowIso() });
  });

  app.use('/api', createMetaRouter({ db }));
  app.use('/api', createMistakesRouter({ db, dataDir }));
  app.use('/api', createVariantsRouter({ db }));
  app.use('/api', createReviewsRouter({ db }));
  app.use('/api', createPrintRouter({ db }));
  app.use('/api', createRecognitionsRouter({ db, dataDir, worker: recognitionWorker }));

  // 六页信息架构：路径按动作命名，静态文件名只作载体。
  const pageRoutes = [
    ['/', 'index.html'],
    ['/inbox', 'inbox.html'],
    ['/mistake/:id', 'detail.html'],
    ['/print', 'print.html'],
    ['/library', 'library.html'],
    ['/settings', 'settings.html'],
  ];
  for (const [route, file] of pageRoutes) {
    app.get(route, (req, res) => res.sendFile(join(publicDir, file)));
  }

  app.use(express.static(publicDir));

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }));
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error('[server]', err.message);
    res.status(status).json({
      error: {
        code: err.code ?? 'INTERNAL',
        message: status >= 500 ? '服务端错误' : err.message,
      },
    });
  });
  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
  mkdirSync(join(dataDir, 'images'), { recursive: true });

  const db = openDb(join(dataDir, 'mistakes.db'));
  migrate(db);
  db.prepare("INSERT OR IGNORE INTO students (id, name, created_at) VALUES (1, '默认学生', ?)")
    .run(nowIso());

  const scheduler = startScheduler(db);
  const aiProvider = createProvider();
  const recognitionWorker = createJobWorker({
    db,
    provider: aiProvider,
    dataDir,
    options: { dailyLimit: aiProvider.config.dailyLimit },
  });
  recognitionWorker.start();
  const app = createApp({ db, dataDir, schedulerState: scheduler.state, recognitionWorker });
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, () => {
    console.log(`[mistake-loop] http://0.0.0.0:${port} | ${new Date().toISOString()}`);
  });

  const shutdown = () => {
    scheduler.stop();
    void recognitionWorker.stop();
    server.close(() => {
      closeDb(db);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
