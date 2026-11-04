# mistake-loop

## 目标

小学语数外三科错题闭环系统：老师批量录入错题 → 支架式纠错 → 三层变式验证 → 1-3-7-30 弹性间隔复习 → 掌握证据判定。以 NAS Docker 常开 Web 应用运行，老师用电脑/手机/平板浏览器访问；学生端为打印纸质材料，不在线答题。

本项目的价值不在「存错题」，而在**让状态自己往前走**：由常驻服务每日到期留痕 + 今日复习实时查询，不依赖人打开系统。旧库 `mistake-wiki` 的 15 道题复习逾期约 5 个月，根因正是「人进入系统时才检查」。

## 技术栈

- **后端与前端：Node.js 26 LTS**（2026-10-28 进入 Active LTS，支持至 2029-04）。**明确覆盖上层 `my/AGENTS.md` 的「脚本和后端优先用 Python」及共享 `my/.venv` 约定**；依赖装容器内，不污染本机与共享环境。
- 数据库：Node 内置 `node:sqlite`（`DatabaseSync`）+ WAL，单文件 `/data/mistakes.db`。不引需编译的原生模块，避免 NAS arm64 / Alpine 构建失败。
- Web 框架：Express 5。单依赖、无额外抽象层。
- 前端：静态页 + 原生 ES modules + 自建 CSS 设计令牌；不引 React / Vue / 构建链 / UI 库。
- 图片：`/data/images`，原件只读保存，与错题记录强关联。
- 打印：浏览器打印 CSS（`@page A4`、`break-inside: avoid`），不引 PDF 库。
- 几何图：用 `geometry.mjs` 生成 SVG，替代旧库 `draw-geometry.py` 的 matplotlib PNG。
- 调度：进程内每日定时 + 启动时补算，不额外起 cron 容器。
- AI / 图片识别：`fetch` 调 OpenAI 兼容的视觉接口；**结果只进草稿表，教师确认后才生效**。默认关闭，密钥走容器环境变量，不进代码、不进 git、不进日志。
- 部署：单 Dockerfile + `docker-compose.yml`，卷挂 `/data`，`restart: unless-stopped`；镜像 tag 需按 NAS CPU 架构（amd64 / arm64）确认。**不做公网端口映射**，校外访问走 Tailscale（使用者侧配置，不属本项目代码范围）。
- 测试：`node:test` 内置零依赖；**测试先行**，先写测试并确认红灯，再写实现。涉及 AI 的测试用本地假 provider，不发外网。

## 与 mistake-wiki 的关系

- `/Users/walt/codes/my/mistake-wiki/` 是**只读数据源**：绝不写入、不修改、不删除、不移动。
- 复用其设计资产，不复用任何代码：错因四分法（factual / conceptual / procedural / metacognitive）、`new→diagnosing→correcting→reviewing→mastered` 五态机、surface / structure / context 三层变式、1-3-7-30 弹性复习（迟到不重置、做错回 diagnosing）、支架式引导规范、教材定位字段、A4 打印规范。
- 旧 19 道错题与四上三科教材骨架由 `scripts/import-legacy.mjs` 一次性只读导入，导入后新系统完全自洽。
- 两套流程以本项目为准，**统一一套**，不保留旧库的 `processes/` 与 `strategies/flows/` 并存冲突。

## 教学法硬约束

- 支架式引导：只搭脚手架，不直接给答案；一次只问一个维度；关键结论必须从学生嘴里出来。
- 不以一次做对判定掌握；掌握证据五选一（复述 / 同结构变式 / 间隔提取 / 说出检查方法 / 讲给别人听）。
- 不做作业打卡、排名、积分、惩罚工具；看板只呈现真实聚合数据，禁止多处手写计数。
- 三科各自建错因与变式规则，**不把数学的题型结构机械套用于语文和英语**；教材定位（版本 / 册 / 单元 / 课题 / 页码）是数据主键。
- AI 只做速记员：不判「已掌握」、不生成掌握证据、不替学生说出关键结论、不自动写入错题、不改写历史复习记录。

## 明确不做（v2 修订）

账号与权限体系、公网暴露（代码侧）、学生在线答题、家长端、小程序、AI 实时讲题与自动判分、变式自动生成免审核、旧库反向写入、把 AI 识别结果自动写成错题、激励打卡排名积分。

**注意**：v1 曾把「OCR 自动切题」列为不做；v2 起「图片识别 + 多题切分为草稿」是**要做**的能力，见 `docs/requirements/PRD.md` 第十五节与 `docs/requirements/AI-vision-spec.md`。它只产草稿，不产成品。

## 启动方式

```bash
# 本机开发（默认 http://localhost:8080）
npm install
npm run dev

# NAS 部署
docker compose up -d --build
# 访问 http://<NAS-IP>:8080
```

数据卷：本机 `./data/` → 容器 `/data`（含 `mistakes.db` 与 `images/`）。`data/` 已 gitignore，**真实学生数据与照片永不入库**。

## 验证命令

```bash
npm test          # node --test，覆盖状态机、事务、调度、接口与导入
npm run check     # node --check 全量语法检查与 UI 静态规范
curl -s http://localhost:8080/health   # 期望 200
```

按零依赖原则，静态检查用 `node --check` 与自写脚本承担，**不引 ESLint / TypeScript**；如后续需要更强校验，先改本文档再改实践。

部署后必做结果回读（命令成功不等于完成）：三端浏览器各打开一次 → 手机拍照上传一题并确认图片落盘 → 导出 A4 打印页检查不跨页断题 → 把某题 `next_review` 改为昨天后重启容器，确认「今日复习」自动出现该题 → 跑一次 `scripts/backup.mjs` 并在临时目录恢复、校验记录数。

## 开源协作

本项目是 GitHub 公开开源项目（MIT）。**一切开发以 GitHub Issues 为唯一进度载体**：先有 Issue，再写测试确认红灯，再写实现，测试全绿后结果回读、提交引用 `Refs #N`、更新并关闭 Issue。阶段用 Milestone 组织。详见 `CONTRIBUTING.md`、`docs/plans/2026-11-04-v2-plan.md`、`docs/test-plan.md`。

## 自主边界

遵从上层 `~/codes/AGENTS.md` 与 `my/AGENTS.md`。以下仍需**先向用户确认**：删除文件或目录、修改 `.env` 与任何密钥、数据库 schema 变更或迁移、`rebase` / `reset --hard` / force push、改写已公开的 git 历史、安装全局依赖、删除公开仓库或变更仓库可见性。废弃内容移入 `archive/`，不直接删除。

**2026-11-04 授权变更**：使用者已明确要求本项目作为公开开源项目托管 GitHub，常规 `git push`、创建/关闭 Issue、维护 Milestone 与标签属已授权范围，不需逐次确认。
