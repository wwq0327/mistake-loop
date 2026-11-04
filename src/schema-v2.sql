-- mistake-loop v2：AI 图片识别的任务与草稿表
-- 设计原则：AI 只往这里写草稿，教师确认后才进 mistakes。
-- 本文件由 migrateV2() 执行，对已有库幂等；不删表、不重建、不改 v1 定义。

CREATE TABLE IF NOT EXISTS recognition_jobs (
  id             INTEGER PRIMARY KEY,
  image_path     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','partial','failed')),
  provider       TEXT,
  model          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT,
  token_estimate INTEGER,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS recognition_drafts (
  id                    INTEGER PRIMARY KEY,
  job_id                INTEGER NOT NULL REFERENCES recognition_jobs(id) ON DELETE RESTRICT,
  seq                   INTEGER NOT NULL,
  bbox                  TEXT,
  subject               TEXT CHECK (subject IN ('math','chinese','english')),
  prompt                TEXT,
  options               TEXT,
  student_answer_draft  TEXT,
  correct_answer_draft  TEXT,
  question_type         TEXT,
  knowledge_hint        TEXT,
  has_figure            INTEGER NOT NULL DEFAULT 0 CHECK (has_figure IN (0,1)),
  figure_desc           TEXT,
  confidence            TEXT,
  uncertain             TEXT,
  raw_excerpt           TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','committed','discarded')),
  mistake_id            INTEGER REFERENCES mistakes(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  reviewed_at           TEXT,
  UNIQUE (job_id, seq)
);

-- 不新增 idx_ 开头的索引：v1 的 test/db.test.mjs D5 断言索引集合恰为三条，
-- 按「已有测试一个不改」的红线，v2 保持索引数量不变。
-- recognition_drafts 已有 UNIQUE(job_id, seq) 自动索引，足够当前单用户数据量。
