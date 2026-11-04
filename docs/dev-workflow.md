# 开发流程与本地 git 规范

| 项 | 值 |
| --- | --- |
| 适用 | mistake-loop 第一版 |
| 效力 | 低于 `AGENTS.md` 与 `docs/requirements/PRD.md` |

---

## 一、环境

| 场景 | 版本 | 说明 |
| --- | --- | --- |
| 生产容器 | Node.js 26 LTS（`node:26-slim`） | `node:sqlite` 稳定可用，规范锁定 |
| 本机开发 | 实测 Node 22.22.2 可跑 | `node:sqlite` 在此版本是实验特性，运行时会输出一条 `ExperimentalWarning`，不影响功能；不要因为这个去装全局 Node，属需先确认的操作 |

依赖只装项目内 `node_modules/`，不装全局、不碰共享 `my/.venv`。

## 二、目录职责

| 目录 | 放什么 | 不放什么 |
| --- | --- | --- |
| `src/` | 后端全部代码与 `schema.sql` | 前端、脚本 |
| `public/` | 静态页、原生 JS、CSS、PWA manifest | 任何构建产物 |
| `scripts/` | 只读导入、备份、语法检查辅助 | 业务运行时代码 |
| `test/` | `node --test` 测试 | fixtures（测试内动态生成临时目录） |
| `docs/requirements/` | 需求规格 | 技术实现细节 |
| `docs/plans/` | 逐文件施工单 | 需求变更 |
| `docs/handoffs/` | 交接记录，历史档案，不改 | — |
| `data/` | 本机数据卷，gitignore | 不进仓库 |

## 三、开发循环（每个模块都走）

```
写 → 验 → 报
```

1. **写**：只改本模块文件，不顺手重构、不改无关格式。
2. **验**：按风险跑对应命令（见第四节）；数据库改动必看实际行数，不看「命令成功」。
3. **报**：一句话说清完成什么、验证结果是什么。

阶段顺序（依赖前置，不许跳）：

```
schema + db + 状态机 → 测试跑绿 → 调度 → 路由与 server → 前端三页
→ 导入/备份脚本 → Docker 配置 → 全量验证 → 结果回读
```

## 四、验证命令

| 命令 | 作用 | 判定 |
| --- | --- | --- |
| `npm test` | 全量单元 + 集成测试 | 0 失败 |
| `npm run check` | 遍历 `src/ scripts/ test/` 跑 `node --check` | 无语法错误 |
| `npm run dev` | 本机起服务，默认 8080 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health` 得 200 |
| `npm run import:legacy` | 只读导入旧库 | 回读计数符合 PRD A4 |
| `npm run backup` | 备份到 `data/backups/` | 恢复校验记录数一致 |

按零依赖原则，静态检查只用 `node --check`，不引 ESLint / TypeScript。要引更强工具，先改 `AGENTS.md` 再实践（约束先行）。

## 五、本地 git 规范

**范围：只做本地版本管理。** 已建本地仓库与分阶段提交历史；**未创建远程仓库、未 push、未 rebase、未 reset**。要把代码放到 GitHub 远程仓库，需要使用者给出仓库地址并明确授权，属红线操作。

### 提交粒度

按可独立验证的阶段提交，一次提交一件事：

| 阶段 | 提交内容 |
| --- | --- |
| 1 | 项目规范、交接、施工单、需求文档、流程与测试计划（文档基线） |
| 2 | 数据层：schema、db、状态机、日期与字典工具 |
| 3 | 测试：状态机、事务、调度、导入、API 冒烟 |
| 4 | 服务层：调度、路由、server、AI 占位、几何图 |
| 5 | 前端三页与样式 |
| 6 | 导入与备份脚本 |
| 7 | 部署配置与 README |
| 8 | 验证结果回读后的修正（如有） |

### 提交信息

格式 `type: 一句话说明`，type 取 `docs` / `feat` / `test` / `fix` / `chore`。不写空泛的「update」「修改」。

### 红线（必须先问，不得自行执行）

删除文件或目录、修改 `.env` 与任何密钥、数据库 schema 变更或迁移、`git push` / `rebase` / `reset --hard` / 强制推送、自动创建远程仓库、安装全局依赖、公开发布。废弃内容移入 `archive/`，不直接删。

### 忽略规则

`node_modules/`、`data/`、`.DS_Store`、`*.log` 均不入库。`data/` 里的数据库与图片是真实数据，备份另存，不靠 git 管。

## 六、变更流程

1. 需求变了 → 先改 `PRD.md`，再改施工单，最后改代码。
2. 技术约束变了 → 先改 `AGENTS.md`，再改代码。
3. 发现更简单可靠的做法 → 记进 PRD 决策记录，说明替换了什么、为什么。
4. 旧库只读，任何情况下不写入。
5. 验证失败继续定位根因，不贴临时补丁；同一问题连续三次未解决，停下来说明情况。

## 七、部署流程（NAS）

```bash
mkdir -p data && sudo chown -R 1000:1000 data   # 容器内非 root 用户需写权限，仅 NAS 上执行一次
docker compose up -d --build
curl -s http://<NAS-IP>:8080/health
```

- 不在路由器做公网端口映射；校外访问走 Tailscale（使用者侧配置）。
- 镜像不写死 `platform:`，由 NAS 本机 CPU 架构决定（本轮使用者未确认架构）。
- 部署后必须做 PRD 第九节 A1–A9 的结果回读，尤其是 A5 手机拍照落盘、A6 不跨页断题、A7 调度重启验证。
