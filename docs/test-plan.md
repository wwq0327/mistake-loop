# 测试计划

| 项 | 值 |
| --- | --- |
| 框架 | Node 内置 `node --test` + `node:assert/strict`，零测试依赖 |
| 运行 | `npm test` |
| 判定 | 全部通过、0 失败、0 跳过（除显式环境跳过） |

---

## 一、测试分层

| 层 | 范围 | 文件 |
| --- | --- | --- |
| 单元 | 状态机纯函数、日期、字典、几何图 | `test/state-machine.test.mjs` |
| 单元 + 约束 | 事务回滚、CHECK、UNIQUE、索引 | `test/db.test.mjs` |
| 单元 | 每日调度补算、去重、未到期不入队、下次运行时间 | `test/scheduler.test.mjs` |
| 集成（临时 fixtures） | 只读导入映射、幂等、图片复制、三下题不挂四上节点 | `test/import-legacy.test.mjs` |
| 集成（真实 HTTP） | 起临时端口，跑通「录入 → 诊断 → 变式审核 → 今日复习 → 提交结果」全链路，含打印页不含答案 | `test/api.test.mjs` |

测试一律用 `mkdtempSync` 建临时数据库与临时旧库 fixtures，**不碰真实 `data/`、不碰 `mistake-wiki/`**；测试结束清理自己创建的临时目录。

---

## 二、必测用例清单

### 状态机（8 条硬分支，教学方法不能靠肉眼检查）

| # | 用例 | 期望 |
| --- | --- | --- |
| S1 | 做对 round 0→1 / 1→2 / 2→3 / 3→4 | 间隔依次为 1 / 3 / 7 / 30 天 |
| S2 | 做错 | 状态回 `diagnosing`、round=0、`next_review=NULL`、`mastered_at=NULL` |
| S3 | 迟到不重置 | 传入逾期 160 天的题做对，round 仍只 +1，不归零 |
| S4 | 变式任一层 fail | 回 `diagnosing`、round=0 |
| S5 | 变式三层全 pass | 进 `reviewing`、round=0、次日复习 |
| S6 | 变式只过一层 | **不推进**状态，等其余两层审核 |
| S7 | 无证据 | round=4 也不得 `mastered`，停在 reviewing 且 30 天后再来 |
| S8 | 有证据且 round>=4 | 才 `mastered`、`next_review=NULL`、`mastered_at=today` |
| S9 | round 上限 | 连做对 6 次，round 封顶 4，不越界 |
| S10 | 非法入参 | result / level 非法值抛错 |

### 数据库与事务

| # | 用例 | 期望 |
| --- | --- | --- |
| D1 | `withTransaction` 中途抛错 | 全部回滚，表内无半条数据 |
| D2 | 非法 status / error_category / level | CHECK 拒绝 |
| D3 | 重复 `source_ref` | UNIQUE 拒绝（导入脚本用 `INSERT OR IGNORE` 幂等） |
| D4 | `review_round` 越界 | CHECK 拒绝 |
| D5 | 索引存在 | `idx_next_review` 等三个索引可查 |

### 调度

| # | 用例 | 期望 |
| --- | --- | --- |
| C1 | 启动补算 | 到期题写入 `sessions(kind='due')` |
| C2 | 同日重复执行 | 不重复插入（UNIQUE 去重） |
| C3 | 未到期题 | 不入队 |
| C4 | `mastered` / `diagnosing` 题 | 不入队 |
| C5 | 下次运行时间 | 在 Asia/Shanghai 下算到下一个 00:05，返回值在 (0, 24h] |

### 只读导入

| # | 用例 | 期望 |
| --- | --- | --- |
| I1 | 3 个样本 md 字段映射 | subject / grade / semester / status / round / next_review 原样 |
| I2 | 三下题 vs 四上教材地图 | `textbook_node_id=NULL`、`needs_textbook_ref=1` |
| I3 | 变式只导题干 | 不含「结果：通过」「学生作答」文本；`reviewed=0` |
| I4 | 图片复制 | 落 `data/images/legacy/`，原文件不变 |
| I5 | 重复执行 | 第二次新增 0 条 |
| I6 | 手写计数不入库 | `variant_count` 不写，改实时 COUNT |

### API 冒烟（真实 HTTP）

| # | 用例 | 期望 |
| --- | --- | --- |
| P1 | `GET /health` | 200，含 db ok 与 scheduler 状态 |
| P2 | `GET /api/meta` | 200，统计字段为实时聚合值 |
| P3 | `POST /api/mistakes` | 201；图片落盘；状态 `new` |
| P4 | `PATCH /api/mistakes/:id/diagnosis` | 结论为空时推 `correcting` 被 409 拒绝 |
| P5 | `POST /api/mistakes/:id/variants` + `PATCH review` | 未审核不推进；三层审核完进 `reviewing` |
| P6 | `GET /api/reviews/today` | 该题出现在今日队列 |
| P7 | `POST /api/reviews/:id/result` | 做对后 `next_review` 顺延 1 天，`review_events` 有记录 |
| P8 | `GET /api/print?mode=student` | 响应体**不含** `correct_answer` / `scaffold_hint` 字样 |
| P9 | 非法入参 | 返回 400，不返回 500、不泄漏堆栈 |

---

## 三、工程验收（不属于 `npm test`，但交付必做逐项回读）

见 `PRD.md` 第九节 A1–A9。重点三项不能用「命令成功」糊过去：

- A5 手机拍照后**查文件是否真落盘**；
- A6 打印页**肉眼看不跨页断题、学生版无答案**；
- A7 改 `next_review` 为昨天后**重启服务**，确认题自动出现且 `sessions` 有 due 记录。

## 四、测试没覆盖的东西（如实写）

- 真实 NAS 容器构建与 arm64/amd64 镜像（本轮架构未确认，只做本机 `npm run dev` 与配置检查）。
- 真实手机 / 平板浏览器兼容与系统相机调起（需实机，本轮用静态页与 `<input capture>` 合规实现，无法在无设备环境验证）。
- 浏览器打印分页效果（需实机打印预览）。
- 两周真实试运行与学情判断（属 PRD 第二层验收，不在代码交付范围）。

以上四项在交付时列为「需使用者实机确认」，不写成「已验证」。
