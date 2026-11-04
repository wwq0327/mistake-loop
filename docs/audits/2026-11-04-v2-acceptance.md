# v2 B1–B12 全量验收与结果回读

生成时间：2026-11-04T13:30:36.978Z
生成方式：`node scripts/acceptance.mjs`，逐项回读实际数字或复现步骤。

总览：11 项 PASS / 0 项 FAIL / 1 项待判断（共 12 项）。

## B1 回归

- 状态：PASS
- 证据：v1 五个文件 28 例 / pass 28 / fail 0（含 I5-I6 导入幂等：第二次新增 0）；npm run check 退出码 0；真实库副本备份恢复演练 ok=true、计数 {"mistakes":19,"variants":6,"review_events":0,"mastery_evidence":0,"textbook_nodes":25}、图片 19 张；副本 19 题 / 6 变式 / 25 节点 / 19 图；旧库只读未被写入

## B2 设计系统

- 状态：PASS
- 证据：UI 静态检查违规 0 处（html=6 / css=5 / js=10）；四组测试 30 例 / pass 30 / fail 0；五层 CSS 5/5 齐备；label 缺失与硬编码色值均为 0

## B3 六页可达

- 状态：PASS
- 证据：六处路由逐一 GET：状态码 200/200/200/200/200/200；六页均含 data-page 标记 6/6；工作台 KPI → 收件箱 / 打印 / 题库 三处动作入口见 #21 回读

## B4 未启用降级

- 状态：PASS
- 证据：AI 未启用：上传 202 → 空白草稿 1 条（prompt 长度 0）→ 手填 PATCH 200 → commit 201 → 入库 1 条且 status=new；外部请求 0 次；原图保留=true

## B5 识别全流程

- 状态：PASS
- 证据：本地假 provider 返回一图三题 → 生成 3 条草稿；PATCH 改 1 条（200）、确认 2 条（201/201）；mistakes 0 → 2（+2），状态 new/new；未确认的第 1 条仍 pending

## B6 审核闸门

- 状态：PASS
- 证据：同一草稿重复确认 idempotent=true，mistakes 仍 2 条；未确认草稿在题库 / 今日复习 0 / 打印 0 / 统计 total=2 中出现=false；确认 2 条后统计只算这 2 条

## B7 教学法红线

- 状态：PASS
- 证据：AI 全链路后 mastery_evidence=0 / review_events=0 / sessions=0；故意给 #1 写入 4 个答案类字段 + 1 条带答案与提示的已审核变式、推进 reviewing 后，学生版打印回 1 张卡片，响应含禁用字段 无、泄漏敏感值 无；AI 未改写任何已有错题状态

## B8 失败矩阵

- 状态：PASS
- 证据：9 例 / pass 9 / fail 0；六类逐类复现：未配置 / 超时 / 429 / 脏 JSON / 空题集 / 配额耗尽；每类都断言「不生成错题、原图仍在、退回 1 条可手填空白草稿」

## B9 新增测试

- 状态：PASS
- 证据：六组共 6 个文件：39 例 / pass 39 / fail 0；覆盖清洗器、provider mock、worker 配额、识别 HTTP 全流程、审核闸门、教学法红线

## B10 旧库与数据

- 状态：PASS
- 证据：旧库 /Users/walt/codes/my/mistake-wiki 的 git status 仍 28 项（全程只读）；v1 数据回读 19 题 / 6 变式 / 19 张图 / 25 个教材节点，一条不丢；真实库只在临时副本上打开

## B11 视觉一致性

- 状态：待判断
- 证据：待用户判断，不由开发自评：静态视觉稿 6 屏在 docs/design/ui-preview.html，实际六页在 /、/inbox、/mistake/:id、/print、/library、/settings；请对照审阅后由你给结论

## B12 本地与远程

- 状态：PASS
- 证据：除本次验收交付物 3 个文件外，工作区 0 项改动；HEAD 1b9ce64 与 origin/main 1b9ce64 一致；交付物提交后会再独立回读一次 git status

## 第二层：四项实机 / 试运行未验证项

以下 4 项**未验证**，页面做完、测试通过、命令成功都不能代替这一层验收：

1. 真实 NAS 容器构建与 arm64 / amd64 镜像（CI 只在 ubuntu-latest 上跑过）。
2. 真实手机 / 平板的系统相机调起与浏览器兼容。
3. 浏览器打印预览的实际分页效果与 A4 出纸。
4. 两周真实试运行与学情判断（无提醒时每周主动使用约 3 次）。

说明：B12 原 v1 口径是「不建远程、不 push」，已被后续「公开开源 + GitHub Issues 驱动」的授权覆盖，此处按本阶段口径回读本地与远程提交一致性。
