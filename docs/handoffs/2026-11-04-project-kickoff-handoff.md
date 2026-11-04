# mistake-loop 项目交接

| 项 | 值 |
| --- | --- |
| 交接日期 | 2026-11-04 |
| 项目路径 | `/Users/walt/codes/my/mistake-loop/` |
| 当前状态 | 研究阶段结束；项目规范已生效；业务代码零行 |
| 本文件用途 | 让接手者在**不重读此前六轮对话、不重做调研**的前提下接上 |
| 必读前置 | 项目根目录 `AGENTS.md`（项目规范，效力高于本文件） |
| 本轮动作 | 仅新建本文件与上级目录；未改旧库、未 `git init`、未写业务代码 |

## 一、结论先行

1. 这个产品不是「错题库」，是**让错题状态自己往前走的常开服务**。命名 `mistake-loop` 就是绑在旧库的失败点上：旧库不缺数据、不缺教学法文档，缺的是让 `next_review` 真的往前走。
2. 载体定为 **NAS Docker 本地 Web**，技术栈 **Node.js 26 LTS**，独立目录独立项目，名字 `mistake-loop` 已经用户确认。小程序、公网网页、本地单机、Python、混仓，均已否决。
3. 融合关系是**互补，不是折中**：数据模型与教学法全取 `mistake-wiki`，运行机制与减摩擦全取公众号文章。前者规则硬但没跑起来，后者真跑起来了但规则薄。
4. 当前最大风险不是技术选型，而是**闭环从未被真实验证**：旧库 19 道错题，15 道复习全部逾期约 5 个月，`mastered` 仅 1 道，零真实学生试运行。换任何技术栈都救不了这一点。
5. 开工前还有未定项（第六节）。其中「给谁用」决定是否把 NAS 暴露到公网，是分水岭。**接手者不得替用户假设。**

## 二、任务来源（用户诉求的演进顺序）

- 起点：小学语数外三科错题库软件，先做本地软件，倾向微信小程序；要求研读一篇公众号文章（用户说含文字与视频），结合 `/Users/walt/codes/my/mistake-wiki` 的既有做法，取二者之长；**明确要求先研究方案，不开发**。
- 第二轮：家里有 7×24 常开 NAS、可跑 Docker，提出改做本地 Web，电脑/手机/平板都能访问。
- 第三轮：明确要求「重新单独做成 Web 应用」，技术栈用 **Node.js，不用 Python**。
- 第四、五轮：确认新建独立目录、不影响旧东西；请我起名并说理由；用户选定我推荐的 `mistake-loop`。
- 第七轮（本轮）：要求写一份 handoff，好在新项目里继续研究。即本文件。

## 三、三路材料的研究结论

### 3.1 旧库 `mistake-wiki`：值钱的是设计，不是代码

形态：Obsidian + Markdown + 18 个 Python 脚本的知识库，**不是软件**。无 UI、无数据库、无账号、无多用户概念。

今日实测（可复验，命令见第十节）：

| 项 | 实测值 |
| --- | --- |
| 体积 / 文件数 | 304M / 5611 个文件 |
| git | 55 次提交，28 项未提交或未跟踪（8-19 批次脚手架至今未入库） |
| 错题总量 | 19 道：数学 16、语文 3、英语 0 |
| 状态分布 | `new` 3 / `reviewing` 15 / `mastered` 1 |
| `next_review` | 9 道 2026-05-28、6 道 2026-06-03、4 道空值；按今日 2026-11-04 计，15 道全部逾期约 5 个月 |
| 学习单元 | `wiki/learning-units/` 126 份；`learning-units` + `strategies` + `textbooks` 合计 299 份，零真实试运行 |
| 工程基础设施 | `package.json` / `Dockerfile` / `docker-compose.yml` / `.dockerignore` 全部没有 |

照搬的设计资产（只搬规则与数据，一行代码不搬）：

- 错因四分法 `conceptual / procedural / metacognitive / factual` + 子类型 → `wiki/error-types.md`
- 五态机 `new → diagnosing → correcting → reviewing → mastered`
- 三层变式：表面 / 结构 / 情境（旧库表述「换数字 → 换角度 → 换场景」）→ `outputs/项目复盘.md`
- 1-3-7-30 弹性复习：迟到不重置、做错回诊断
- 支架式引导（不直接给答案、一次只问一个维度、关键结论由学生说出）、掌握证据五选一 → `wiki/strategies/学习系统总览.md`
- 教材定位（版本 / 册 / 单元 / 课题 / 页码）作数据主键、A4 打印规范

必须补的短板：

- 人工改 frontmatter 换成数据库事务；多处手写索引换成实时聚合。旧看板曾虚报「已掌握 6 道」，19 道题就出现数据漂移。
- 两套流程并存且冲突：旧流程「AI 直接给病因」违反新流程「学生自己定位」。新系统**只保留一套**。
- 变式题全靠手写，`gen-*-html.py` 把题目硬编码在源码里。
- 语文、英语近乎空白；**不得把数学题型结构机械套用于语文和英语**（旧库 handoff 第九节自己写过）。三科各自建错因与变式规则。
- 旧库自己的判断：`docs/handoffs/2026-08-19-learning-system-upgrade-handoff.md` 第九节「不先开发独立 App、小程序或复杂网页」「不以一次做对作为已掌握的唯一依据」；`outputs/项目复盘.md` 自列 10 个问题，第一条是「没有移动端」。

### 3.2 公众号文章：值钱的是「跑起来的机制」

- 来源：公众号「腾讯WorkBuddy」，2026-11-04 16:57，《老师搭系统、家长管回收、孩子拿反馈：张心老师的小学数学个性化教育实验》，<https://mp.weixin.qq.com/s/ZfkSP-_st6o1L_MRYdI3aQ>。主角是深圳育才一小数学老师张心，40 人班。
- 机制链：腾讯文档问卷先征得同意（40 人中 30 多个愿意）→ 只把 10–20% 纸笔作业换成 5–10 分钟线上选做 + 抽奖 → 家长与孩子共同登记错题、**反思必须手写** → AI 读数据出个人分析报告 + 可打印专项练习 → **老师把关**再发回家庭。
- 三个硬判断：克制的数字化（明确拒绝把作业全搬上网，理由是孩子自制力）；「AI 替他把为什么错讲明白了，他读懂了，不等于他会了」；AI 分身三层（规则 / 记忆 / 技能，同类纠正出现两次升级成规则）与「孩子专属的、可被 AI 读取的成长档案」。
- 载体事实：张老师用的是答题网页 `gougedemath.cn`（腾讯云）与错题集网页应用，**不是小程序**。同批报道的深圳老师做的也全是互动网页 / 工作台。
- **不能照抄的部分（本次研究最关键的发现）**：这套机制成立的前提是深圳城市家长每天花几分钟配合、且事先点头同意。本项目学情是四川留守儿童，家长多在异地、祖辈监护，「家长管回收」这一环大概率失效。因此录入责任必须落在**老师 / 课堂 / 校内批量拍照**，家长只做可选、不做必需。
- 文章的另一弱项：闭环止于「生成报告 + 练习」，未公开错因分类、掌握判定、复习调度规则 —— 正好由旧库补上。

研究边界：该链接正文是图文。HTML 中 `video_ids` / `video_page_infos` 为空，正文无 iframe、无 `data-mpvid`，**没有可播放的内嵌视频**；用户提到「有视频」，若后续拿到视频文件或视频号链接，须转写后再补一层。配图与关联报道里提到的 26 支微课、174 道题、课标坐标等，只见文字与截图 OCR，正文未核实，不可当事实引用。张老师所用教材版本正文未出现。

### 3.3 小程序与 NAS 的硬约束

小程序：2023-09-01 起新小程序须完成 ICP 备案才可上架；沙箱不能访问本地文件，数据必须上云、离线不可用；不满 14 岁儿童的错题照片 / 姓名 / 成绩需专门处理规则 + 监护人明示同意；每次发布要审核。个人主体类目限制来自第三方整理，官方类目页未给结论，实际以微信后台提交时要求为准。结论：小程序只在「分发 / 提醒」这一层值钱，不做数据主库。

NAS 的三个坑：

1. **访问边界**：家宽普遍 CGNAT 大内网、无公网 IPv4，80/443 常被封，端口映射既难通又不安全。只给自己设备用走 Tailscale / ZeroTier；**不要直接映射端口**。要让外部人用浏览器打开就得上出向隧道 + 域名 + 强制登录，合规成本回来一半。
2. **手机拍照**：`getUserMedia` 只在 HTTPS 或 `localhost` 下可用，手机上无 localhost 豁免，`http://192.168.x.x:8080` 会被拒。用 `<input type="file" accept="image/*" capture>` 调系统相机绕开，或给 NAS 配 HTTPS。这一条决定「随手拍一题」是 10 秒还是 2 分钟。
3. **备份与算力**：RAID 不等于备份，SQLite 单文件 + 图片目录要定期导出到另一处并演练恢复；低功耗 ARM NAS 跑不动 OCR 与大模型，云 API 处理，密钥走容器环境变量。

### 3.4 四种载体对比

| 载体 | 数据归属 | 多端 | 常开调度 | 备案 / 审核 | 外网可用 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地单机 Web | 本地 | 差 | 无 | 无 | 无 | 关机即停，低一档 |
| **NAS Docker Web** | **本地，统一** | **好** | **有** | **无** | 需 Tailscale / 隧道 | **选定** |
| 微信小程序 | 云端 | 最好 | 有 | 备案 + 主体 + 审核 + 儿童信息同意 | 天然 | 合规最重、迭代最慢 |
| 公网网页 | 云端 | 好 | 有 | 备案 + 域名 | 天然 | 同小程序，略轻 |

## 四、已定决策

| # | 决策 | 依据 | 状态 |
| --- | --- | --- | --- |
| 1 | 先研究方案，不开发 | 用户明确要求 | 已执行完毕 |
| 2 | 载体：NAS Docker 本地 Web | 常开才能跑每日调度，补上旧库「人不开电脑系统就不存在」的架构级缺陷 | 已定 |
| 3 | 后端 Node.js 26 LTS | 用户明确要求，覆盖上层 `my/AGENTS.md` 的 Python 优先；`node:sqlite` 内置，避开 NAS arm64 原生编译 | 已定，声明已写入 AGENTS.md |
| 4 | 新建独立目录、独立项目 | 上层规范「每个独立项目一个目录」；混仓会撞 304M 构建上下文、`.gitignore` 的 `outputs/` 规则、两份规范打架、28 项脏状态 | 已定并建目录 |
| 5 | 命名 `mistake-loop` | 用户从 6 个候选中确认；与 `mistake-wiki` 形成「静态库 vs 运行系统」对照 | 已定 |
| 6 | 旧库冻结为只读数据源 | 只做一次性导入，绝不反向写；跨项目读文件不需要共仓 | 已定 |
| 7 | 第一版 AI 只留接口、不接真实密钥 | 我的建议，先把闭环用真实数据跑通，避免卡在密钥与「密钥需先问」红线上 | **待用户确认** |

## 五、已否决的做法（不必重新论证）

微信小程序 / 公网网页作为第一版；本地单机 Web + 手机 H5；Python / Flask / 复用旧库 18 个脚本；在 `mistake-wiki/` 里加 `web/` 子目录；复制旧库改名再改；Postgres、前后端分离、React / Vue、构建链、账号体系、学生在线答题、家长端、OCR 自动切题、AI 实时讲题、变式免审核；把「家长每日配合」设为必需环节；把数学题型结构套到语文英语上。

## 六、开工前必须由用户确认或补齐（接手者不得假设）

| # | 待定项 | 为什么是分水岭 | 建议 |
| --- | --- | --- | --- |
| 1 | **给谁用**：自己一个孩子 / 自己一个班 / 多班多老师 / 对外产品 | 决定账号体系、儿童信息合规、是否公网入口。「给谁用」实际等于「要不要把 NAS 暴露到公网」 | 主方案按「只服务老师和本人设备、学生端全纸质」推进 |
| 2 | **NAS 型号与 CPU 架构**（amd64 / arm64） | 决定镜像 tag、多架构构建、能否本地跑 OCR | 先问，不猜 |
| 3 | 是否接受在老师设备上装 Tailscale | 决定校外访问形态；用户侧配置，不属本项目代码范围 | 先问 |
| 4 | **教材版本定死** | 教材定位是数据主键，混版本会污染整库。旧库四上三科骨架为人教版数学 / 统编语文 / 人教PEP英语，需用户复核 | 先问 |
| 5 | **验收标准** | 旧库正是断在「页面 / 文档做完就算完」 | 照旧库 handoff 原文：两周真实试运行、无提醒时每周主动用约 3 次、不以一次做对判定掌握 |

另：上一轮已向用户提出 5 项方案确认（整体方案是否 OK / Express 5 + 8080 + 不引 ESLint 与 TS / 第一版 AI 不接密钥 / 先不 `git init` / 待补两项），用户尚未逐项回复，直接要了 handoff。接手时先补这一确认，再动代码。

## 七、新项目现状（今日实测）

- `/Users/walt/codes/my/mistake-loop/` 下原有且仅有 `AGENTS.md`（69 行，已回读校验），本轮新增 `docs/handoffs/2026-11-04-project-kickoff-handoff.md`。
- 未 `git init`（按第四轮说的省事版，第一版跑通再定）；无 `package.json`、无 Dockerfile、无 `data/`、无业务代码。
- 旧库 `mistake-wiki/` 一个字节未动，`git status` 仍为 28 项，与操作前一致。旧库存在 `nas/main` 分支，新项目可参照其裸仓库做法做 NAS 同步（该链路是否仍可用未实测）。
- `AGENTS.md` 关键约束：Node 26 LTS 覆盖上层 Python 默认（依赖装容器内，不碰 `my/.venv`）；`node:sqlite` + WAL、单文件 `/data/mistakes.db`；Express 5；端口 8080；三页 + 原生 JS + PWA；打印 CSS 出 A4；`geometry.mjs` 生成 SVG 替代 matplotlib PNG；进程内每日调度 + 启动补算；AI 结果教师审核后生效；密钥走环境变量；不做公网映射；验证命令 `npm test` / `npm run check` / `/health`；删除、密钥、schema 变更、git push / reset、全局依赖、公开发布必须先问。

## 八、落地方案摘要（完整版在上一轮对话，待确认后执行）

- **目录**：`src/`（server / db / schema.sql / scheduler / geometry / ai / routes）、`public/`（三页 + app.js + style.css + manifest）、`scripts/`（import-legacy / backup）、`test/`、根目录 `package.json` `Dockerfile` `docker-compose.yml` `.dockerignore` `.gitignore`、`data/`（本机卷，gitignore）。
- **数据模型 7 张表**：`students`、`textbook_nodes`、`mistakes`（含 `status` `review_round` `next_review` `error_category` `error_subtype` `image_path` `source_ref`）、`variants`（`level` = surface / structure / context）、`review_events`、`sessions`、`mastery_evidence`。`status` / `error_category` / `level` 用 CHECK，`review_round` 限 0–4，`next_review` 建索引；**所有统计实时聚合，禁止多处手写计数**。
- **状态机与调度**（全部在事务内）：做对 → `review_round + 1`，按 1 / 3 / 7 / 30 天写 `next_review`；第 4 轮且有掌握证据 → `mastered`。做错 → `diagnosing`、`round = 0`；变式任一层错 → 回引导。迟到不重置。容器启动补算一次 + 每日定时一次。`node:sqlite` 没有 `db.transaction()` 包装器，需自写 `withTransaction()`（约 20 行），这是本项目唯一要补的代码。
- **页面与接口**：三页（拍照录入 / 今日复习 / 打印导出），约 8 个接口。手机拍照用 `<input type="file" accept="image/*" capture>`。
- **部署**：`FROM node:26-slim`（不用 alpine，避 musl 坑）、非 root、单 service、`./data:/data`、`restart: unless-stopped`、只绑局域网 8080。`scripts/import-legacy.mjs` 按绝对路径只读解析旧库 `M-*.md` frontmatter 与教材 md，用旧 id 作 `source_ref` 保证幂等。
- **验收（命令成功不等于完成）**：`npm test` 全绿 → `npm run check` 无语法错误 → `/health` 200 → 电脑 / 手机 / 平板各打开一次 → 手机拍一题上传并确认图片落 `/data/images` → 导出 A4 页检查不跨页断题 → 把某题 `next_review` 改成昨天后重启容器，确认「今日复习」自动出现该题 → 跑一次备份并在临时目录恢复、校验记录数 → 跑满两周真实使用再谈第二版。

## 九、给接手者的操作顺序

1. 读 `AGENTS.md`，再读本文件。
2. 把第六节未定项与上一轮 5 项方案确认一并向用户问清，不自行假设。
3. 确认后才建目录结构、写第一行代码；顺序建议先 `schema.sql` + `db.mjs` + 状态机测试，再页面。
4. 写完必须跑验证命令并回读结果；部署后必须做结果回读（三端、拍照落盘、打印、调度、恢复）。
5. 旧库只读，任何情况下不写入；涉及删除、密钥、schema 变更、git 操作先问。

## 十、参考材料索引

| 材料 | 路径 / 链接 | 用途与边界 |
| --- | --- | --- |
| 项目规范 | `/Users/walt/codes/my/mistake-loop/AGENTS.md` | 已生效，效力最高 |
| 上层规范 | `/Users/walt/codes/my/AGENTS.md` | 目录规则、LazyDevProtocol、验证要求 |
| 旧库总纲 | `/Users/walt/codes/my/mistake-wiki/CLAUDE.md` | Markdown 知识库操作手册，与新系统无关，只读参考 |
| 错因体系 | `mistake-wiki/wiki/error-types.md` | 四分法 + 子类型，照搬 |
| 流程与原则 | `mistake-wiki/wiki/strategies/学习系统总览.md` | 支架式引导、掌握证据、教材优先 |
| 复盘 | `mistake-wiki/outputs/项目复盘.md` | 三层变式、1-3-7-30、自列 10 个问题 |
| 旧库升级交接 | `mistake-wiki/docs/handoffs/2026-08-19-learning-system-upgrade-handoff.md` | 第九节「明确暂不做」、第十节下一步 |
| 设计文档 | `mistake-wiki/docs/superpowers/specs/2026-05-24-mistake-wiki-design.md` | 核心设计决策 |
| 待导入数据 | `mistake-wiki/wiki/mistakes/M-*.md`、`wiki/textbooks/`、`wiki/learning-units/`、`raw/textbooks/` | 一次性只读导入 |
| 公众号文章 | <https://mp.weixin.qq.com/s/ZfkSP-_st6o1L_MRYdI3aQ> | 见 3.2；本地缓存 `/tmp/wx_article.html` 为临时文件，随时可能清理，不作长期依据 |
| 张老师网页 | <https://gougedemath.cn> | 仅据文章与页面级探查，未做功能实测 |

关键数字复验命令（任意目录执行即可）：

```bash
cd /Users/walt/codes/my/mistake-wiki
du -sh . && find . -type f -not -path './.git/*' | wc -l
git log --oneline | wc -l && git status --short | wc -l
grep -h '^subject:' wiki/mistakes/M-*.md | sort | uniq -c
grep -h '^status:' wiki/mistakes/M-*.md | sort | uniq -c
find wiki/learning-units -type f | wc -l
```

## 十一、AI 不能替用户决定的事

- 不能替用户定「给谁用」、教材版本、NAS 架构、是否开公网、是否接受装 Tailscale。
- 不能把「留守儿童家长无法每日配合」当成已验证事实写进设计；它是需要两周真实试运行检验的判断。
- 不能在未拿到视频本体时声称「研读了视频」；不能把第三方整理的小程序类目资质当官方结论。
- 不能用「页面做完 / 测试通过 / 命令成功」代替「闭环跑满两周」的验收。
- 不能写入旧库、不能创建或修改密钥文件、不能删除文件与目录、不能擅自做 schema 迁移与 git 危险操作。

## 十二、遗留与未核实

1. 文章内嵌视频未获取（用户说有视频）；如拿到，转写后需重新评估「录制 / 讲解」环节是否进第一版。
2. 小程序个人主体类目限制为第三方来源；备案与未成年人要求来自官方与权威媒体。
3. `gougedemath.cn` 未做功能实测；26 支微课、174 道题、课标坐标、张老师教材版本均未在正文核实。
4. 前轮口头提到「8-19 批次 332 个文件」「复习逾期约 3 个月」，本次实测为 `learning-units/` 126 份、三目录合计 299 份，逾期按 2026-11-04 计约 5 个月。**以本次实测为准。**
5. 第一版 AI 是否接真实密钥、是否立即 `git init`，两项均未获用户确认。
