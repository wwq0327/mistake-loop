# AI 学习闭环开发交接

日期为 2026-11-05。功能基线为 7a8329a，本轮提交补充需求与编排。当前 AI 分析与出题尚待开发。

## 接手入口

先读 AGENTS.md、CONTRIBUTING.md，然后读 [PRD 第二十一节](../requirements/PRD.md)、[AI 学习闭环规格](../requirements/AI-learning-loop-spec.md)、[施工计划](../plans/2026-11-05-ai-learning-loop-plan.md) 和 [审阅报告](../audits/2026-11-05-learning-efficiency-review.md)。

目标是单学生拍照后后台自动准备分析与练习，老师集中核对、学生纸面练习、按真实表现接下一轮。五态看板保持方案 B。

## 开发顺序

| Issue | 阶段 | 需求 | 任务 |
| --- | --- | --- | --- |
| [#66](https://github.com/wwq0327/mistake-loop/issues/66) | P17 | F28–F39 | v3 需求、AI 边界和接手基线 |
| [#67](https://github.com/wwq0327/mistake-loop/issues/67) | P17 | F28 | 分离变式题质量审核与学生验证，补齐诊断总闸门 |
| [#68](https://github.com/wwq0327/mistake-loop/issues/68) | P17 | F29 | 统一复习登记与本轮掌握证据，拒绝做错时新增证据 |
| [#69](https://github.com/wwq0327/mistake-loop/issues/69) | P17 | F30 | 统一 1-3-7-30 日期含义并落实长间隔验证 |
| [#70](https://github.com/wwq0327/mistake-loop/issues/70) | P17 | F31 | 学生版使用干净题面，防止原卷答案与批注上纸 |
| [#71](https://github.com/wwq0327/mistake-loop/issues/71) | P18 | F32 | 后台 AI 多阶段任务编排、版本失效和失败恢复 |
| [#72](https://github.com/wwq0327/mistake-loop/issues/72) | P18 | F33 | AI 错步分析和一次一问的支架草稿 |
| [#73](https://github.com/wwq0327/mistake-loop/issues/73) | P18 | F34 | 相关题检索与三科变式草稿生成和质量校验 |
| [#74](https://github.com/wwq0327/mistake-loop/issues/74) | P18 | F35 | 方案 B 今日动作区与集中核对确认 |
| [#75](https://github.com/wwq0327/mistake-loop/issues/75) | P19 | F36 | 固定练习批次、纸面题号与任务对应 |
| [#76](https://github.com/wwq0327/mistake-loop/issues/76) | P19 | F37 | 分级学习结果、下一轮自动备题与延迟新题 |
| [#77](https://github.com/wwq0327/mistake-loop/issues/77) | P19 | F38/F39 | 单学生学习效率试运行与基于记录的周复盘 |

接手优先做 #68 的无预选/接口防错及 #70 的学生题面防护，同时为 #67 整理审核与作答分离的具体设计，再审 #69 的日期时间线。之后按 P18、P19 依赖完成整条链路。

## 已确认的复现场景

- diagnosing 且关键结论为空时，三层“审核通过”可推进 reviewing。
- wrong 附 evidence_type 返回成功且新增证据。
- 从纠错完成次日开始，四次按期做对可在 Jan02/03/06/13 后即掌握，未必发生 30 天间隔。
- 旧今日列表证据默认第一项，看板有空白项，双入口不一致。
- 学生版字段白名单仍保留原图，含作答/批注原卷可能上纸。

这些复现使用内存库与虚构样例，不涉及真实数据。既有状态机 11 项测试通过，说明仍需补上学习真实性回归。

## 工作边界与待确认设计

常规开发已获授权。涉及 schema 或数据迁移时先交具体可审阅设计，经维护者明确确认才实施。排期日期策略和新结果类别兼容也应先给实例与契约。可以先完成独立的防错、文档、样例、测试与无迁移功能，不因后续迁移待确认而停掉所有工作。

AI 分析/题目只是草稿。允许后台生成候选并经教师集中确认后采用，不允许 AI 伪造学生结论、作答、掌握证据。出题必须带教师参考与质量检查，学生版只见净题面。开发不需要真实密钥，使用假 provider。

## 验证与报告

git status 后开始，保留无关改动。每张功能 Issue 先写红灯、再实现、npm run check 与 npm test、真实结果回读、Refs #N 提交、按验收更新 Issue。一次纸上练习只做两题时第三题应留待办。重启能恢复后台任务。版本改变要使未确认草稿失效，旧纸不改。

#77 需要真实试用后才能完成。两周不能代替 30 天延迟验证。#65 保留给维护者判断视觉。

本轮只交付开发基线，接手后应先核对 GitHub 最新 Issue 与主分支，不把计划状态写成已实现。
