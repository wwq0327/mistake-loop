# mistake-loop 第一版逐文件施工单（待审）

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-04 |
| 状态 | **待用户审阅拍板，未写任何业务代码** |
| 依据 | 根目录 `AGENTS.md`（效力最高）、`docs/handoffs/2026-11-04-project-kickoff-handoff.md`、本轮对 `mistake-wiki/` 的只读实测 |
| 已确认边界 | 全量落地 / 只服务老师本人设备、不做账号与公网、学生端全纸质 / 教材按旧库骨架定死 / NAS 架构不写死、按多架构 |
| 默认执行 | AI 只留接口不接真实密钥、不 `git init`、不建 `.env`、不做公网映射 |

---

## 零、先说三个实测冲突（交接文档未记载，直接影响设计）

只读核对 `mistake-wiki/` 后得到以下事实，方案按实测写，不按交接文档第八节的二手描述写：

1. **旧 19 道错题全是三年级下册，教材骨架是四年级上册。**
   实测 `grep -hE '^(grade|semester):' wiki/mistakes/M-*.md` → 19 道全为 `grade: 3` / `semester: 2`；而 `wiki/textbooks/{math,chinese,english}/` 三份教材地图均为 `grade: 4` / `semester: 1`。
   交接文档写「旧 19 道错题与四上三科教材骨架一次性导入」，两者挂不上。教材定位是数据主键，**强行挂四上就是污染整库**。本方案：旧题 `textbook_node_id` 一律 NULL，另置待补标记，不猜。见待拍板项 1。
2. **旧错题 frontmatter 里没有任何教材定位字段。**
   19 题字段并集只有 `id / subject / grade / semester / type / image_path / source_paper / knowledge_tags / error_category / error_reason / difficulty / status / review_round / next_review / variant_count / mastered_at / created / preliminary_diagnosis`，**无 edition / unit / lesson / page**。旧库复盘第十条自己承认「课本关联刚起步」。导入脚本无法自动补，只能留空。
3. **三层变式基本没落地，且只存在于正文自由文本。**
   `variant_count: 3` 仅 2 道，其余 17 道为 0。变式题写在正文 `## 变式训练` → `### 变式一（表面变式）` / `### 变式二（结构变式）` / `### 变式三（情境变式）`，正文还混有学生作答与「结果：通过 ✅」。可解析题干，但**不能把历史作答伪造成本系统的 `review_events`**。

其余实测：19 张 `image_path` 图片全部存在（0 缺失）；状态分布 `new` 3 / `reviewing` 15 / `mastered` 1；`next_review` 空值 4 道、9 道 2026-05-28、6 道 2026-06-03，按 2026-11-04 计 15 道逾期约 5 个月。导入后首日「今日复习」会出现 15 道，这是「迟到不重置」的正确结果，不自动分批。

三份教材地图单元数：四上数学 9 单元、语文 8 单元、英语 8 单元（含 Recycle 1/2），合计 25 个单元级节点。`wiki/learning-units/四年级上册/` 下另有 126 份学习单元文件，第一版不导入。

支架式引导硬约束已核对原文（`wiki/strategies/支架式引导规则.md`）：禁止直接给答案、禁止一次抛多个问题、禁止学生没说出思路前纠正；允许一次一个思考维度、2–3 个方向让学生选；收口必须由学生独立说出完整路径。掌握证据五选一：复述 / 同结构变式 / 间隔提取 / 说出检查方法 / 讲给别人听。

---

## 一、逐文件清单

根目录配置与文档：

| 路径 | 职责 | 关键点 | 规模 |
| --- | --- | --- | --- |
| `AGENTS.md` | 项目规范 | **已存在，本轮不改** | 69 行 |
| `docs/handoffs/2026-11-04-project-kickoff-handoff.md` | 交接 | **已存在，本轮不改** | — |
| `docs/plans/2026-11-04-first-version-plan.md` | 本施工单 | 待审，审后按此施工 | 本文件 |
| `package.json` | 依赖与脚本 | `type: module`；唯一运行时依赖 `express@^5`；scripts：`dev` / `start` / `test`（`node --test`）/ `check`（遍历 `src/ scripts/ test/` 跑 `node --check`）/ `import:legacy` / `backup` | ~25 行 |
| `package-lock.json` | 锁文件 | `npm install` 生成，入库 | 生成物 |
| `.gitignore` | 忽略 | `node_modules/`、`data/`、`.DS_Store`、`*.log` | ~8 行 |
| `.dockerignore` | 构建上下文 | 排除 `node_modules/`、`data/`、`.git/`、`docs/`、`*.db` | ~10 行 |
| `Dockerfile` | 镜像 | `FROM node:26-slim`（不用 alpine，避 musl）；`NODE_ENV=production`；`npm ci --omit=dev`；非 root `USER node`；`EXPOSE 8080`；`HEALTHCHECK` 用 `node -e` 内置 fetch 打 `/health`（不装 curl）；**不写死 `--platform`** | ~25 行 |
| `docker-compose.yml` | 编排 | 单 service；`./data:/data`；`8080:8080`；`TZ=Asia/Shanghai`；`restart: unless-stopped`；`AI_API_KEY` 只做 `${AI_API_KEY:-}` 透传、不落盘；**不写 `platform:`**，由 NAS 本机架构决定 | ~20 行 |

`src/`（后端）：

| 路径 | 职责 | 关键导出 / 内容 | 规模 |
| --- | --- | --- | --- |
| `src/schema.sql` | 7 张表 + 索引 | 见第三节；`PRAGMA foreign_keys` 由 `db.mjs` 开 | ~130 行 |
| `src/db.mjs` | 数据库层 | `openDb(path)` 返回 `DatabaseSync`；开 WAL、`busy_timeout=5000`、`foreign_keys=ON`；`migrate(db)` 读 `schema.sql` 幂等 `exec`；**`withTransaction(db, fn)`**（`BEGIN IMMEDIATE` / `COMMIT` / 异常 `ROLLBACK` 后重抛，约 20 行，本项目唯一要手写的运行时补丁）；`closeDb` | ~80 行 |
| `src/state-machine.mjs` | 纯函数，零 IO | `INTERVALS = [1,3,7,30]`（按 round 1/2/3/4 取）；`applyReview({mistake, result, today, evidenceCount})` → 新字段对象；`applyVariant({mistake, level, result, today})`；`canMaster(round, evidenceCount)`；`assertTransition(from, to)` | ~110 行 |
| `src/scheduler.mjs` | 常驻调度 | `startScheduler(db, {now})`：启动补算一次 + 每日本地 00:05 一次；每次把 `status='reviewing' AND next_review <= today` 的题写入 `sessions`（`kind='due'`，`UNIQUE(mistake_id, due_on, kind)` 去重）；内存记录 `lastRunAt` 供 `/health` 读；`stopScheduler()` 清 timer 供测试 | ~70 行 |
| `src/server.mjs` | 入口 | Express 5 装配：`express.json`、`express.static('public')`、挂载 5 组路由、`GET /health`、`multipart` 图片接收（Express 5 自带 `req.body` 不处理文件，**用原生 `req` 流 + 自写 ~40 行 multipart 解析，不引 multer 等额外依赖**）；启动时 `migrate` + `startScheduler`；`SIGTERM` 优雅关闭 | ~130 行 |
| `src/geometry.mjs` | SVG 几何图 | `renderGeometry(spec)` 输出 SVG 字符串，替代旧库 matplotlib PNG；第一版只支持线段/矩形/角标注，纯字符串拼接无依赖 | ~60 行 |
| `src/ai/client.mjs` | AI 接口占位 | `isEnabled()` 读 `AI_API_KEY` / `AI_BASE_URL`；`analyze()` 未配置时返回 `{status:'disabled'}`；有配置时用 `fetch` 请求；**返回值一律带 `reviewed=false`，写库必经 `PATCH /api/variants/:id/review`**；密钥不进日志 | ~50 行 |
| `src/lib/subjects.mjs` | 三科规则字典 | `ERROR_SUBTYPES` 按 `math` / `chinese` / `english` 分列，**不共用数学结构**：math 收旧库已验证的 15 个子类型（单位混淆/进率混淆/计算失误/步骤错用…）；chinese 只收已出现的近义词混淆、部首遗忘；english 空表 + `待归类`。另含 `VARIANT_RULES` 三科各自的 surface/structure/context 提示语模板（只给方向、不给答案） | ~90 行 |
| `src/lib/validation.mjs` | 入参校验 | `checkSubject` / `checkStatus` / `checkCategory` / `checkEvidence` / `checkDate`，返回 400 而非让 SQLite CHECK 抛 500 | ~60 行 |
| `src/routes/meta.mjs` | 元数据与看板 | `GET /api/meta`：教材节点列表、三科错因字典、**实时聚合统计**（按状态/科目/逾期数，全部 `SELECT COUNT` 现算，不存计数器） | ~60 行 |
| `src/routes/mistakes.mjs` | 录入与详情 | `POST /api/mistakes`（multipart 图片 → `/data/images`）、`GET /api/mistakes`、`GET /api/mistakes/:id`、`PATCH /api/mistakes/:id/diagnosis` | ~160 行 |
| `src/routes/variants.mjs` | 变式 | `POST /api/mistakes/:id/variants`（批量，落 `reviewed=0`）、`PATCH /api/variants/:id/review`（教师审核后生效，事务内调 `applyVariant`） | ~90 行 |
| `src/routes/reviews.mjs` | 复习 | `GET /api/reviews/today`、`POST /api/reviews/:id/result`（事务内更新 mistakes + 插 review_events + 插 session + 可选插 mastery_evidence） | ~110 行 |
| `src/routes/print.mjs` | 打印聚合 | `GET /api/print?ids=&mode=student`，返回结构化题目卡；`mode=student` 永不返回 `correct_answer` 与 `scaffold_hint` | ~50 行 |

`public/`（前端，服务端渲染静态页 + 原生 JS，无构建链）：

| 路径 | 职责 | 关键点 |
| --- | --- | --- |
| `public/index.html` | 首页 = 今日复习 | 到期列表、每题「做对 / 做错」二选 + 掌握证据五选一（做错时禁用证据）、顶部实时统计 |
| `public/capture.html` | 录入 | `<input type="file" accept="image/*" capture multiple>` 调系统相机（绕开 `getUserMedia` 的 HTTPS 限制，手机上 `http://192.168.x.x:8080` 也能拍）；科目/教材定位/错因选择；提交后提示「待诊断」 |
| `public/print.html` | 打印导出 | 勾选题目 → 生成 A4 卡片 → `window.print()`；默认学生版 |
| `public/app.js` | 三页共用 | `fetch` 封装、页面路由判断、表单与列表渲染；无框架、无模板引擎 |
| `public/style.css` | 屏幕样式 | 移动优先，触控目标 >= 44px；浅色背景 |
| `public/print.css` | 打印样式 | `@page { size: A4; margin: 15mm; }`；`.card { break-inside: avoid; page-break-inside: avoid; }`；隐藏所有按钮与导航 |
| `public/manifest.webmanifest` | PWA | 名称、图标占位、standalone、起始页 `/`；**第一版不注册 Service Worker**（不做离线，避免缓存旧题） |

`scripts/` 与 `test/`：

| 路径 | 职责 | 关键点 |
| --- | --- | --- |
| `scripts/import-legacy.mjs` | 一次性只读导入 | 绝对路径指向 `mistake-wiki/`，**只读打开、绝不写入**；自写 ~30 行 frontmatter mini-parser（不引 yaml 依赖）；映射见第六节；`INSERT OR IGNORE` 按 `source_ref` 幂等；图片 `copyFile` 到 `/data/images/legacy/`；末尾打印导入计数与待补教材定位题数 |
| `scripts/backup.mjs` | 备份 | `VACUUM INTO` 出 `mistakes-YYYYMMDD.db`（SQLite 在线一致性快照）+ 复制 `images/`；`--restore <dir>` 在临时目录恢复并校验记录数；不删除任何旧备份 |
| `test/state-machine.test.mjs` | 状态机 8 分支 | 做对 4 轮间隔 / 做错回 diagnosing 且 round=0 / 迟到不重置 / 变式任一层错回引导 / 三层全过进 reviewing / 无证据不得 mastered / 有证据且 round>=4 才 mastered / round 上限不越界 |
| `test/db.test.mjs` | 事务与约束 | `withTransaction` 异常回滚、CHECK 拒绝非法 status/category/level、索引存在、`UNIQUE(source_ref)` 生效 |
| `test/scheduler.test.mjs` | 调度 | 用可注入 `now` 验证启动补算、同日不重复插入 due 会话、逾期题入队、未到期不入队 |
| `test/import-legacy.test.mjs` | 导入 | 用固定 3 个样本 md（复制到 `test/fixtures/`）验证字段映射、幂等、图片复制、三下题不挂四上节点 |

`data/`（gitignore，本机卷）：`mistakes.db`（WAL 模式另有 `-wal` / `-shm`）、`images/`、`images/legacy/`。

---

## 二、schema.sql 字段定义（7 张表，无第 8 张）

约定：日期一律 `TEXT 'YYYY-MM-DD'` 本地日期（compose 固定 `TZ=Asia/Shanghai`，避免 NAS UTC 导致「今日」错一天）；`created_at` / `updated_at` 用 `TEXT` ISO 时间；所有枚举用 `CHECK`；`ON DELETE` 一律 `RESTRICT` 或 `SET NULL`，不级联删错题。

```
students(id PK, name, grade, class_name, note, created_at)
  -- 第一版保留但不做 UI 管理；import-legacy 插入 1 条占位「默认学生」。见待拍板项 5。

textbook_nodes(
  id PK, subject CHECK(math|chinese|english), edition TEXT, grade INT, semester INT,
  unit_no INT, unit_title TEXT, lesson_title TEXT, page_start TEXT, source_ref TEXT,
  UNIQUE(subject, edition, grade, semester, unit_no, lesson_title)
)
  -- 允许 3下 与 4上 共存，年级/学期不是常量。第一版只建单元级 25 条（见待拍板项 4）。

mistakes(
  id PK, source_ref TEXT UNIQUE,            -- 旧库 M-xxx 作幂等键
  student_id FK, textbook_node_id FK NULL,  -- 旧 19 题一律 NULL
  subject CHECK(math|chinese|english), edition TEXT, grade INT, semester INT,
  unit_no INT, unit_title TEXT, lesson_title TEXT, page_no TEXT,   -- 录入时手填，可空
  question_type TEXT, difficulty TEXT,
  prompt TEXT, student_answer TEXT, correct_answer TEXT,
  image_path TEXT, source_paper TEXT, knowledge_tags TEXT,   -- JSON 数组字符串
  error_category CHECK(conceptual|procedural|metacognitive|factual),
  error_subtype TEXT, error_reason TEXT,
  diagnosis_note TEXT,        -- 支架式：定位问题（一次一个维度）
  student_conclusion TEXT,    -- 学生自己说出的关键结论，必须由教师录入
  legacy_notes TEXT,          -- 旧库正文「病因诊断」等自由文本，只存不用
  status CHECK(new|diagnosing|correcting|reviewing|mastered) DEFAULT 'new',
  review_round INT CHECK(review_round BETWEEN 0 AND 4) DEFAULT 0,
  next_review TEXT, mastered_at TEXT, created_at TEXT, updated_at TEXT,
  needs_textbook_ref INT DEFAULT 0   -- 旧题教材定位待补标记
)
  INDEX idx_next_review(status, next_review);
  INDEX idx_subject(subject, status);
  INDEX idx_node(textbook_node_id);

variants(
  id PK, mistake_id FK,
  level CHECK(surface|structure|context),
  prompt TEXT, correct_answer TEXT,
  scaffold_hint TEXT,          -- 一次只给一个思考维度，禁止给完整答案
  source_ref TEXT, reviewed INT DEFAULT 0,   -- 教师审核后才生效
  result CHECK(pass|fail),     -- 可空
  attempted_at TEXT,
  UNIQUE(mistake_id, level, source_ref)
)

review_events(
  id PK, mistake_id FK, round INT, due_on TEXT, done_at TEXT,
  result CHECK(correct|wrong), note TEXT, evidence_type TEXT
)

sessions(
  id PK, mistake_id FK, kind CHECK(diagnosing|correcting|variant|spaced|due),
  due_on TEXT, started_at TEXT, ended_at TEXT, notes TEXT, evidence_type TEXT,
  UNIQUE(mistake_id, due_on, kind)   -- 调度器每日 due 记录去重用
)

mastery_evidence(
  id PK, mistake_id FK,
  kind CHECK(retell|same_structure_variant|spaced_recall|self_check_method|teach_others),
  note TEXT, verified_by TEXT DEFAULT 'teacher', created_at TEXT
)
```

**没有任何计数表**。旧库 `variant_count` 字段不导入，看板一律 `SELECT COUNT(*) FROM variants WHERE ...` 实时算。这是修掉「看板虚报已掌握 6 道」的数据漂移根因。

---

## 三、状态机与调度精确规则

`applyReview`（纯函数，`result` 只有 correct / wrong）：

| 条件 | 结果 |
| --- | --- |
| `wrong` | `status='diagnosing'`、`review_round=0`、`next_review=NULL`、`mastered_at=NULL`；已有 mastery_evidence 保留但不生效 |
| `correct`，round 0→1 / 1→2 / 2→3 / 3→4 | `review_round+1`（上限 4）；`next_review = today + [1,3,7,30][round-1]` 天；`status='reviewing'` |
| `correct` 且 `round>=4` 且 `evidenceCount>=1` | `status='mastered'`、`next_review=NULL`、`mastered_at=today` |
| `correct` 且 `round>=4` 但无证据 | 保持 `reviewing`、`round=4`、`next_review=today+30`，等补证据，**不卡死也不冒充 mastered** |

`applyVariant`：`surface/structure/context` 任一层 `fail` → `status='diagnosing'`、`review_round=0`、`next_review=NULL`；三层全 `pass` → `status='reviewing'`、`round=0`、`next_review=today+1`。只有 `reviewed=1` 的变式结果能进这个函数。

硬约束落点：

- **迟到不重置**：函数不看 `due_on`，只按当前 `review_round` 推进。逾期 5 个月的题做对一次仍是 round+1，不回 0。
- **不以一次做对判定掌握**：必须 round>=4 且至少 1 条 mastery_evidence。
- **支架式**：`correct_answer` / `scaffold_hint` 只出现在教师侧详情页与 API，**永不进 `mode=student` 打印页**；`student_conclusion` 为空时不允许把状态推到 `correcting`。
- **事务**：一次 `POST /api/reviews/:id/result` 内完成「改 mistakes + 插 review_events + 插 session + 插 evidence」，全部包在 `withTransaction`，任何一步失败整体回滚。

**关于「让状态自己往前走」的诚实解释**（需你认可，见待拍板项 7）：`next_review` 在无人提交结果时**不被改写**，否则就违反「迟到不重置」。旧库的真正病灶是「人打开系统时才计算到期」；本版由常驻服务每日 00:05 自动把 `next_review <= today` 的题写成 `sessions(kind='due')` 留痕，且 `/api/reviews/today` 每次实时查询 `mistakes.next_review`，不依赖任何人打开页面。调度启动时补算一次，容器重启不漏。

---

## 四、接口清单（8 个核心 + 4 个辅助）

| # | 方法 | 路径 | 说明 | 事务 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/health` | 200 + db ok + `scheduler.lastRunAt` | 否 |
| 2 | GET | `/api/meta` | 教材节点、三科错因字典、实时聚合统计 | 否 |
| 3 | POST | `/api/mistakes` | multipart 新建，图片落 `/data/images`，`status='new'` | 是 |
| 4 | GET | `/api/mistakes` | 列表，支持 `status` / `subject` / `needs_textbook_ref` 过滤 | 否 |
| 5 | GET | `/api/mistakes/:id` | 详情，含 variants 与 review_events | 否 |
| 6 | PATCH | `/api/mistakes/:id/diagnosis` | 提交错因、支架定位问题、学生结论；`new→diagnosing→correcting` | 是 |
| 7 | GET | `/api/reviews/today` | `status='reviewing' AND next_review <= today`，按逾期天数降序 | 否 |
| 8 | POST | `/api/reviews/:id/result` | 做对/做错 + 可选掌握证据，调 `applyReview` | **是** |
| 9 | POST | `/api/mistakes/:id/variants` | 批量录三层变式，`reviewed=0` | 是 |
| 10 | PATCH | `/api/variants/:id/review` | **教师审核后**才写 `result` 并调 `applyVariant` | 是 |
| 11 | GET | `/api/print` | `ids` + `mode=student`，只返回题目与作答留白 | 否 |
| 12 | GET | `/api/textbook-nodes` | 下拉框数据源（可由 `/api/meta` 合并，见待拍板项 8） | 否 |

错误统一 `{error: {code, message}}`，400 入参错、404 不存在、409 状态不允许该迁移、500 只记服务端日志不回显堆栈。

---

## 五、导入映射（`scripts/import-legacy.mjs`）

只读源：`/Users/walt/codes/my/mistake-wiki/`。写入目标：本项目的 `data/`。旧库一个字节不动。

| 旧库字段 / 位置 | 新表字段 | 处理 |
| --- | --- | --- |
| `id` | `mistakes.source_ref` | UNIQUE，幂等键 |
| `subject` / `grade` / `semester` | 同名 | 原样保留 **3 下** |
| — | `mistakes.edition` | 按 subject 映射：math→人教版、chinese→统编版、english→人教版PEP（版本定死） |
| `type` / `difficulty` | `question_type` / `difficulty` | 原样 |
| `image_path` | `mistakes.image_path` | `copyFile` 到 `data/images/legacy/<basename>`；19 张已核实存在，已存在则跳过 |
| `source_paper` | 同名 | 5 道有值，其余 NULL |
| `knowledge_tags` | 同名 | 转 JSON 数组字符串 |
| `error_category` | 同名 | 实测 19 道全在 4 值 CHECK 内 |
| `error_reason` | 同名 | 原样 |
| `preliminary_diagnosis.reason` | `diagnosis_note` | **加前缀「旧库初步诊断，未经教师审核」** |
| `status` / `review_round` / `next_review` / `mastered_at` | 同名 | 原样直搬，保留 15 道逾期，不重置、不清理 |
| `variant_count` | **不导入** | 改由 `variants` 实时 COUNT，消灭手写计数 |
| 正文 `## 原题` / `## 学生答案` / `## 正确答案` | `prompt` / `student_answer` / `correct_answer` | 按二级标题切段 |
| 正文 `## 变式训练` → `### 变式N（X变式）` | `variants` | 仅 2 道题、6 条；标题映射 level；`reviewed=0`；**不解析历史作答与「结果：通过」** |
| 正文 `## 病因诊断` 表格等 | `legacy_notes` | 整段存，不参与任何逻辑，避免丢信息 |
| 四上三份教材地图的单元表 | `textbook_nodes` | 25 条单元级节点，`lesson_title=''`、`page_start` 取表格页码 |
| 旧错题 → 教材节点 | **不关联** | `textbook_node_id=NULL`、`needs_textbook_ref=1` |

导入结束打印：`mistakes=19 / variants=6 / images=19 / textbook_nodes=25 / 待补教材定位=19`。重复执行不产生重复行。

---

## 六、页面与打印

- 三页共用 `app.js`，靠 `document.body.dataset.page` 分流，不引路由库。
- 手机拍照用 `<input type="file" accept="image/*" capture multiple>`，不用 `getUserMedia`（后者在非 HTTPS 的 `http://192.168.x.x:8080` 直接被浏览器拒绝）。
- 打印：`@page A4 margin 15mm`；一题一卡片（题干 + 三层变式 + 作答留白），`break-inside: avoid` 保证不跨页断题；隐藏全部交互元素。
- **学生版不含正确答案、不含引导提示**。支架式引导由教师课堂口头执行，系统只记录 `diagnosis_note` 与 `student_conclusion`。教师看答案在系统详情页。
- 不做教师版打印页（见待拍板项 3）。

---

## 七、部署与验证

- `Dockerfile` 不写死平台；`docker-compose.yml` 不写 `platform:`，由 NAS 本机架构决定，符合你选的「不确定，先按多架构」。
- 容器 `8080:8080` 是 NAS 局域网内绑定；**路由器不做公网端口映射**，校外访问走 Tailscale（你侧配置，代码不管）。
- 非 root 运行，`/data` 属主由 compose 首次启动时一次性 `chown`（写在 entrypoint 脚本里，不改宿主机系统配置）。
- 密钥：`AI_API_KEY` 仅透传环境变量，不建 `.env`、不进 git、不进日志；第一版 `isEnabled()` 恒 false。
- 验证命令与结果回读，严格按 `AGENTS.md`：
  1. `npm test` 全绿（4 个测试文件）；`npm run check` 无语法错误；`curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health` 得 200。
  2. `npm run import:legacy` 后回读计数，确认 19/6/19/25/19 与预期一致，再跑一次确认无重复。
  3. 电脑 / 手机 / 平板各打开一次；手机拍一题上传，确认图片落 `data/images/`。
  4. 导出 A4 打印页，检查不跨页断题、学生版无答案。
  5. 把某题 `next_review` 改为昨天后重启服务，确认「今日复习」自动出现该题、`sessions` 有 due 记录。
  6. 跑 `scripts/backup.mjs`，在临时目录 `--restore` 并校验记录数。
  7. 命令成功不等于完成；以上逐项留结果。**两周真实试运行不在本轮交付范围，是使用阶段验收。**

---

## 八、待拍板项（不替你决定，编号回复即可）

| # | 问题 | 建议 | 不选的后果 |
| --- | --- | --- | --- |
| 1 | 旧 19 题是三下、教材骨架是四上，怎么导？ | **A：保留三下、不挂节点、标记待补**（本方案） | B 补建三下节点只能建数学（旧库只有三下数学地图）；C 不导旧题，则闭环首日零数据 |
| 2 | 变式历史作答与「通过 ✅」不导入，只导题干，确认？ | 确认 | 导入会把旧库历史伪造成本系统事件，违背「真实掌握证据」 |
| 3 | 第一版要不要「教师版打印页」（含答案与支架提示）？ | **不做** | 做要加一份 CSS 与权限判断，且学生拿到答案会破支架式引导 |
| 4 | 教材节点只到单元级 25 条，还是解析 299 份课时文件到课题级？ | **单元级**，课题/页码录入时手填 | 到课题级要写 3 套解析器，复杂度翻倍，第一版验收用不上 |
| 5 | `students` 表保留但不做 UI（导入插 1 条占位）？ | **保留** | 删表偏离既定 7 表；做 UI 又超出「只我和我的设备」 |
| 6 | 首日 15 道逾期题全量进「今日复习」，不加分批开关？ | **全量** | 加开关等于变相改「迟到不重置」语义 |
| 7 | 「状态自己往前走」= 常驻调度每日留痕 + 实时查询，而非自动改写 `next_review`，认可？ | 认可 | 若要求自动改写日期，与「迟到不重置」直接冲突，须先改 `AGENTS.md` 教学法约束 |
| 8 | `/api/textbook-nodes` 并入 `/api/meta`，接口收为 11 个？ | 并入 | 单独留着只是多一次请求 |
| 9 | 英语错因子类型第一版留空 + 「待归类」，不硬造？ | 留空 | 硬造就是把数学结构套到英语上，撞 `AGENTS.md` 硬约束 |

---

## 九、第一版明确不做

账号与权限、公网暴露、学生在线答题、家长端、小程序、OCR 自动切题、AI 实时讲题、变式免审核、旧库反向写入、Service Worker 离线缓存、作业打卡/排名/积分、教师版打印页（除非第 3 项改选）、真实 AI 密钥、`git init`、`git push`、任何 schema 迁移。

## 十、AI 不能替你做的事

定「给谁用」（本轮已由你确认）、教材版本（已确认）、NAS 架构（已确认不写死）、是否开公网、是否装 Tailscale；把「留守儿童家长无法每日配合」当作已验证事实；在未拿到视频本体时声称研读过视频；用测试通过或页面做完代替两周真实试运行；写入旧库、创建密钥文件、删除文件、擅自改 schema 或做 git 危险操作。

---

## 十一、施工顺序（审完执行）

`schema.sql` + `db.mjs` + `state-machine.mjs` → 状态机与事务测试跑绿 → `scheduler.mjs` + 调度测试 → 路由与 `server.mjs` → `public/` 三页 → `import-legacy.mjs` + 导入测试 → `backup.mjs` → Docker 三文件 → `npm test` / `npm run check` / `/health` → 按第七节逐项结果回读。

每一步只改本施工单列出的文件，每行改动可追溯到本文件条目。发现无关问题先报告，不擅自动手。
