# mistake-loop

一个一直开着的错题网页。老师把错题拍进去，系统每天自己算出「今天该复习哪些题」，老师打印成 A4 纸给学生做，把结果记回来，直到有真实证据证明学生真会了才过关。

学生不碰系统，全部在纸上做题。家长不是必需环节。

**公开开源（MIT）· 开发进度全部走 GitHub Issues · 测试先行 · CI 守护**

> `main` 是已交付的 v2：六页界面、9 张表、收件 → 加工两段流程、AI 图片识别只产草稿、1-3-7-30 弹性复习、A4 打印。308 个用例全绿。
> 界面靶子见 [静态视觉稿](docs/design/ui-preview.html)，需求与验收口径见 [PRD](docs/requirements/PRD.md)，逐项实测数字见 [B1–B12 验收报告](docs/audits/2026-11-04-v2-acceptance.md)，本版改动见 [发布说明](docs/releases/2026-11-04-v2.md)。

---

## 一、最快跑起来（本机）

```bash
git clone https://github.com/wwq0327/mistake-loop.git
cd mistake-loop
npm install
npm run dev
```

浏览器打开 `http://localhost:8080`。手机或平板在同一局域网里打开 `http://<本机或NAS的IP>:8080`。

- 新克隆没有 `data/`，启动时自动建库并做 v2 幂等迁移，**不需要手工执行迁移脚本**。
- 已有 v1 旧库才需要 `npm run migrate:v2`（先做一致性备份，再迁移，再回读计数比对）。
- 若要复现旧库 19 道错题，需本机另有只读数据源 `mistake-wiki/`，再跑 `npm run import:legacy`（幂等，只需一次）。
- 需要 Node >= 22.5（`node:sqlite`）；生产容器固定 Node 26 LTS。**仓库不含也不应该含任何真实学生数据。**

## 二、六页与 AI 草稿流程

界面按老师的动作组织，不按数据库表排；视觉方向是「批改账簿」——暖纸、墨字、朱红批注色只用于强调，靶子见 [静态视觉稿](docs/design/ui-preview.html)：

| 地址 | 页面 | 干什么 |
| --- | --- | --- |
| `/` | 工作台 | 四个实时数字 + 今日复习、收件、打印的直达动作 |
| `/inbox` | 识别收件箱 | 上传一整张试卷照片，左原图右草稿逐题核对、裁剪重识别 |
| `/mistake/:id` | 题目详情 | 五态进度、支架式诊断、三层变式、复习历史、掌握证据 |
| `/print` | 打印 | 默认带今日复习，生成 A4 学生版练习纸 |
| `/library` | 题库 | 三档筛选、批量补教材定位 |
| `/settings` | 设置 | AI 状态、进程内显式开关、备份与健康入口 |

**收件 → 加工** 是 v2 的核心结构：

1. 拍照上传。**可以只有一张照片、没有可复制的题干**，不逼老师先填长表单。
2. AI 图片识别只在显式开启时把一张图切成多条草稿；低置信度字段留空不猜。未启用、超时、限流、脏输出、空题集、配额耗尽，一律退回 1 条可手填的空白草稿，等价路径不打折。
3. 老师在收件箱逐题核对、改字段、裁剪重识别。草稿此时**不是错题**，不进题库、不进今日复习、不进打印、不进统计。
4. 逐题或批量确认后，才写入 `mistakes(status='new')`；重复确认幂等，不会多出一条。
5. 之后才是题目详情里的诊断 → 纠错 → 复习 → 掌握流程。

AI 只做速记员：不判「已掌握」、不生成掌握证据、不替学生说出关键结论、不自动写入错题、不改写历史复习记录。

AI 图片识别**默认关闭**。启用需要环境变量 `AI_ENABLED=1` 且配齐 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`；设置页的开关只做进程内暂停，不改变是否配置。启用后题目照片会发往你配置的服务商，可能含学生笔迹，完整说明见 [SECURITY.md](SECURITY.md) 与 [识别规格](docs/requirements/AI-vision-spec.md)。不配置也能完整使用全部非 AI 功能。

学生版打印页**不含答案、不含引导提示**，一题一张卡片、不跨页断开。

## 三、每天怎么用

1. 改作业看到典型错题 → 手机打开收件箱，拍一整页上传，不用先抄题干。
2. 识别结果逐题核对、确认入库；没开 AI 就手填那张空白草稿。**没确认的草稿永远不算错题。**
3. 在题目详情写「定位问题」（一次只问学生一个维度）和「学生自己说出的关键结论」。**结论没填，系统不许推进到纠错中。** 支架式引导只搭脚手架，不直接给答案。
4. 顺手补三层变式：换数字 / 换结构 / 换情境，逐条审核——**没审核不上打印纸**。三科各自建错因与变式规则，不把数学题型结构硬套语文、英语。
5. 工作台的「今日复习」是常驻服务每天自己算出来的，不靠人打开系统才检查；迟到几个月不惩罚、不从头开始。
6. 打印页默认带今日复习，勾题出 A4 纸给学生。
7. 收回来记「做对 / 做错」。做对按 1、3、7、30 天往后排；做错打回诊断、轮次归零。
8. 做对 4 轮仍不算会，还要补一条掌握证据五选一（复述 / 同结构变式 / 间隔提取 / 说出检查方法 / 讲给别人听），才标「已掌握」。

## 四、数据放在哪 / 隐私

| 路径 | 内容 |
| --- | --- |
| `data/mistakes.db` | 全部记录（SQLite，WAL 模式） |
| `data/images/` | 原图与压缩图，与错题强关联 |
| `data/backups/` | 备份快照（`npm run backup` 后生成） |

`data/` 已 gitignore，**不进版本库、不上传 GitHub**。数据库和图片要另外备份。

```bash
npm run backup                              # 备份并自动做一次临时目录恢复演练
node scripts/backup.mjs --restore <备份目录>  # 单独校验某个备份
```

学生端全纸质，系统里没有学生账号、没有在线答题、没有打卡排名积分。密钥只走环境变量，不进代码、不进日志、不进 Issue 正文。

## 五、命令清单

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本机起服务，8080 端口，启动时自动建库/迁移 |
| `npm test` | 全量测试（`node:test`） |
| `npm run check` | 语法检查 + UI 规范 + src/ 色值守护 + Issue 映射 + 视觉一致性判定 + 文档链接、索引与数字一致性静态检查 |
| `npm run migrate:v2` | 已有 v1 库显式升级（先备份、后比对计数） |
| `npm run import:legacy` | 只读导入旧库（幂等） |
| `npm run backup` | 备份 + 恢复演练 |
| `node scripts/acceptance.mjs` | B1–B12 全量验收与结果回读，重写验收报告 |
| `curl -s http://localhost:8080/health` | 健康检查 |
| `docker compose up -d --build` | NAS 上部署 |

## 六、NAS 部署

```bash
mkdir -p data
sudo chown -R 1000:1000 data   # 只需一次；容器内以非 root 用户运行
docker compose up -d --build
```

- 不在路由器做公网端口映射。校外访问走 Tailscale，属你自己侧的配置。
- 镜像不写死 CPU 架构，由 NAS 本机决定（amd64 / arm64 待实机确认）。
- `restart: unless-stopped`，服务常开才有「状态自己往前走」这回事。

## 七、实测结果（回读后的数字，不是「命令跑成功」）

| 检查 | 结果 |
| --- | --- |
| `npm test` | 308 个用例全绿、0 失败（含文档静态检查、设计改版守护等分组用例）；v1 的 28 个测试一个未改 |
| `npm run check` | 语法全通过；UI 静态违规 0（`html=6 css=5 js=10`）；src/ 色值守护 0 违规；Issue 映射 47 个编号齐全；视觉一致性机器判定 92/92 项通过（9 组）；文档链接与索引 PASS；文档里的数字与实际一致 |
| `node scripts/acceptance.mjs` | B1–B12：11 PASS / 0 FAIL / 1 待判断，退出码 0 |
| 容器构建 | CI run 41860460740：多架构产物含 `linux/amd64` 与 `linux/arm64`；两个架构各真跑一次容器（非 root 用户 `node`、挂载 `/data`），`/health` 回读 `{"ok":true,"db":"ok"}`；只 build 不 push |
| 六页可达 | 六处路由 `200/200/200/200/200/200`，`data-page` 6/6 |
| 一图三题 | 假 provider 生成 3 条草稿，确认 2 条 → `mistakes 0→2`，未确认的第 1 条仍 pending |
| 审核闸门 | 重复确认 `idempotent=true`；未确认草稿在题库 / 今日复习 / 打印 / 统计中出现均为 `false` |
| 教学法红线 | AI 全链路后 `mastery_evidence=0 / review_events=0 / sessions=0`；学生版打印泄漏答案与引导字段均为「无」 |
| 失败矩阵 | 9 例全绿；六类失败均「不生成错题、原图仍在、退回 1 条可手填空白草稿」 |
| v1 数据 | 19 题 / 6 变式 / 19 张图 / 25 个教材节点一条不丢；真实库只在临时副本打开 |
| 旧库只读 | `mistake-wiki/` 的 `git status` 前后均为 28 项，一个字节未改 |
| 备份恢复 | 快照 `19/6/0/0/25` + 19 张图，临时目录恢复演练通过 |

逐项细节见 [B1–B12 验收报告](docs/audits/2026-11-04-v2-acceptance.md)。

## 八、已知限制与需要实机确认的事

以下四项**没有**验证过，别当成已完成：

1. 真机 NAS 上的容器构建与拉起：镜像已在 CI 里验证可构建（amd64 + arm64、Node 26、非 root 运行、/health 回读通过），但真机 NAS 拉起、卷属主与重启自愈仍未验证。
2. 真实手机 / 平板的系统相机调起与浏览器兼容。
3. 浏览器打印预览的分页效果与 A4 出纸。
4. 两周真实试运行与学情判断（这是产品验收，页面做完、测试通过、命令成功都不能代替）。

另外，**B11 视觉一致性待使用者判断，不由开发自评**：静态视觉稿 6 屏在 [ui-preview.html](docs/design/ui-preview.html)，实际六页在 `/`、`/inbox`、`/mistake/:id`、`/print`、`/library`、`/settings`，请对照审阅后由你给结论。

其他限制：

- 本机是 Node 22.22.2，`node:sqlite` 在此版本为实验特性，会输出一条 `ExperimentalWarning`；生产容器固定 Node 26 LTS，无此问题。
- 没有账号与权限体系、公网暴露（代码侧）、学生在线答题、家长端、小程序、AI 实时讲题与自动判分、变式自动生成免审核、激励打卡排名积分。
- 英语错因子类型留空，等真实英语错题积累后再补；不硬套数学结构。
- 旧 19 题是三年级下册，教材地图是四年级上册，挂不上，故标记「待补教材定位」，不自动猜。

## 九、开源协作方式

**没有 Issue 的改动不进主分支。** 每个可独立验收的工作单元一个 Issue，写明验收标准与「先写哪个测试、红灯断言是什么」；阶段用 Milestone（P0–P12）组织，共 47 个 Issue，编号映射见 [issue-map.md](docs/github/issue-map.md)。

每个 Issue 严格五步：写测试 → 跑一次确认红灯并贴输出 → 写实现 → `npm run check` 与 `npm test` 全绿 → 结果回读后提交 `Refs #N`、更新并关闭 Issue。AI 相关测试一律用本地假 provider，**不发外网、不需密钥**。

详见 [CONTRIBUTING.md](CONTRIBUTING.md)、[开发流程](docs/dev-workflow.md)、[测试计划](docs/test-plan.md)、[v2 施工单](docs/plans/2026-11-04-v2-plan.md)。涉及数据暴露请走 [私有漏洞报告](https://github.com/wwq0327/mistake-loop/security/advisories/new)，不要在公开 Issue 贴真实数据。

## 十、文档索引

| 文档 | 看什么 |
| --- | --- |
| `AGENTS.md` | 技术硬约束，效力最高 |
| `docs/requirements/PRD.md` | 需求规格、v2 增量、F/U/B 编号、验收标准、决策记录（外行先看这份） |
| `docs/requirements/AI-vision-spec.md` | AI 图片识别输出契约、失败降级、隐私外发、教学法红线 |
| `docs/plans/2026-11-04-v2-plan.md` | v2 逐文件施工单、六阶段提交、信息架构与设计令牌 |
| `docs/plans/2026-11-04-first-version-plan.md` | v1 施工单（历史档案） |
| `docs/audits/2026-11-04-v1-review.md` | v1 现状审核，三条产品差距的代码级证据 |
| `docs/audits/2026-11-04-v2-acceptance.md` | B1–B12 全量验收，逐项实际数字与四项未验证 |
| `docs/design/ui-preview.html` | v2 静态视觉稿，六屏对照靶子 |
| `docs/dev-workflow.md` | 五步工作流与阶段红线 |
| `docs/test-plan.md` | 测试分组、六组新增测试、未覆盖范围 |
| `docs/github/issue-map.md` | 47 个 Issue 与需求编号映射 |
| `docs/handoffs/2026-11-04-project-kickoff-handoff.md` | 开工交接档案（历史） |
| `docs/releases/2026-11-04-v2.md` | 本版发布说明：已完成、未验证、许可证与数据边界 |
| `CONTRIBUTING.md` / `SECURITY.md` / `LICENSE` | 协作约定 / 隐私与漏洞报告 / MIT 许可证 |

## 十一、许可证与发布说明

MIT，见 [LICENSE](LICENSE)。本版改动见 [发布说明](docs/releases/2026-11-04-v2.md)。
