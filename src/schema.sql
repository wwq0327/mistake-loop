-- mistake-loop 第一版 schema
-- 约定：日期 TEXT 'YYYY-MM-DD'（Asia/Shanghai），时间戳 TEXT ISO 8601
-- 所有统计实时聚合，本文件不含任何计数表

CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  grade       INTEGER,
  class_name  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS textbook_nodes (
  id           INTEGER PRIMARY KEY,
  subject      TEXT NOT NULL CHECK (subject IN ('math','chinese','english')),
  edition      TEXT NOT NULL,
  grade        INTEGER NOT NULL,
  semester     INTEGER NOT NULL,
  unit_no      INTEGER NOT NULL,
  unit_title   TEXT NOT NULL,
  lesson_title TEXT NOT NULL DEFAULT '',
  page_start   TEXT,
  source_ref   TEXT,
  UNIQUE (subject, edition, grade, semester, unit_no, lesson_title)
);

CREATE TABLE IF NOT EXISTS mistakes (
  id                  INTEGER PRIMARY KEY,
  source_ref          TEXT UNIQUE,
  student_id          INTEGER REFERENCES students(id) ON DELETE SET NULL,
  textbook_node_id    INTEGER REFERENCES textbook_nodes(id) ON DELETE SET NULL,
  subject             TEXT NOT NULL CHECK (subject IN ('math','chinese','english')),
  edition             TEXT,
  grade               INTEGER,
  semester            INTEGER,
  unit_no             INTEGER,
  unit_title          TEXT,
  lesson_title        TEXT,
  page_no             TEXT,
  question_type       TEXT,
  difficulty          TEXT,
  prompt              TEXT NOT NULL,
  student_answer      TEXT,
  correct_answer      TEXT,
  image_path          TEXT,
  recognition_draft_id INTEGER,
  source_paper        TEXT,
  knowledge_tags      TEXT,
  error_category      TEXT CHECK (error_category IN ('conceptual','procedural','metacognitive','factual')),
  error_subtype       TEXT,
  error_reason        TEXT,
  diagnosis_note      TEXT,
  student_conclusion  TEXT,
  legacy_notes        TEXT,
  geometry_spec       TEXT,
  status              TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','diagnosing','correcting','reviewing','mastered')),
  review_round        INTEGER NOT NULL DEFAULT 0 CHECK (review_round BETWEEN 0 AND 4),
  next_review         TEXT,
  mastered_at         TEXT,
  needs_textbook_ref  INTEGER NOT NULL DEFAULT 0 CHECK (needs_textbook_ref IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_next_review ON mistakes(status, next_review);
CREATE INDEX IF NOT EXISTS idx_subject ON mistakes(subject, status);
CREATE INDEX IF NOT EXISTS idx_node ON mistakes(textbook_node_id);

CREATE TABLE IF NOT EXISTS variants (
  id             INTEGER PRIMARY KEY,
  mistake_id     INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE RESTRICT,
  level          TEXT NOT NULL CHECK (level IN ('surface','structure','context')),
  prompt         TEXT NOT NULL,
  correct_answer TEXT,
  scaffold_hint  TEXT,
  source_ref     TEXT,
  reviewed       INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0,1)),
  result         TEXT CHECK (result IN ('pass','fail')),
  attempted_at   TEXT,
  UNIQUE (mistake_id, level, source_ref)
);

CREATE TABLE IF NOT EXISTS review_events (
  id            INTEGER PRIMARY KEY,
  mistake_id    INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE RESTRICT,
  round         INTEGER NOT NULL,
  due_on        TEXT,
  done_at       TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('correct','wrong')),
  note          TEXT,
  evidence_type TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  mistake_id   INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('diagnosing','correcting','variant','spaced','due')),
  due_on       TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  notes        TEXT,
  evidence_type TEXT,
  UNIQUE (mistake_id, due_on, kind)
);

CREATE TABLE IF NOT EXISTS mastery_evidence (
  id          INTEGER PRIMARY KEY,
  mistake_id  INTEGER NOT NULL REFERENCES mistakes(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('retell','same_structure_variant','spaced_recall','self_check_method','teach_others')),
  note        TEXT,
  verified_by TEXT NOT NULL DEFAULT 'teacher',
  created_at  TEXT NOT NULL
);
