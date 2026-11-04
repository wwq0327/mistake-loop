# Issue 与需求编号映射

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/wwq0327/mistake-loop |
| Issue 总数 | 36 |
| 生成依据 | `docs/requirements/PRD.md`（v2 增量 F15-F27 / U1-U8 / B1-B12）、`docs/plans/2026-11-04-v2-plan.md` 第九节 |
| 校验命令 | `node scripts/check-issue-map.mjs`，由 `test/issue-map.test.mjs` 测试先行守护 |

阶段用 Milestone 组织，全部开发项都有 Issue；没有 Issue 的改动不进主分支。

## 映射表

| Issue | 阶段 | 关联需求 | 标题 |
| --- | --- | --- | --- |
| #1 | P0 P0 仓库与协作基线 | 基线类（无 F 编号） | [建立开源协作基线](https://github.com/wwq0327/mistake-loop/issues/1) |
| #2 | P0 P0 仓库与协作基线 | 协作规则 / U1 | [建立 Issue 与需求编号映射文档](https://github.com/wwq0327/mistake-loop/issues/2) |
| #3 | P0 P0 仓库与协作基线 | CI / B2 | [CI 首次运行绿灯回读](https://github.com/wwq0327/mistake-loop/issues/3) |
| #4 | P1 P1 约束修订与数据层 | F15 / F16 | [schema 新增两张识别表与溯源字段](https://github.com/wwq0327/mistake-loop/issues/4) |
| #5 | P1 P1 约束修订与数据层 | B10 / 决策 7 | [migrateV2 幂等迁移与迁移前强制备份](https://github.com/wwq0327/mistake-loop/issues/5) |
| #6 | P1 P1 约束修订与数据层 | F15 / 规格第四、九节 | [图片存储分原图与压缩图并设上限](https://github.com/wwq0327/mistake-loop/issues/6) |
| #7 | P2 P2 设计系统与六页骨架 | U1 | [设计令牌与基础层样式](https://github.com/wwq0327/mistake-loop/issues/7) |
| #8 | P2 P2 设计系统与六页骨架 | U2 / U4 / U8 | [组件层与三档响应式布局](https://github.com/wwq0327/mistake-loop/issues/8) |
| #9 | P2 P2 设计系统与六页骨架 | F21 / F22 / U1 | [前端模块拆分与六页骨架](https://github.com/wwq0327/mistake-loop/issues/9) |
| #10 | P2 P2 设计系统与六页骨架 | B2 | [UI 静态规范检查纳入 npm run check](https://github.com/wwq0327/mistake-loop/issues/10) |
| #11 | P3 P3 AI 识别后端 | F16 / 规格第三节 | [normalize.mjs 识别结果清洗器](https://github.com/wwq0327/mistake-loop/issues/11) |
| #12 | P3 P3 AI 识别后端 | F16 / F20 / 规格第五节 | [provider.mjs 可插拔视觉接口与本地假端点](https://github.com/wwq0327/mistake-loop/issues/12) |
| #13 | P3 P3 AI 识别后端 | F16 / F20 / 规格第九节 | [jobs.mjs 单并发 worker、配额与重试](https://github.com/wwq0327/mistake-loop/issues/13) |
| #14 | P3 P3 AI 识别后端 | F15 / F16 / F17 | [recognitions 路由：上传、任务、草稿 CRUD](https://github.com/wwq0327/mistake-loop/issues/14) |
| #15 | P3 P3 AI 识别后端 | F18 / B6 | [逐题确认入库闸门与幂等](https://github.com/wwq0327/mistake-loop/issues/15) |
| #16 | P3 P3 AI 识别后端 | F19 / F20 / B4 / B8 | [AI 未启用等价退路与状态接口](https://github.com/wwq0327/mistake-loop/issues/16) |
| #17 | P3 P3 AI 识别后端 | B7 / 规格第十节 | [教学法红线总回归](https://github.com/wwq0327/mistake-loop/issues/17) |
| #18 | P4 P4 收件箱与题目详情 | F17 / U3 | [识别收件箱：左原图右草稿](https://github.com/wwq0327/mistake-loop/issues/18) |
| #19 | P4 P4 收件箱与题目详情 | F18 | [草稿逐题与批量确认交互](https://github.com/wwq0327/mistake-loop/issues/19) |
| #20 | P4 P4 收件箱与题目详情 | F21 / F22 / U6 | [题目详情：五态进度与一题一生](https://github.com/wwq0327/mistake-loop/issues/20) |
| #21 | P5 P5 其余四页 | F22 / F24 / U3 | [工作台：四个实时数字直达动作](https://github.com/wwq0327/mistake-loop/issues/21) |
| #22 | P5 P5 其余四页 | F07 / F26 | [打印页：默认带今日复习、预览、出纸](https://github.com/wwq0327/mistake-loop/issues/22) |
| #23 | P5 P5 其余四页 | F25 | [题库检索与批量补教材定位](https://github.com/wwq0327/mistake-loop/issues/23) |
| #24 | P5 P5 其余四页 | F20 | [设置页：AI 状态、显式开关、备份与健康](https://github.com/wwq0327/mistake-loop/issues/24) |
| #25 | P6 P6 验证与交付 | B2 | [CI 加入 UI 静态规范与版本矩阵](https://github.com/wwq0327/mistake-loop/issues/25) |
| #26 | P6 P6 验证与交付 | B1-B12 | [B1-B12 全量验收与结果回读](https://github.com/wwq0327/mistake-loop/issues/26) |
| #27 | P6 P6 验证与交付 | 文档索引 / 决策记录 | [README 与文档同步 v2、发布说明](https://github.com/wwq0327/mistake-loop/issues/27) |
| #28 | P7 P7 前端设计改版 | Frontend Design / U1-U8 | [前端设计改版：批改账簿（Ledger）风格](https://github.com/wwq0327/mistake-loop/issues/28) |
| #29 | P8 P8 硬化与守护 | B2 / B10 | [CI 迁移 Node 24 runtime 并加入容器构建验证](https://github.com/wwq0327/mistake-loop/issues/29) |
| #30 | P8 P8 硬化与守护 | F25 / F18 | [教材定位写入一致性校验](https://github.com/wwq0327/mistake-loop/issues/30) |
| #31 | P8 P8 硬化与守护 | 文档索引 / 决策记录 | [文档数字漂移守护](https://github.com/wwq0327/mistake-loop/issues/31) |
| #32 | P8 P8 硬化与守护 | U1-U8 / B11 | [视觉一致性改为机器核对](https://github.com/wwq0327/mistake-loop/issues/32) |
| #33 | P9 P9 收件箱补缺 | F17 / AI 规格第七节 | [收件箱：草稿可按选区拆成另一题](https://github.com/wwq0327/mistake-loop/issues/33) |
| #34 | P9 P9 收件箱补缺 | F17 / AI 规格第七节 | [识别框可拖动可删除、草稿可新增](https://github.com/wwq0327/mistake-loop/issues/34) |
| #35 | P9 P9 收件箱补缺 | F15 | [收件箱支持多张照片排队](https://github.com/wwq0327/mistake-loop/issues/35) |
| #36 | P9 P9 收件箱补缺 | 文档口径 | [文档状态口径回写与守护](https://github.com/wwq0327/mistake-loop/issues/36) |

## 阶段汇总

| 里程碑 | Issue 数 |
| --- | --- |
| P0 P0 仓库与协作基线 | 3 |
| P1 P1 约束修订与数据层 | 3 |
| P2 P2 设计系统与六页骨架 | 4 |
| P3 P3 AI 识别后端 | 7 |
| P4 P4 收件箱与题目详情 | 3 |
| P5 P5 其余四页 | 4 |
| P6 P6 验证与交付 | 3 |
| P7 P7 前端设计改版 | 1 |
| P8 P8 硬化与守护 | 4 |
| P9 P9 收件箱补缺 | 4 |

新增 Issue 时：同步更新 `scripts/check-issue-map.mjs` 的 `EXPECTED_COUNT`，重跑测试与校验脚本。README 与发布说明里的 Issue 总数、用例数由 `scripts/check-docs.mjs` 守着，写了就必须等于真实来源，不许手抄。
