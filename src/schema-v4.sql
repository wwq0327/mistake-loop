-- v4（#71 设计提案已确认）：AI 阶段任务。
-- 只加表，不改任何既有列；旧代码忽略本表，回滚只需 git revert。
-- 红线：本表存的是草稿。confirmed_at 为空即未确认，未确认内容不得进入正式练习与学习统计。

CREATE TABLE IF NOT EXISTS ai_tasks (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('analysis','practice','validation','delayed')),
  target_type    TEXT NOT NULL CHECK (target_type IN ('mistake','draft','batch')),
  target_id      INTEGER NOT NULL,
  -- 输入指纹：题干/作答/结论/图片等参与本阶段的字段变了，指纹就变，旧任务随之作废。
  input_version  TEXT NOT NULL,
  -- 幂等身份 = 阶段:对象类型:对象 id:输入指纹，同键只允许一条。
  idem_key       TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed','superseded','blocked')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  provider       TEXT,
  model          TEXT,
  token_estimate INTEGER,
  error_code     TEXT,
  error_message  TEXT,
  result_json    TEXT,
  confirmed_at   TEXT,
  superseded_at  TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_target ON ai_tasks (target_type, target_id, kind);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks (status);
