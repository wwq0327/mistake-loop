# P16 开发交接 · 方案 B「闭环看板」

维护者已选定方案 B。将现有教师工作台首页改为按教学阶段组织的看板。GitHub Issues 是进度事实源；截至交接时，三张 Issue 已创建，开发尚未开始。

## 接手入口

| 顺序 | GitHub Issue | 完成后能验收什么 |
| --- | --- | --- |
| 1 | [#61 工作台五态看板](https://github.com/wwq0327/mistake-loop/issues/61) | 真实题目归列，三科可筛选，手机可切换阶段 |
| 2 | [#62 当前阶段动作](https://github.com/wwq0327/mistake-loop/issues/62) | 从卡片进真实详情，第一屏就能看到下一步 |
| 3 | [#63 复习登记与全链路验收](https://github.com/wwq0327/mistake-loop/issues/63) | 登记后根据服务端结果更新，做错回诊断、末轮有证据才可掌握 |

[里程碑 P16](https://github.com/wwq0327/mistake-loop/milestone/17)

## 设计参考

- 同一台机器可打开 [交互原型](/Users/walt/.codex/visualizations/2026/11/04/01a1a8ec-79cb-7ec1-ae1f-3ffa5fdff6c1/mistake-loop-ui.html)，选择顶部 **B 闭环看板**。[桌面截图](/Users/walt/.codex/visualizations/2026/11/04/01a1a8ec-79cb-7ec1-ae1f-3ffa5fdff6c1/board.png)
- 换机器时，以 #61 正文复建设计。浅绿底、深绿强调，标题「每道题走到哪了？」与学科筛选同区。桌面五列，列头显示阶段与题数，复习列略突出。手机默认「复习中」，一次看一个阶段，可通过带题数的选择器切换。题卡展示学科、题干及教材或到期信息。
- 原型的静态数量、样题、模拟状态切换只供演示。正式页面用真实接口，主题通过设计令牌与组件落地。A/C/D 方案不属于本里程碑。

## 代码定位与注意点

- 首页从 `public/index.html`、`public/js/pages/workbench.js` 开始读。样式先看 `public/css/tokens.css`、`layout.css`、`components.css` 和 UI 检查脚本。保留工作台通向收件箱、题库、打印和设置的正常入口。
- `src/routes/mistakes.mjs` 的题库列表支持 status、subject，最多返回 500 条，其 total 是返回条数；触及上限不能显示为全量。用 `src/routes/meta.mjs` 理解全局聚合，用 `src/routes/reviews.mjs` 读当天到期和逾期。复习列还包括未来到期题。
- 题卡进入 `public/detail.html` / `public/js/pages/detail.js` 对应的真实详情，复用教学闸门与当前缺口提示。复习登记保留 `due_on`、防连点、409 和失败反馈；状态与数量以服务端回读为准。
- 交接时主工作区已有 P15 相关改动，包括 `workbench.js`。接手先查 `git status --short` 与 #58 当前状态，基于包含相关修复的基线开发；如需隔离，用独立工作树，别覆盖现有工作区。保留 #56 去重和 #57 详情闸门。打印预览硬化归 #60，P16 复用现有打印入口。
- 继续遵守 `AGENTS.md`、`CONTRIBUTING.md`。本阶段不需要数据库迁移、真实学生数据、外部 AI 或部署。

## 给接手 AI 的指令

在 `/Users/walt/codes/my/mistake-loop` 接手 P16。先读仓库规范和 #61–#63，核对 P15 基线，从 #61 开始。每张 Issue 先写指定回归测试并确认红灯，再实现；运行 `npm run check`、`npm test`，用虚构数据在 375 / 768 / 1440 px 实际操作回读，记录真实结果，提交引用 `Refs #N`，完成验收后再更新并关闭对应 Issue。全链路至少验证一次做错后回到诊断、末轮证据缺失时的拦截，以及成功登记后刷新仍显示服务端状态。
