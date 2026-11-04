# mistake-loop

## 目标

小学语数外三科错题闭环系统：老师批量录入错题 → 支架式纠错 → 三层变式验证 → 1-3-7-30 弹性间隔复习 → 掌握证据判定。以 NAS Docker 常开 Web 应用运行，老师用电脑/手机/平板浏览器访问；学生端为打印纸质材料，不在线答题。

本项目的价值不在「存错题」，而在**让状态自己往前走**：由常驻服务每日推进 `next_review`，不依赖人打开系统。旧库 `mistake-wiki` 的 15 道题复习逾期约 3 个月，根因正是「人进入系统时才检查」。

## 技术栈

- **后端与前端：Node.js 26 LTS**（2026-10-28 进入 Active LTS，支持至 2029-04）。**明确覆盖上层 `my/AGENTS.md` 的「脚本和后端优先用 Python」及共享 `my/.venv` 约定**；依赖装容器内，不污染本机与共享环境。
- 数据库：Node 内置 `node:sqlite`（`DatabaseSync`）+ WAL，单文件 `/data/mistakes.db`。不引需编译的原生模块，避免 NAS arm64 / Alpine 构建失败。
- Web 框架：Express 5。单依赖、无额外抽象层。
- 前端：服务端渲染静态页 + 原生 JS + PWA manifest；不引 React / Vue / 构建链。
- 图片：`/data/images`，原件只读保存，与错题记录强关联。
- 打印：浏览器打印 CSS（`@page A4`、`page-break-inside: avoid`），第一版不引 PDF 库。
- 几何图：用 `geometry.mjs` 生成 SVG，替代旧库 `draw-geometry.py` 的 matplotlib PNG。
- 调度：进程内每日定时 + 启动时补算，不额外起 cron 容器。
- AI / OCR：`fetch` 调云 HTTP API；**结果必须教师审核后才生效**。密钥走容器环境变量，不进代码、不进 git、不进日志。
- 部署：单 Dockerfile + `docker-compose.yml`，卷挂 `/data`，`restart: unless-stopped`；镜像 tag 需按 NAS CPU 架构（amd64 / arm64）确认。**不做公网端口映射**，校外访问走 Tailscale（用户侧配置，不属本项目代码范围）。

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

## 第一版明确不做

账号与权限体系、公网暴露、学生在线答题、家长端、小程序、OCR 自动切题、AI 实时讲题、变式自动生成免审核、旧库反向写入。

## 启动方式

```bash
# 本机开发（默认 http://localhost:8080）
npm install
npm run dev

# NAS 部署
docker compose up -d --build
# 访问 http://<NAS-IP>:8080
```

数据卷：本机 `./data/` → 容器 `/data`（含 `mistakes.db` 与 `images/`）。`data/` 已 gitignore。

## 验证命令

```bash
npm test          # node --test，内置零依赖，覆盖状态机与复习排期
npm run check     # node --check 全量 src/ scripts/ 语法检查
curl -s http://localhost:8080/health   # 期望 200
```

按零依赖原则，本阶段用 `node --check` 承担静态检查，**不引 ESLint / TypeScript**；如后续需要更强校验，先改本文档再改实践。

部署后必做结果回读（命令成功不等于完成）：三端浏览器各打开一次 → 手机拍照上传一题并确认图片落盘 → 导出 A4 打印页检查不跨页断题 → 把某题 `next_review` 改为昨天后重启容器，确认「今日复习」自动出现该题 → 跑一次 `scripts/backup.mjs` 并在临时目录恢复、校验记录数。

## 自主边界

遵从上层 `~/codes/AGENTS.md` 与 `my/AGENTS.md`。特别强调：删除文件/目录或 git 历史、创建或修改 `.env` 与任何密钥、数据库 schema 变更或迁移、git push / rebase / reset --hard、安装全局依赖、公开发布——**必须先向用户确认**。废弃内容移入 `archive/`，不直接删除。
