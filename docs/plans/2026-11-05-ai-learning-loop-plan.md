# AI 学习闭环施工计划

2026-11-05。需求已建立，运行功能待开发。范围为一个学生，教师操作网页、学生纸面练习，延续方案 B。详见 [规格](../requirements/AI-learning-loop-spec.md) 和 [审阅依据](../audits/2026-11-05-learning-efficiency-review.md)。

## Issue 顺序

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

## 依赖与开工条件

P17 先明确审核、真实验证与证据契约。#68 的接口防错与去掉证据预选、#70 的原图默认上纸防护可先按现有结构做小修；#67 的审核/作答分离若需新结构，必须先提供设计。#69 先给日期实例，维护者确认具体排期政策后改实现。

P18 以 #71 为骨架，#72 分析与 #73 备题依赖相同版本契约，#74 再连接真实前后端流程。后台任务可提前准备草稿，但确认权与学习状态推进仍依据教师事件。

P19 先做 #75 的固定批次，再接 #76 的分级结果与下一轮。#77 的体验试用可按已具备的阶段开展，但延迟任务要等到真实发生才记验收。

## 数据与授权

新增任务、周期、批次和事件的概念设计已在规格中列出，尚未批准任何实际 schema 变更。各实现 Issue 先提交字段、外键/唯一约束、存量语义、备份/恢复、幂等迁移和失败回滚方案。维护者明确确认后才写迁移或执行数据库变更。密钥与真实模型启用另行确认。

未确认排期政策前不能批量重排现有记录；不能为了兼容旧测试保留已证实的教学闸门缺口，也不能直接删旧历史。旧记录的不确定来源应显式保留。

## 完成定义

每个功能 Issue 指定了测试入口与红灯复现场景，先测试后实现。运行 npm run check 和 npm test，真实页面/接口回读后贴结果，再按实际状态关闭。使用本地假 provider 与虚构样例；真实学生效果只在实际试运行后判断。

文档基线 Issue #66 交付范围为规格、计划、交接与映射，不代表其余功能已完成。#65 视觉验收继续独立开放，不在本轮代替维护者关闭。
