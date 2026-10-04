# nx-kn 计划 — Obsidian 本地知识库 × zvec-grep 向量检索

> 状态：**阶段 0–5 均已完成**（2026-10-04）。阶段 4 = 增量索引 + 守护（watch，见本文件阶段 4）；
> 阶段 5 = 外部资料采集（crawl，**已改判为纯 Node**——决策修正见本文件阶段 5 正文与
> `stage-5-external-collection-spec.md` 的 D1）。
> 编制时间：2026-10-03 ｜ 归档时间：2026-10-04
> 脚手架：`nx-nx` → `server-cli-web`（letters = `kn`）
> 引擎：`zg`（zvec-grep）
>
> 归档说明：本文件原存于仓库同级 `github/nx-kn-plan.md`，现已归档到 `nx-kn/docs/plan/`
> ——即本计划「阶段 1」里自己要求的落点。文末 **「计划回填」** 是执行过程中对计划的修正
> （模型口径、多库决策、实测事实），与 `plan-vs-code-diff.md` 互为「修正记录」与「对账总账」。

---

## 0. 一句话目标

把 Obsidian 仓库当作**本地知识库**，用 `zg` 建立「关键词 + 语义」混合索引，
由 `nx-kn` 提供 CLI 与 Web 面板做**纯检索**。全程本机，索引落在 vault 内
`<vault>/.zvec-grep/`。

### 本次确认记录（2026-10-03）

| 决策项 | 结论 |
| --- | --- |
| nx-kn 与 zg 的关系 | **包 zg 当引擎**（子进程调用，不自研索引） |
| nx-kn 与 nx-rp 的关系 | **独立项目**，只借鉴 `nx-rp/src/modules/doc/zg.js` 的踩坑经验 |
| 脚手架来源 | **用现成模板生成** `server-cli-web --letters kn` |
| embedding 模型 | **远程 qwen** `qwen/qwen3.7-text-embedding`（1024 维，128K 输入） |
| 索引落盘 | **vault 内** `<vault>/.zvec-grep/` |
| 能力范围 | **纯检索**（不含 LLM 问答、不含 wikilink/backlink 图谱） |
| skill 交付 | `nx-kn skill install` 装到 **`~/.claude/skills`**（同 nx-rp；骨架 A04 / B04 规范） |
| 外部资料采集 | 原为「v0.2 预留：只借 Skill Seekers 思路，Node → Python 子进程 stdio（按 B05 标准）」→ **2026-10-04 改判**：**阶段 5 已实现，纯 Node**（内置 `fetch` + cheerio/turndown，**无子进程**）；Skill Seekers 仅作**参考实现阅读**，不是依赖 |
| 执行节奏 | **先出计划，执行等确认** |

### 架构图对齐（第二轮确认，2026-10-03 22:55）

来自手绘架构图（Section_0 / nx-kn nx-know）逐条对账：

| 图中条目 | 处置 | 落点 |
| --- | --- | --- |
| 1. 唯一一个项目仓库 | 单仓 nx-kn，不拆分 | 全篇 |
| 2. obsidian 兼容 | vault 原位读取 + 排除/噪声处理 | 阶段 2 |
| 3. obsidian 的 skill 作为子 skill 可安装 | `nx-kn skill install` → `~/.claude/skills` | 阶段 3 |
| 4. zg 项目 → boot → nx-rp 里有案例 → zg-cli → 需要向量 api | onboard 流程照抄 `nx-rp/src/modules/doc/zg.js`；需 qwen key | 阶段 0 / 2 |
| 5. skill-seeker → 一丢丢爬虫参考 → python 的子进程 → B05 subprocess stdio / rt 的 python 部分 | **已落地（阶段 5，2026-10-04）**：借 [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)（Python，18 种数据源 → 知识资产，自带 stdio 模式 MCP）的抓取与清洗**思路**——**仅阅读参考，不作为依赖**；但图中「python 的子进程」这一环**未采纳**：已改判**纯 Node**，故 `B05-multi-line-cli-input` 的多行 CLI 协议与 rt 的 Python 部分**均不进主干**（理由见本文阶段 5「决策修正」表与 spec 的 D1） | 阶段 5 |
| 背景：nx-rp ｜ 最后效果：像 rp 一样支持对整体知识库的检索 | 目标一句话的出处 | §0 |

---

## 1. 现状盘点（已实测核实）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `nx-kn` 工作区 | 空目录，可直接生成 | 目录列举仅含本次探测文件 |
| `nx-nx` 模板 | **只有 1 个**：`server-cli-web` | `templates/` 下仅此一项 |
| 生成器目录约束 | 目标**存在且非空即拒**（点文件也计入） | `src/core/generate.js:96-105` `assertTargetUsable` |
| `zg` 可执行 | **未安装**（PATH 无 `zg` / `zg.cmd`） | 命令探测 |
| `~/.zvec-grep/` | **不存在** | 目录探测 |
| nx-rp 的 zg 集成 | 代码完整但**从未端到端跑过** | `~/.nx-rp/doc` 不存在、无任何索引 |
| Node | v22.22.2 ✅（zg 要求 ≥ 22） | `node -v` |
| npm / pnpm | npm 10.9.7；pnpm 经 Volta | 命令探测 |

> 结论：**第一步"打通 zg"是真空白**，不是走形式。且 `nx-rp` 已有实现可作为
> 事实基准，能省掉大量试错。

---

## 2. 前置知识：zg 0.2.x 的接口事实

下表来自 `nx-rp/src/modules/doc/zg.js` 的**已实现代码**（作者实测结论）。
阶段 0 需逐条复核，因为 zg 官方 README 展示的是**新版语法**，与 0.2.x 存在差异。

| zg 命令 | 用途 | 注意 |
| --- | --- | --- |
| `zg version` | 可用性探测 | 第一步永远先跑它 |
| `zg config provider set qwen --api-key <key>` | 写远程 provider 凭据 | key 落在 `~/.zvec-grep/config.json` |
| `zg config model set <model> --default` | 设全局默认模型 | 全部 workspace 共用 |
| `zg auth grant <dir> --capability embedding --scope workspace --embedding <model>` | 给某目录授权 | 签名落 `<kb>/.zvec-grep/authorization.json` |
| `zg index <dir> --mode direct` | 建/增索引 | 换模型必须叠加 `--rebuild` |
| `zg query "<q>" --mode direct --limit N --preview short` | 召回 | **没有 `--root`**，workspace 由**子进程 cwd** 解析 |
| `zg status <dir> --mode direct` | 索引状态 | 排查用 |

**Windows 侧两个硬约束：**

1. `zg` 在 Windows 上是 `zg.cmd`，必须经 `cmd.exe /d /s /c` 调用。
2. 因为 `query` 靠 cwd 解析 workspace，**子进程必须以目标 KB 目录为 cwd 启动**。

**模型切换代价：** 已建索引锁定旧模型维度，换模型必须 `--rebuild`，
否则维度冲突。这是"选型要在第一次索引前定死"的原因。

---

## 3. 目标架构

```
Obsidian Vault (本地 .md)
      │  nx-kn index
      ▼
   zg index (--mode direct)
      │
      ▼
<vault>/.zvec-grep/
   ├── files.zvec     文件元数据
   └── index.zvec     片段：文本 + HNSW 向量 + jieba 倒排 FTS
      │
      │  nx-kn query (子进程 cwd = vault)
      ▼
  混合检索：rg 精确 + BM25 关键词 + HNSW 语义 → RRF 融合
      │
      ▼
  CLI (nx-kn query)  /  Web 面板 (nx-kn serve)
```

参考：`nx-rp/.claude/repo/_self/_read/zvec-grep/存储架构/01-存储设施与索引布局.md`

---

## 4. 分阶段计划

### 阶段 0 — 打通 zg（不依赖 nx-kn）

**目标**：确认这台机器上 `zg` 真的能装、能建索引、能召回。

| # | 动作 | 验收 |
| --- | --- | --- |
| 0.1 | `npm install -g @zvec/zvec-grep` | `zg version` 有输出 |
| 0.2 | 取 qwen API key（`platform.qianwenai.com`），写入 provider | `zg config provider` 可读回 |
| 0.3 | 设默认模型 `qwen/qwen3.7-text-embedding` | `zg config model get` 返回该值 |
| 0.4 | 对**临时小目录**（3~5 篇中文 md）授权 + 建索引 | 目录下出现 `.zvec-grep/` |
| 0.5 | 中文语义问句召回 | 命中正确文件 + 行号 |

**为什么先跑小目录**：把"环境/代理/授权"与"Obsidian 适配"两类问题隔离开，
避免一开始就在大 vault 上排障。

**已知风险（本机特有）**
- Agent 会话注入了 `HTTP_PROXY/HTTPS_PROXY`（`http://127.0.0.1:<随机端口>`），
  **远程 embedding 需要访问 qwen 端点**，大流量可能被代理掐。
  需实测；失败时分别试「清掉代理跑」与「保留代理跑」以定位。
- PowerShell 设环境变量用 `$env:VAR = "..."`，与 README 的 `export` 不同。

**产出**：一份打通记录（命令 + 实际输出 + 踩坑），供计划校准。

---

### 阶段 1 — 生成 nx-kn 骨架

**目标**：拿到可运行的 CLI + Web 面板骨架。

> 开发全程按 `sl/skills/server-cli-web-scaffold` 的 ref 体系走：
> 初始化 A00–A06、扩展 A07、运行 A08、skill 交付 A04/B04、
> 涉及子进程 / 多行输入时读 B05。

```
node bin/nx-nx.mjs template create server-cli-web --letters kn --dir <目标>
```

**目录冲突处理（重要）**
`assertTargetUsable` 要求目标全空，而 `nx-kn/` 下后续会有 `.workbuddy/`、
`docs/`。两种做法二选一：

- **方案 A（推荐）**：生成到临时空目录 → 内容整体并入 `nx-kn/`。
  不碰任何既有内容，无回滚风险。
- **方案 B**：生成前把 `nx-kn/` 内既有项临时移出 → 生成 → 移回。

**待定选项**（见 §5 未决问题）：`description` / `port` / `tokens`（面板主题）
/ `layout` / `style` / `scheme`（logo 撞色）/ `version`。

**验收**：`pnpm install && pnpm start` 起得来面板。

---

### 阶段 2 — Obsidian 适配层（纯检索）

**目标**：`nx-kn index / query / status` 三条 CLI 跑通。

**2.1 切片策略**
`zg` 的 schema 内建 markdown 维度字段 `heading` / `heading_level`
（见存储架构文档 §2.1），与 Obsidian 的 `#` 标题结构天然对齐 —— **v1 先用
zg 默认切分，不自研**。若中文长笔记召回不理想，再考虑自定义切片。

**2.2 Obsidian 特殊性（纯检索范围内的最小集）**

| 项 | 处理 | 说明 |
| --- | --- | --- |
| `.obsidian/` 配置目录 | **必须排除** | 全是 JSON/主题/插件，纯噪声 |
| `.trash/` | **必须排除** | 已删笔记 |
| YAML frontmatter | **待验证是否需要剥离** | zg 是否会把 frontmatter 当正文索引，影响噪声比 |
| `[[wikilink]]` / `![[embed]]` | 记为噪声，v1 不解析 | 图谱能力不在本次范围 |
| `%%注释%%` / 代码块 | 记为噪声 | 同上 |
| 附件（图片/PDF） | **不索引** | 纯检索范围外 |

> 排除规则的具体机制（zg 的 ignore/glob 参数？根目录外的过滤文件？）
> 是**本阶段最需要实测的点**，计划不预设答案。

**2.3 CLI 设计**

| 命令 | 作用 |
| --- | --- |
| `nx-kn index [--rebuild]` | 对 vault 建/增索引 |
| `nx-kn query "<问句>" [--limit N]` | 混合检索，输出文件+行号+片段 |
| `nx-kn status` | 索引状态、文档数、模型 |

对比参考：`nx-rp zg query` 会在结果前拼一段「知识库根 / 相对路径」头部，
让 agent 能定位归属 —— 这个做法值得沿用（对 AI 消费结果很关键）。

**验收**：中文长问句能命中正确笔记，且能定位到行。

---

### 阶段 3 — Web 面板 + agent skill

**目标**：`nx-kn serve` 提供检索界面，同时交付可安装的 agent skill。

- 搜索框 → 结果列表（文件名 / 行号 / 片段）→ 点击跳转
- 遵循 nx-nx 骨架的分层：`core / modules / runtime / web`，模块间禁止互相依赖
- 面板不写死任何业务字段，按 option schema 自动生成表单（骨架既有约定）
- **skill 交付（架构图第 3 条）**：`nx-kn skill install` 把「怎么用 nx-kn 检索
  Obsidian 知识库」装到 `~/.claude/skills`（同 nx-rp），按骨架 [[A04-assert-skill]]
  的最小骨架 + [[B04-multi-skill]] 的扩展口径；`skill get` 同步支持（外部 agent 拿全上下文）

**验收**：面板里搜得到、点得开、结果与 CLI 一致；`skill install` 后
Claude Code 侧 agent 能自助完成「建索引 / 提问」闭环。

---

### 阶段 4 — 增量与守护（**已完成**，2026-10-04）

**目标**：Obsidian 里改一篇笔记，检索能立刻反映。

- ~~需要决定：手动 `nx-kn index` 触发，还是 watch 式增量（Obsidian 写盘频繁）~~
  → **两者都要**：手动 `index` 是基础，守护是「自动挑时机」的那一层
- ~~`zg index` 是否本身支持增量~~ → **是，且是默认行为**（实测见 N1）：只嵌新增/改动，
  已建向量原样保留
- **验收**：改一篇笔记 → 刷新 → 能检索到新内容

#### 实现记录（2026-10-04）

| 落点 | 内容 |
| --- | --- |
| `core/watch.js` | 监听基元（纯函数 + 单测）：`shouldWatchRelPath` 入口过滤、`createBatcher` 防抖合并、`watchTree` 递归封装 |
| `modules/kb/watch.js` | 守护会话（单例）：逐库 watcher、串行 + 不重入队列、事件环形缓冲、`runWatchForeground` |
| `kb.watch` / `kb.watchStatus` | 两条 action：`nx-kn watch`（前台常驻）/ `nx-kn watch status`（`GET /api/kb/watch`）；HTTP 侧开关 `serve` 内的守护 |
| `runtime/cli.js` | `serve` 进程内**默认**起守护，`--no-watch` 关掉，退出时收尾 |
| `modules/kb/view.jsx` | 面板「守护」一行：状态 + 最近刷新 + 启停（运行中每 3s 轻量轮询） |
| `tests/` | 单测 11 条 + 流水线 P14（真起常驻进程：写笔记 → 不手动 index 即可检索到） |

**决策：守护只做「触发」，不重写索引逻辑。** zg 的 `index` 本就是增量的，所以守护唯一的
本职是「在正确的时机把它叫起来」——模型选择 / 收录口径 / `--rebuild` 规则与手动路径一字不差。
必须自己处理的三件（都是正确性而非优化）：**入口过滤**（`.obsidian/` 里有 325 篇 md，占全部
md 的 59%；不挡 `.zvec-grep/` 则会「索引写盘 → 触发 → 再索引」自激成环）、**防抖**（1.5s；
Obsidian 一次保存连发多个事件）、**串行不重入**（索引期间来的改动只置 dirty、跑完补一轮，
不排队 N 次）。守护状态只在内存里——「谁在监听」是进程事实，持久化只会制造假象。

**形态决策**：不做守护进程 / 开机自启——前台 `watch` 与 `serve` 进程内的守护两条路，
与既有 `serve` 同形态，不引入额外运行设施。

> 原计划「若本阶段不确定性偏高，可作为 v0.2 交付」不再适用：不确定性来自「zg 是否支持
> 增量」，实测（N1）已确认支持，本阶段因此收口。

---

### 阶段 5 — 外部资料采集（**已实现**，2026-10-04）

> **实现记录**：本阶段已落地，代码在 `src/modules/crawl/` + `src/core/web.js`；
> 展开的独立 spec 见 [`stage-5-external-collection-spec.md`](./stage-5-external-collection-spec.md)，
> 面向使用者的手册见随包 `assets/nx-kn/references/20-external-collection.md`。

**目标**（架构图第 5 条）：把 vault 之外的资料源清洗成 markdown 入知识库，
再走同一套 zg 索引。

#### 决策修正：进程形态由「Node → Python 子进程」改判为**纯 Node**

原计划的「进程形态 = Node 主进程 → Python 子进程，stdio 通信」经逐条复核后**推翻**，
理由记在这里以免日后反复（完整论证见 spec §1）：

| 原计划的理由 | 复核结果 |
| --- | --- |
| 「借 [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) 思路」 | Skill Seekers 确实是 Python，但本节已明确**不引入为依赖**。要借的是「抓取与清洗**思路**」，与实现语言无关 |
| 「Python 侧实践参考 rt：scraper / playwright / OCR」 | **实测 rt 的抓取栈**：简单站点用 `httpx + bs4`，`playwright` 只出现在**登录 + 验证码**场景。公开文档站两者都不需要 |
| （隐含）「抓取需要浏览器渲染」 | `playwright` 有**一等公民的 Node 包**，渲染不构成 Python 的必要条件 |
| — | 而 nx-kn 是**发布到 npm 的包**：要求用户额外装 Python 3.10+ / venv / pip 依赖，直接违背「装上即可用、不需要用户额外手动操作」 |

若将来确实需要 Python（如 PDF / OCR），再按 `B05-multi-line-cli-input` 以**可选旁路**加入，
而不是把 Python 设为主干前提。

#### 实现口径（实际落地）

| 维度 | 决定 |
| --- | --- |
| 进程形态 | **纯 Node**（无子进程）。抓取用内置 `fetch`，HTML 解析用 `cheerio` + `turndown`(+`turndown-plugin-gfm`) |
| 数据流 | 抓取产物落成**普通 `.md` 目录** `~/.nx-kn/sources/<名>/`，再**当作一个知识库登记** → 索引/检索/增量/多库合并全部复用 kb 域 |
| 发现 | sitemap 优先（`sitemapindex` 递归），回退同域 BFS；只抓同源、串行、300ms 间隔 |
| 增量 | 按**清洗后正文的内容哈希**判定；未变不写盘（保留 mtime）→ 后续 `zg index` 如实报 `unchanged` |
| 触发 | 架构图明确「一丢丢」——**最小实现**，只做**静态 HTML 文档站**一种数据源 |
| 命令面 | `crawl add / run / list / remove`（与 kb 域动词对齐，`run` 对应 kb 的 `index`） |
| JS 渲染 | MVP **不做**（需要时再评估 Node 版 `playwright`） |

#### 参考实现（只借思路，不引入为依赖）

[Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)（MIT，Python 3.10+）：
文档站 / GitHub 仓库 / PDF 等 18 种数据源 → 抓取 → 分类 → AI 增强 → 打包，
自带 stdio 模式 MCP 服务器。「一丢丢爬虫参考」指借它的抓取与清洗思路 —— 仅**阅读参考**，
不是被调用的组件。

---

## 5. 未决问题（需要你提供）

1. **Obsidian vault 的绝对路径**是什么？
2. vault 的**规模与语言**（篇数、总体积、是否以中文为主）？
3. 是否已有 **qwen API key**？若没有，是否接受去 `platform.qianwenai.com` 领取？
4. vault 是否接 **Obsidian Sync / git**？
   - 若接，`<vault>/.zvec-grep/` 会被同步/提交 → 需要我加 `.gitignore` 或者
     改「索引写在 vault 外」。
5. 面板外观选项：`port` / `tokens`（light/dark/warm/mono）/ `layout`（tabs/sidebar）
   / `style` / logo `scheme` / 初始 `version`。
6. 交付形态：**只本机跑**，还是要走 nx-nx 骨架带的 npm 发版流水线？
7. 「整体知识仓库检索」是**一个 vault 一个索引**，还是将来要支持多个 vault 并存？

---

## 6. 风险清单

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 本机代理掐远程 embedding | 阶段 0 直接卡死 | 阶段 0 专项实测；必要时剔除代理变量 |
| zg 官方文档语法 ≠ 0.2.x 实测语法 | 照文档写命令会失败 | 以 `nx-rp/src/modules/doc/zg.js` 为基准，逐条复核 |
| 换 embedding 模型需重建索引 | 选型反复会白建 | 阶段 0 就把模型定死 |
| 中文切片/召回质量 | 影响核心体验 | 阶段 2 用小样本先验；不达标再自研切片 |
| 大 vault 索引耗时/内存 | 首建可能很久 | 阶段 2 先量级评估，必要时分期索引 |
| `nx-nx` 目录必须全空 | 与 `.workbuddy/`、`docs/` 冲突 | 阶段 1 方案 A：临时目录生成后并入 |
| 零依赖之外：`nx-kn` 与 `nx-nx` 的模板漂移 | 骨架升级要手工同步 | 明确不迁移存量，模板即事实源 |

---

## 7. 本计划不做

- 不做 LLM 问答（RAG）
- 不做 wikilink / backlink 关系图谱
- 不做图片 / PDF 多模态索引
- ~~v0.1 不做外部资料采集~~ → **已在阶段 5 实现**（2026-10-04）：只做**静态 HTML 文档站**一种源
- 采集中**不做**：需要登录 / 验证码的站点、需要 JS 渲染的站点、全站镜像、定时守护（watch 留后续）
- 不把 Skill Seekers 引入为依赖（只作参考实现阅读）
- 不装 zg 的 MCP（沿用 nx-rp 的纪律：zg 只当召回引擎）
- 不迁移 nx-rp 存量知识库
- 不自动 `git init` / `gh repo create`（生成器本身就不做）

---

## 附：工作记录 2026-10-03

- 读取 `nx-rp/.claude/repo/_self/_read/zvec-grep/存储架构/` 两篇（存储布局 +
  C++ 内核嵌入 Node），确认 zg 落盘为 `@zvec/zvec` 内嵌向量库（非 SQLite）。
- 盘点 `nx-nx`（模板生成器，1 个模板）与 `nx-rp`（已有 zg 集成代码，未跑过）。
- 实测本机：`zg` 未安装、`~/.zvec-grep/` 不存在、node v22.22.2 可用。
- 发现 `assertTargetUsable` 对目标目录「非空即拒」的约束，据此调整计划文档落点。
- 待办：`nx-kn/.workbuddy/memory/` 的会话日志在骨架生成后再落盘
  （避免提前占位导致生成失败）。
- **第二轮（架构图对账）**：逐条解读手绘架构图；确认 `nx-rp` 的 zg 集成、
  `nx-nx` 模板、本机环境三处事实与图一致；新增 skill 交付（阶段 3）与
  外部资料采集（阶段 5，v0.2 预留）两块。
- 核实三份参考的真实落点：
  - Skill Seekers = `yusufkaraaslan/Skill_Seekers`（Python，18 数据源 → 22 导出目标，
    stdio 模式 MCP 与 B05 呼应）；
  - B05 = `sl/skills/server-cli-web-scaffold/references/B05-multi-line-cli-input.md`
    （多行 CLI 输入 / heredoc / stdin，2026-10-02 新增，已确认文件存在）；
  - rt 的 Python 部分 = `rt/backend/src/rt_backend/`（FastAPI + scraper/playwright/OCR）。

## 附：执行记录（第三轮，2026-10-03 23:30，阶段 0 + 1 完成）

### 阶段 0 — 打通 zg ✅

| # | 实测 | 结果 |
| --- | --- | --- |
| 0.1 | `npm install -g @zvec/zvec-grep` | **zg 0.2.2** 安装成功（`zg.ps1` @ AppData\Roaming\npm） |
| 0.2 / 0.3 | qwen key 配置 | **未做**（key 未提供）；改用本地模型先打通全链路 |
| 0.4 | 对 `nx-kn-smoke/`（3 篇中文 md）建索引 | `zg index --embedding local/qwen3-embedding-0.6b` 一次成功：3/3 文件、9 实体、1024 维 cosine，`.zvec-grep/` 正常落盘 |
| 0.5 | 三路召回验证 | 混合中文问句「登录页为什么提示超时」Top3 全中目标文件（fts+vector）；FTS「mixWhite TagsView」Top1 正确；rg 精确「given」定位到行 ✅ |

**0.2.2 与计划假设的差异（需在阶段 2 落进代码）：**

1. **`zg onboard` 命令已不存在**——nx-rp `zg.js` 的 onboard 流程不能照抄，
   授权改走 `zg auth grant [root] --capability embedding --scope workspace`。
2. 本地模型清单里新增 **`local/qwen3-embedding-0.6b`**（1024 维，llama-cpp，
   中文友好、离线、免 key）——已用它通过验收；若远程 qwen 因代理不稳，
   它是可靠的降级/替代方案，且维度同为 1024。
3. 模型下载（首次建索引拉本地模型）**没有被会话代理掐断**，原「代理风险」
   对本地路线不成立；远程 qwen 路线仍待 key 到位后实测。

### 阶段 1 — 生成 nx-kn 骨架 ✅

- `nx-nx template create server-cli-web --letters kn --dir nx-kn` 直接生成
  （目录保持全空，**未触发**原计划的「临时目录并入」方案 A）。
- 选项取默认：port 7881 / vitePort 7882 / tokens light / layout tabs /
  style paper / scheme mars / version 0.1.0；description 已写入。
- `pnpm install` ✅ → `pnpm test` 全绿：lint ✅、vite build ✅（49 模块）、
  smoke 5/5 ✅、unit 7/7 ✅。
- `pnpm start` 实测：`GET /api/health` → 200
  `{"ok":true,"app":"nx-kn","version":"0.1.0"}`；首页 200 ✅。
- 注意：Windows 下后台拉起要用 `cmd /c pnpm start` 或终端直接跑，
  `Start-Process pnpm`（.cmd shim）拉不起来。

### 下一步（阶段 2 待你两个输入）

1. **Obsidian vault 绝对路径**（§5.1，最卡进度的一项）。
2. **qwen API key**：提供后配远程模型实测；不提供也可先用
   `local/qwen3-embedding-0.6b` 直接进入阶段 2，后续换模型需 `--rebuild`。

## 附：执行记录（第四轮，2026-10-03 23:40，阶段 2 完成）

### 阶段 2 — Obsidian 适配层 ✅（阶段 3 的面板检索界面一并完成）

新增 `kb` 域，四条 action（CLI + HTTP 同源）：`kb use` / `index` / `query` / `status`。

| 落点（A07 闭环） | 文件 |
| --- | --- |
| 平台驱动（zg 进程 + 输出解析） | `src/core/zg.js`（core 层，零业务） |
| vault 路径常量与环境变量 | `src/core/paths.js`（`NX_KN_VAULT`、`VAULT_EXCLUDES`） |
| 存储结构 | `src/core/store.js` 的 `initialState()` 加 `kb: { vault, model }` |
| 业务 | `src/modules/kb/service.js`、`index.js`、`view.jsx` |
| 后端注册 | `src/runtime/registry.js` 的 `MODULES` |
| 前端注册 | `src/web/frontend/registry.js` 的 `VIEWS` |
| 库出口 ❗无断言 | `src/index.js` 加 `export * as kb` |
| lint 禁列 ❗无断言 | `eslint.config.js` 的 files + group 加 `kb` |
| 测试 | `tests/unit/zg-parser.test.mjs`（10 例）、`tests/smoke.mjs`（+5 例只读路径） |
| agent 手册 ❗单向断言 | `assets/nx-kn/SKILL.md`（去掉模板占位符）+ `references/10-knowledge-base.md` |
| 项目文档 | `README.md`（结构 + 上手 + 落点表）、`CHANGELOG.md`（Unreleased） |

**实测验收（全部通过）**

| 项 | 证据 |
| --- | --- |
| `pnpm test` | lint ✅ · vite build ✅（50 模块）· smoke 10/10 ✅ · unit 18/18 ✅ |
| CLI 端 | `kb use` 识别 Obsidian + 3 篇笔记；`index --rebuild` → 3/3 文件、9 片段、100% 覆盖；`query` 中文问句 Top1 命中正确笔记并带行号与片段 |
| HTTP 端 | `/api/health` 200（15 条命令）· `/api/kb/status` 200 · `/api/kb/query` 200 结构化 `hits[]` · 空问句 → 400 且保留「用法:」契约 |
| 反向 lint 测试 | 故意让 `kb` import `home` → `no-restricted-imports` 报错 ✅（证明新模块真的进了互依禁列） |

**本阶段新踩的三个坑（已固化进代码注释与单测）**

1. `zg query --json` 在 0.2.2 已移除 → 只能解析 agent markdown；解析规则写进
   `core/zg.js` 并由 `tests/unit/zg-parser.test.mjs` 钉住（含 `source:` 行、正文 `#` 标题
   不误判、路径含空格/中文）。
2. `zg status` 的覆盖条是 `#` 与 `-` 混排（`################----  79%`），字符类只写 `#`
   会让覆盖度**永远为空**——第一版就是这个 bug，靠 Node 侧抓原始输出定位。
3. 解析行**不能 `trimEnd()`**：空源码行输出为 `7\t`，字符被吃掉后片段里的空行整段丢失，
   笔记在面板上读起来连成一片。

另：模板遗留问题——`assets/nx-kn/SKILL.md` 里的 `<app>` / `<skill-name>` 等占位符
**生成时不会被替换**（生成器只参数化 `core/paths.js`），已在本项目改为真实命令；
`nx-nx` 模板本身同样存在该问题，未擅自改动，留给第 4 步一并处理。

---

## 附：计划回填（第五轮，2026-10-04）

执行过程中对计划的**修正**。原计划里写错或没写到的，以本节为准。

### §5 未决问题——全部有了答案

| # | 原问题 | 答案 |
| --- | --- | --- |
| 1 | vault 绝对路径 | `D:\Obsidian Vault` |
| 2 | 规模与语言 | 真实笔记 **226 篇** md、以中文为主；另有 `.obsidian/` 内 325 篇 md（占全部 md 的 59%，被排除规则挡掉） |
| 3 | qwen API key | **始终未提供** → 全链路走本地模型（见 D1） |
| 4 | 是否接 Sync / git | **是 git 仓库**（`D:\Obsidian Vault\.git` 存在）→ 索引写 vault 内曾会被 `git status` 看到；已由 vault 侧 `.gitignore` 挡住（见 N5） |
| 5 | 面板外观选项 | port 7881 / vitePort 7882 / tokens light / layout tabs / style paper / scheme mars / v0.1.0 |
| 6 | 交付形态 | 本机跑 + 远程仓库 `On-DevPlan/nx-kn` |
| 7 | 单 vault 还是一个索引多 vault 并存 | **多 vault 并存**（见 D3——这是本计划最大的一次口径变更） |

### 决策修正

| # | 计划写的 | 修正为 | 原因 |
| --- | --- | --- | --- |
| **D1** | 远程 `qwen/qwen3.7-text-embedding`（1024 维，需 key） | **本地 `local/qwen3-embedding-0.6b`**（同为 1024 维），并新增内置默认 `DEFAULT_EMBEDDING` | key 一直没到位；本地模型离线、免 key、中文可用，且实测没被会话代理影响。计划里「代理掐远程 embedding」的风险对本地路线不成立 |
| **D2** | 阶段 0.2/0.3 配 key + 设全局默认模型 | **不做**：`~/.zvec-grep/config.json` 至今不存在 | 由 D1 取代。代价是「新索引必须有模型」，用内置默认兜住 |
| **D3** | §5.7 留作未决 | **支持多 vault**：`kb.vaults[]` + 逐库召回后按 score 合并 | zg 索引按 workspace 根组织，多库天然是多索引；合并是唯一可行的「一起搜」 |
| **D4** | 计划归档到 `nx-kn/docs/plan/` | **已归档**（就是本文件） | — |

### 计划之外、实测才发现的事实（需并入认知）

| # | 事实 | 证据 |
| --- | --- | --- |
| **N1** | `zg index` **默认就是增量**：不动已建向量，只处理新增/改动/删除 | 3 篇库加 1 篇后跑无 `--rebuild` 的 index → `3 scanned, 1 added, 2 unchanged`，实体 2→3。**原计划 §阶段 4「zg 是否本身支持增量」的疑问至此有答案** |
| **N2** | `zg query --trace` 输出 `score=`，是标准 **RRF**（由排名派生，**跨库可比**） | `#1 matchedBy=fts+vector score=0.0328 a.md:1-3`；`2/61 = 0.0328`。这是多库合并排序的唯一依据 |
| **N3** | 给 query 加 `--trace` 会**静默污染路径** | `HIT_RE` 的 `(.+)` 贪婪吃掉 `score=0.0328 `，`path` 变成 `"score=0.0328 a.md"`；不报错、只是路径全错。已改为可选捕获组 + 单测 |
| **N4** | `.obsidian/` 占 vault 全部 md 的 59% | 顶层 md 计 551、`.obsidian` 325 → 真实笔记 226。排除规则不是可选项 |
| **N5** | vault 是 git 仓库 → `<vault>/.zvec-grep/` 会进 `git status` | `D:\Obsidian Vault\.git` 存在，**原计划 §5.4 的风险成立**；已解决：vault 侧 `.gitignore` 写入 `.zvec-grep/`，实测 `git check-ignore -v .zvec-grep` → `.gitignore:2:.zvec-grep/` |
| **N6** | `zg config` **只写不读**（无 `provider list` / `model get`）；`zg query --json` 已移除；`zg onboard` 已不存在 | 实测报错文本。探测 key 只能看 `config.json` 是否存在；读当前模型看 `zg status` 的 `Embedding` 行 |

### 阶段 4 的更新

原计划把「增量」列为阶段 4 的不确定项。实测（N1）后拆成两半，**两半均已完成**：

- **增量索引**：zg 原生支持且是默认行为，`nx-kn index` 直接受益——**已完成**
- **守护/watch**：`nx-kn watch` 前台常驻、`serve` 进程内默认开启、面板可开关——
  **已完成（2026-10-04）**。它只做「触发」，索引本身仍走 `nx-kn index` 那条路

