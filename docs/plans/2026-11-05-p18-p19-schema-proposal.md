# P18/P19 设计提案：AI 任务编排、练习批次、分级结果与试运行记录

2026-11-05。对应 Issue #71（F32）、#72（F33）、#73（F34）、#75（F36）、#76（F37）、#77（F38/F39）。本文件只提案，不改任何 schema；维护者确认后按「测试先行 → 迁移 → 实现 → 回读」执行。

沿用 v3 的迁移纪律：纯增量表与新列、`CREATE TABLE IF NOT EXISTS` + 幂等 `PRAGMA` 检查、迁移前自动备份（`scripts/backup.mjs`）、回滚只需 `git revert`，新表留在库里无害。

## 一、共同前提：AI 只产草稿

现有边界不动：AI 不写 `mistakes` 的教学状态、不写 `variants.student_result`、不写 `mastery_evidence`、不写 `review_events`。**所有 AI 输出先落在 `ai_tasks.result_json`，状态一律 `draft`**，只有教师集中确认（#74 的确认入口）才通过既有接口写成正式记录。这样即使模型跑偏，也进不了学习统计。

## 二、#71 AI 任务编排（新增表 `ai_tasks`）

```sql
CREATE TABLE IF NOT EXISTS ai_tasks (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('analysis','practice','validation','delayed')),
  target_type   TEXT NOT NULL CHECK (target_type IN ('mistake','draft','batch')),
  target_id     INTEGER NOT NULL,
  input_version TEXT NOT NULL,             -- 输入指纹，见下
  idem_key      TEXT NOT NULL UNIQUE,      -- kind:target_type:target_id:input_version
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','superseded','blocked')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  provider      TEXT,
  model         TEXT,
  token_estimate INTEGER,
  error_code    TEXT,
  error_message TEXT,
  result_json   TEXT,                      -- 草稿正文；非 NULL 也只当草稿
  confirmed_at  TEXT,                      -- 教师确认时间；NULL = 未确认草稿
  superseded_at TEXT,                      -- 上游版本变更后废弃时间
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_target ON ai_tasks(target_type, target_id, kind);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status);
```

### 输入版本与失效

`input_version` = 影响该阶段结果的最小输入集的 sha256：

| 阶段 | 输入集 |
| --- | --- |
| `analysis` | `mistakes.prompt / student_answer / correct_answer / clean_image_path / image_path` 与关联草稿的 `prompt / student_answer_draft / correct_answer_draft` |
| `practice` | 上述输入 + `mistakes.student_conclusion` + 已确认的错因 `error_category / error_subtype` |
| `validation` | `practice` 的输出候选（`result_json` 里被选中的题面与教师答案） |
| `delayed` | 上一条 `practice` 的 id 与其 `input_version` |

教师改 OCR 字段（含题干、单位、否定词、图片）→ 输入指纹变化 → 旧任务标 `superseded`（`superseded_at` 填时间，行不删）。`superseded` 的草稿不可确认，界面显示「上游已改写，需重跑」。

### 幂等与重启恢复

- 同一 `idem_key` 只允许一条：重复请求返回既有任务（200 + `reused: true`），不再消耗额度。
- 启动时把 `status='running'` 且 `started_at` 早于 30 分钟前的任务重置为 `queued`，`attempts` 不增；`attempts >= 3` 的直接 `failed`，保留 `error_code`。
- 额度：日配额沿用 `provider.config.dailyLimit`，统计口径为「当日 `attempts > 0` 的 `ai_tasks` 与 `recognition_jobs` 之和」；超限新任务进 `blocked`（`error_code='QUOTA_EXCEEDED'`），不抛错，界面显示待处理。

### 存量语义

现有 `recognition_jobs` 保持原样，不合并进 `ai_tasks`：识别阶段已有独立的重试与人工重试计数，合并会改写历史口径。新表只承接识别之后的分析、备题、校验与延迟题。`ai_tasks` 上线时为空表，无存量迁移。

### 接口（暂定）

- `POST /api/ai/tasks`：`{kind, target_type, target_id, force?}` → 建任务或复用既有任务。
- `GET /api/ai/tasks?target_type=&target_id=`：列出各阶段状态，供题卡显示「AI 任务状态与教学状态分开」。
- `POST /api/ai/tasks/:id/retry`：仅 `failed` / `blocked` 可重试，`attempts` 增加。
- 确认入口在 #74，本 Issue 只保证 `confirmed_at` 字段与「未确认不可用」的读取过滤。

## 三、#75 练习批次（新增表 `practice_batches` / `practice_items`）

```sql
CREATE TABLE IF NOT EXISTS practice_batches (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER REFERENCES students(id) ON DELETE SET NULL,
  batch_no     TEXT NOT NULL UNIQUE,        -- 形如 20261105-1，纸面抬头用它
  title        TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','printed','closed')),
  printed_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practice_items (
  id            INTEGER PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES practice_batches(id) ON DELETE RESTRICT,
  seq           INTEGER NOT NULL,           -- 纸面题号，从 1 连续
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('mistake','variant','ai_task')),
  ref_id        INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,              -- 题面/答案/图路径的冻结快照
  UNIQUE (batch_id, seq)
);
```

- **旧纸不被改稿覆盖**：`snapshot_json` 在成卷时冻结；后台改题只影响新批次。打印走既有 `/api/print`，新增「按批次」入口，不再即时拼题。
- **需图题目**沿用 #70 的 `blocked` 规则：需图但无净图的条目阻止成卷，不静默印成无图题。
- **存量**：`practice_batches` 上线前打印过的卷子没有批次号，历史不补造批次；已有打印记录只保留在 `sessions` 与导出文件中。

## 四、#76 分级学习结果与下一轮（复用 + 一条新列）

分级结果沿用 #67 已落地的 `variants.student_result` 四档（`independent / hinted / unmet / unjudged`）与 `mistakes.status`，**不新增结果枚举**。新增的只有「下一轮备什么」：

- `ai_tasks.kind='delayed'` 承接延迟新题：在第 N 轮完成后建任务，题目本身仍是草稿，教师确认后才进下一次 `practice_batches`。
- 判级映射（写入规格，不改表）：`independent` → 正常推进；`hinted` → 不进复习，下一轮同结构再练；`unmet` → 回诊断并清本轮证据（#68 已实现）；`unjudged` → 不进统计，分子分母都不计。

无需新增表；若确认后需要「每轮计划结果」独立留痕，再提一次小列（`mistakes.last_plan_result`）另行确认。

## 五、#77 试运行记录（新增表 `trial_logs`）

```sql
CREATE TABLE IF NOT EXISTS trial_logs (
  id            INTEGER PRIMARY KEY,
  occurred_on   TEXT NOT NULL,              -- YYYY-MM-DD
  kind          TEXT NOT NULL CHECK (kind IN ('teacher_op','ai_draft','result','note')),
  minutes       INTEGER,                    -- 教师主动操作时长，仅 teacher_op
  ai_task_id    INTEGER REFERENCES ai_tasks(id) ON DELETE SET NULL,
  mistake_id    INTEGER REFERENCES mistakes(id) ON DELETE SET NULL,
  batch_id      INTEGER REFERENCES practice_batches(id) ON DELETE SET NULL,
  outcome       TEXT,                       -- 如 usable / unusable / not_attempted
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_logs_day ON trial_logs(occurred_on);
```

- 只记教师主动登记的事实，**不做行为埋点**；「未做」显式记为 `not_attempted`，不折算成错误。
- 周复盘读这张表 + 既有 `review_events / variants.student_result`，两周体验评估不能替代 30 天验证（已在规格中写明）。

## 六、备份 / 恢复 / 回滚

| 项 | 方案 |
| --- | --- |
| 迁移 | 新文件 `src/schema-v4.sql`，`migrateV4(db)` 幂等执行；`schema.sql` 同步包含新表，新库一次建到位 |
| 备份 | 沿用启动前 `backup()`；v4 只加表不改列，空库路径已按 #78 修正（空库跳过备份） |
| 恢复 | `scripts/restore.mjs` 无需改动：快照含全部表 |
| 回滚 | `git revert` + 不删表；旧代码忽略新表，无破坏性影响 |

## 七、待维护者确认的三件事

1. `ai_tasks` 四阶段划分与 `idem_key` 口径（是否同意「输入指纹变化即废弃旧下游」）。
2. 日配额按「识别 + 分析/备题/校验」合并计数，超限进 `blocked` 而不是报错。
3. #76 暂不新增结果枚举，只加 `delayed` 任务；`trial_logs` 按教师手工登记（不做自动埋点）。

确认后按 #71 → #72/#73 → #74 → #75 → #76 → #77 顺序实现，每个 Issue 先写红灯测试。
