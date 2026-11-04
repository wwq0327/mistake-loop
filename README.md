# mistake-loop

一个一直开着的错题网页。老师把错题拍进去，系统每天自己算出「今天该复习哪些题」，老师打印成 A4 纸给学生做，把结果记回来，直到有真实证据证明学生真会了才过关。

学生不碰系统，全部在纸上做题。家长不是必需环节。

**公开开源（MIT）· 开发进度全部走 GitHub Issues · 测试先行 · CI 守护**

> 当前 `main` 是已可运行的 v1：三页界面、7 张表、1-3-7-30 复习、A4 打印、旧库只读导入，28 个测试全绿。
> v2 正在按 [Issues](https://github.com/wwq0327/mistake-loop/issues) 分阶段开发：界面重做、结构改为「收件 → 加工」、加入 AI 图片识别（结果只进草稿，老师确认才入库）。方案见 [v2 施工单](docs/plans/2026-11-04-v2-plan.md)，界面靶子见 [静态视觉稿](docs/design/ui-preview.html)。

---

## 一、最快跑起来（本机）

```bash
git clone https://github.com/wwq0327/mistake-loop.git
cd mistake-loop
npm install
npm run dev
```

浏览器打开 `http://localhost:8080`。手机或平板在同一局域网里打开 `http://<本机或NAS的IP>:8080`。

新克隆的仓库没有 `data/`，是空库，功能照常可用。若要复现旧库数据，需要本机另有只读数据源 `mistake-wiki/`，再跑 `npm run import:legacy`（幂等，只需一次）。**仓库不含也不应该含任何真实学生数据。**

## 二、当前版本的三个页面（v2 会重做为六页）

| 地址 | 干什么 |
| --- | --- |
| `/index.html` | 首页。看实时统计、审核变式、记录今天做对/做错、补掌握证据 |
| `/capture.html` | 录入。拍照、填题干、写支架式诊断、顺手补三层变式 |
| `/print.html` | 勾选题目生成 A4 学生版练习纸，点「打印」出纸 |

学生版打印页**不含答案、不含引导提示**，一题一张卡片、不跨页断开。

v2 的六页按老师的动作组织：工作台 / 识别收件箱 / 题目详情 / 打印 / 题库 / 设置。理由见 [PRD 第十三节](docs/requirements/PRD.md)。

## 三、每天怎么用

1. 改作业看到典型错题 → 手机打开「录入」，拍照、填题干、保存。可以连着录。
2. 写「定位问题」（一次只问学生一个点）和「学生自己说出的关键结论」。**结论没填，系统不许推进到纠错中。**
3. 顺手补三道变式：换数字、换角度、换场景。提交后到首页「待审核变式」逐条点通过/未通过——**没审核不上打印纸**。
4. 首页「今日复习」是系统每天 00:05 自己算出来的，不用你记。
5. 到「打印」页勾题，出 A4 纸给学生。
6. 收回来在首页点「做对 / 做错」。做对按 1、3、7、30 天往后排；做错打回诊断、轮次归零。**忘了几个月不惩罚、不从头开始。**
7. 做对第 4 轮还不算会，得再补一条掌握证据（复述 / 同结构变式 / 间隔提取 / 说出检查方法 / 讲给别人听），才标「已掌握」。

## 四、数据放在哪 / 隐私

| 路径 | 内容 |
| --- | --- |
| `data/mistakes.db` | 全部记录（SQLite，WAL 模式） |
| `data/images/` | 手机拍的照片 |
| `data/backups/` | 备份快照（`npm run backup` 后生成） |

`data/` 已 gitignore，**不进版本库、不上传 GitHub**。数据库和图片要另外备份。

```bash
npm run backup                              # 备份并自动做一次临时目录恢复演练
node scripts/backup.mjs --restore <备份目录>  # 单独校验某个备份
```

AI 识别默认关闭；启用后题目照片会发往你配置的服务商，可能含学生笔迹。完整说明见 [SECURITY.md](SECURITY.md)。

## 五、命令清单

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本机起服务，8080 端口 |
| `npm test` | 全量测试（`node:test`） |
| `npm run check` | 语法检查与 UI 静态规范 |
| `npm run import:legacy` | 只读导入旧库（幂等） |
| `npm run backup` | 备份 + 恢复演练 |
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
- 密钥只走环境变量，不建 `.env`；不配置也能完整使用全部非 AI 功能。

## 七、v1 实测结果（回读后的数字，不是「命令跑成功」）

| 检查 | 结果 |
| --- | --- |
| `npm test` | 28 个用例全绿，0 失败（含真实 HTTP 全链路） |
| `npm run check` | 后端、脚本、测试与前端 JS 语法全通过 |
| `/health` | 200，`db=ok`，调度启动补算 `due=15 / inserted=15` |
| 首次导入 | 新增 `mistakes=19 / variants=6 / images=19 / textbook_nodes=25 / 待补教材定位=19` |
| 第二次导入 | 新增全部为 0，幂等成立 |
| 旧库只读 | `mistake-wiki/` 的 `git status` 前后均为 28 项，一个字节未改 |
| 图片 | 19 张全部落盘，0 缺失 |
| 变式 | 只导题干，6 条全部 `reviewed=0`，不把历史作答伪造成本系统复习事件 |
| 今日复习 | 真实数据下 15 道逾期题自动出现，统计 `total=19 / reviewing=15 / mastered=1` |
| 学生版打印 | 15 张卡片，响应体不含答案字段、不含引导提示字段 |
| 调度重启验证 | 临时副本把一题 `next_review` 改昨天，重启后今日复习 15 变 16 且该题出现，`sessions` 留 1 条 due；真实数据未改 |
| 备份恢复 | 快照 `19/6/0/0/25` + 19 张图，临时目录恢复演练通过 |

## 八、已知限制与需要实机确认的事

以下四项**没有**验证过，别当成已完成：

1. 真实 NAS 容器构建与 arm64 / amd64 镜像。
2. 真实手机 / 平板的系统相机调起与浏览器兼容。
3. 浏览器打印预览的分页效果。
4. 两周真实试运行与学情判断（这是产品验收，页面做完、测试通过都不能代替）。

其他限制：

- 本机是 Node 22.22.2，`node:sqlite` 在此版本为实验特性，会输出一条 `ExperimentalWarning`；生产容器固定 Node 26 LTS，无此问题。
- v1 没有账号、公网、学生在线答题、家长端，也**没有图片识别**；AI 识别是 v2 正在做的事，且默认关闭。
- 英语错因子类型留空，等真实英语错题积累后再补；不硬套数学结构。
- 旧 19 题是三年级下册，教材地图是四年级上册，挂不上，故标记「待补教材定位」，不自动猜。

## 九、开源协作方式

**没有 Issue 的改动不进主分支。** 每个可独立验收的工作单元一个 Issue，写明验收标准与「先写哪个测试、红灯断言是什么」；阶段用 Milestone（P0–P6）组织。

每个 Issue 严格五步：写测试 → 跑一次确认红灯并贴输出 → 写实现 → `npm run check` 与 `npm test` 全绿 → 结果回读后提交 `Refs #N`、更新并关闭 Issue。AI 相关测试一律用本地假 provider，**不发外网、不需密钥**。

详见 [CONTRIBUTING.md](CONTRIBUTING.md)、[开发流程](docs/dev-workflow.md)、[测试计划](docs/test-plan.md)。涉及数据暴露请走 [私有漏洞报告](https://github.com/wwq0327/mistake-loop/security/advisories/new)，不要在公开 Issue 贴真实数据。

## 十、文档索引

| 文档 | 看什么 |
| --- | --- |
| `AGENTS.md` | 技术硬约束，效力最高 |
| `docs/requirements/PRD.md` | 需求规格、v2 增量、验收标准、决策记录（外行先看这份） |
| `docs/requirements/AI-vision-spec.md` | AI 图片识别规格、输出契约、失败降级、教学法红线 |
| `docs/plans/2026-11-04-v2-plan.md` | v2 逐文件施工单、六阶段、逐文件清单 |
| `docs/plans/2026-11-04-first-version-plan.md` | v1 施工单（历史档案） |
| `docs/audits/2026-11-04-v1-review.md` | v1 现状审核，三条产品差距的代码级证据 |
| `docs/design/ui-preview.html` | v2 静态视觉稿 |
| `docs/test-plan.md` / `docs/dev-workflow.md` | 测试用例与未覆盖范围 / 开发流程 |
| `docs/handoffs/` | 项目交接历史档案 |

## 十一、许可证

MIT，见 [LICENSE](LICENSE)。
