---
name: nx-kn
description: 当需要检索本机 Obsidian 知识库（笔记全文 / 语义搜索）、建立或更新索引、增减知识库目录、查看索引状态，或把 vault 之外的**文档站**抓下来入知识库时使用。触发词：知识库、笔记、检索、搜索、召回、Obsidian、vault、索引、query、index、多个库、添加目录、抓取文档站、爬虫、资料采集、crawl、离线文档。不适用：需要 LLM 问答或摘要（本工具只召回、不生成）；需要登录/验证码或必须靠 JS 渲染的站点。
---

# nx-kn

一句话：把本机的**若干** Obsidian vault 当成知识库，用 zg（zvec-grep）做「精确 + 关键词 + 语义」
三路混合检索，跨库结果按融合分合并成一张列表，带所属库名 + 库内相对路径 + 行号；
CLI 与 Web 面板共享同一份 action 声明。需要时还能把**文档站抓下来**清洗成 markdown、
当作一个知识库一起检索。

## 核心不变量（违反会怎样）

1. **一条 action 定义，三端同时暴露**——在 `src/modules/<域>/index.js` 里同时声明
   `cli` 路径与 `http` 路由。漏了 http 面板就没有这个操作；漏了 cli 则启动时
   registry 自检直接报错（「Web 操作必须有 CLI 等价」）。
2. **失败抛错，业务结果返回 `{status}`**——「还没建索引」这类可决策的情形
   返回 `{ needIndex: true }` 而不是抛错，面板要拿它渲染引导。
3. **索引归 zg 所有**——nx-kn 只调 zg、不碰 `.zvec-grep/` 里的文件；
   zg 的 provider key 存在 `~/.zvec-grep/config.json`，nx-kn 不存储、不回显、不转发。
   `kb remove` 只解除登记，**不删**磁盘上的索引。
4. **多库是「多个索引 + 一次合并」，不是「一个大索引」**——zg 的索引按 workspace 根
   组织（`<root>/.zvec-grep/`），两个 vault 天然是两个索引、可以有两个不同模型。
   因此：查询是逐库召回后按 score 合并，命中**必须**带上所属库名（只给相对路径
   无法定位到磁盘文件），且某个库召回失败不能拖垮整次查询。
5. **采集产物是普通 markdown 目录，不是特殊数据源**——`nx-kn crawl run` 把文档站
   清洗成 `<数据目录>/sources/<名>/**/*.md`，然后**当作一个知识库登记**。
   于是索引 / 检索 / 增量 / 多库合并全部复用 kb 域，采集只负责「URL → 干净 markdown」。
   抓完还要跑一次 `nx-kn index` 才进索引。
6. **守护不自己实现增量，只挑时机**——`watch` 复用 `index` 那条路（zg 的 `index` 本就是
   增量），它唯一的本职是「在笔记变了的时候把索引叫起来」。守护**逐个目录**挂 watcher，
   排除目录（`.obsidian/` 本机 325 篇 md、`.zvec-grep/` 自己写盘）**根本不进监听范围**
   ——这样既不会「索引写盘 → 触发 → 再索引」自激成环，也避开了 Linux 上递归 watch 会走进
   `.zvec-grep/`、撞上索引重建的目录而抛 ENOENT 把守护进程打崩的坑（真实事故）。
   守护失败**不退出**：索引出错与监听出错都只记进状态，下一笔改动照常处理。

## 命令速查

| 命令 | 说明 |
| --- | --- |
| `nx-kn kb add <vault路径> [--model M]` | 把一个 vault 加进知识库列表（按绝对路径去重；可加多个）。`kb use` 是同义别名 |
| `nx-kn kb remove <vault路径>` | 从列表移除（只解除登记，不删索引；要删索引跑 `zg index <路径> --drop`） |
| `nx-kn kb list` | 列出各库的笔记数 / 索引状态 / 生效模型 |
| `nx-kn index [--rebuild] [--model M] [--types md,txt] [--root 路径]` | 对**全部库**建 / 增索引（默认只收 md）；不带 `--rebuild` 即**增量**；**换模型必须叠加 `--rebuild`** |
| `nx-kn query "<问句>" [--limit N] [--preview none\|short\|full] [--root 路径]` | 跨全部库混合检索，按融合分合并；输出 `[库名] 相对路径:行号` + 片段 |
| `nx-kn status` | zg 可用性 / 各库笔记数 / 索引覆盖度 / 生效模型 |
| `nx-kn crawl add <url> [--name N] [--match glob] [--max N]` | 登记一个**文档站**采集源（只登记不抓） |
| `nx-kn crawl run [--name N] [--rebuild]` | 抓取并清洗成 markdown；默认增量（内容未变的页面不重写） |
| `nx-kn crawl list` | 采集源列表 + 上次抓取时间 / 页数 / 失败数 |
| `nx-kn crawl remove <name> [--purge]` | 解登记（默认保留抓下来的文件与知识库登记；`--purge` 连目录一起删） |
| `nx-kn watch [--debounce ms]` | **守护**：常驻监听各库，笔记一变就自动增量索引（Ctrl+C 停）。改完笔记要立刻搜到就用它 |
| `nx-kn watch status` | 守护状态：是否在跑、监听哪些库、最近刷新记录 |
| `nx-kn serve [--port N] [--no-open] [--no-watch]` | 启动 Web 面板（**默认带守护**；`--no-watch` 关掉，面板上也有开关） |
| `nx-kn routes` | CLI 命令 ↔ HTTP 路由对照表（agent 摸底从这里开始） |
| `nx-kn help [topic]` | 帮助；`help --json` 输出可解析命令表 |
| `nx-kn health` | 自检 |
| `nx-kn settings get` / `set k=v...` | 读写设置（白名单外的键被拒绝） |
| `nx-kn skill install [--to 目录] [--force]` | 把用法装给本机 agent（默认 `~/.claude/skills`；`--to` 可换落点） |
| `nx-kn skill get [ref]` | 导出 skill 上下文（正文 + 安装状态；不读本机 skill 目录的外部 agent 用它） |
| 任何命令 + `--json` | 机器可读输出（agent 模式） |
| 任何命令 + `--store <path>` | 本次运行覆盖存储路径（测试防污染必用） |

`--root <路径>` 是「这次只看这一个目录」，用于探路；它不需要事先 `kb add`，
也不会改动库列表。

## 检索结果怎么读（agent 必读）

- 输出头 `[nx-kn 知识库召回]` 列出参与检索的**每个库的根目录**
- 多库时命中带 `[库名]` 前缀，**读全文必须拼那个库的根**：`<该库的根>/<相对路径>`，
  行号区间即 `:<起>-<止>`（拼错库根是最容易犯的错，所以库名和路径在同一行）
- `matchedBy` 说明命中来源：`fts`（关键词/倒排）、`vector`（语义相似）、`rg`（精确匹配）；
  同时出现即两路都命中，通常更可信
- `score` 是 zg 的融合分（RRF，由排名派生），**跨库可比**——它决定多库合并后的顺序
- 末尾 `results:` / `background_refresh:` 是运行时状态行，不是命中内容
- 结果是**一条融合后的排序列表**（内部固定加 `--fuse`）：长问句不会被拆成多组重复返回
- 某个库目录不存在或召回失败时，结果里会出现「跳过 […]」而**不是**整体报错
- `--json` 下的结构：`hits[]` 每项含 `path / start / end / heading / headingLevel /
  snippet / matchedBy / score / vault / vaultName`；另有 `searched[]` 与 `skipped[]`

## agent 典型会话

**冷启动（还没有任何库、也没索引）——除装引擎外，全程不需要用户手动操作：**

1. `nx-kn status --json` —— 先看现场：`zg.installed` / `configured` / 每个库的 `indexed`
   - `zg.installed=false` → 这是**唯一**需要用户出手的一步：`npm install -g @zvec/zvec-grep`（Node ≥ 22）
   - `configured=false` → 手里还没有库，照第 2 步加一个
2. `nx-kn kb add "<vault绝对路径>" --json` —— 登记目录。可多次添加，检索时一起搜
3. `nx-kn index --json` —— 建索引。**不用给 `--model`**：会自动落到内置默认
   （本地离线模型），干净机器上也能一次跑通。要换模型才加 `--model M`，
   已建索引换模型必须叠加 `--rebuild`
4. `nx-kn query "问题" --json` —— 取 `hits[]`。每条都带 `vault`（哪个库）、
   `path`（库内相对路径）、`start`/`end`（行号）、`score`
5. 读原文：把 `<hits[i].vault>/<hits[i].path>` 拼起来，取第 `start`–`end` 行

**日常（索引已建）：**

- 新写了笔记 → `nx-kn index`（增量，**别加 `--rebuild`**，旧向量会原样保留）
- 出错时读 `error` 字段：带「用法:」前缀 = 参数问题；
  `EXTERNAL` = zg 调用失败（多半是没装）

**默认模型可被环境变量顶替**：`NX_KN_EMBEDDING=local/potion-code-16m-v2` 会改写
「没显式指定时用哪个模型」——CI、内网、或者只想快跑一遍时用得上。
它压不过 `--model`，也压不过已建索引里锁定的模型（换模型是显式动作，不该被偷袭）。

## 资料采集（把文档站变成知识库）

需要「离线查某个文档站 / 网页资料」时，先抓再检索。**全程不需要用户手动操作**：

1. `nx-kn crawl add <文档站地址> --name <名> --json` —— 登记采集源（只登记，不联网）
   - 可选 `--match '/guide/**'` 只抓一段路径、`--max <n>` 改页数上限（默认 200）
   - 省略 `--name` 时从地址推导（`vitepress.dev/guide` → `vitepress-dev-guide`）
2. `nx-kn crawl run --name <名> --json` —— 抓取并清洗成 markdown。
   取 `results[].via`（`sitemap` / `bfs`）、`changes`（added/updated/unchanged）、`failed`
3. `nx-kn index --json` —— 抓下来的目录已**自动登记为知识库**，直接建索引即可
   （也可 `--root <results[].dir>` 只给这一个建）
4. `nx-kn query "问题" --json` —— 与本地 vault 一起被检索，命中带来源库名

要点：

- **静态 HTML 站才支持**：优先 sitemap，回退同域 BFS；只抓同源；串行 + 节流
- **增量靠内容哈希**：`crawl run` 重跑时内容没变的页面不写盘，后续索引如实报 `unchanged`
- 抓取范围（`--match` / `--max`）在 `crawl add` 时定；要改就 `crawl remove` 后重新 `crawl add`
- 删数据用 `nx-kn crawl remove <名> --purge`（不带 `--purge` 只解登记，文件留着）

## 守护（让索引随笔记自动更新）

不想每次改完笔记都记得手动跑一次 `nx-kn index`：

- `nx-kn watch` —— 前台常驻，监听**所有**已登记库；改了哪个库就只对那个库跑增量索引。Ctrl+C 停
- `nx-kn serve` —— 面板进程内**默认**已开守护；面板「守护」一栏能看到最近刷新时间与开关
  （不想默认开就加 `--no-watch`）
- `nx-kn watch status` —— 查当前守护状态与最近刷新记录

要点：

- 只认 `.md`；`.obsidian/`、`.trash/`、`.zvec-grep/` 整棵不看——**这些目录根本不挂 watcher**，
  不是「挂上再把事件丢掉」（`.obsidian/` 是本机最吵的目录，有 325 篇 md；`.zvec-grep/` 是我们
  自己的索引目录，进去既会「索引写盘 → 触发 → 再索引」自激成环，又会在索引重建目录时抛
  ENOENT 把守护打崩）
- **防抖**默认 1.5s：一次保存连发的多个事件合并成一批，不会触发多次索引
  （`NX_KN_WATCH_DEBOUNCE_MS` 可调，测试用）
- 同一库**串行、不重入**；索引期间来的改动合并到下一轮（只补一轮，不是排 N 次）
- 只做「**触发**」——索引本身走的还是 `nx-kn index` 那条路，模型选择 / 增量规则 / `--rebuild` 一字不差
- 守护状态在**进程内**：CLI 的 `watch` 与面板上的守护互不可见（各看各的进程）
- 索引失败不会让守护退出：错误记进状态，下一笔改动照常处理

## 什么时候不用

- 需要多用户 / 远程部署（这是本机单用户工具）
- 需要 LLM 问答、摘要、改写（本工具只做召回）
- 需要 wikilink / backlink 关系图谱（不在范围内）
- 需要跨库**去重/合并同一篇笔记**：两个库若有目录嵌套，同一文件可能被两个索引各收一次
- 需要抓**需要登录 / 验证码 / 靠 JS 渲染**的站点（采集只处理静态 HTML）
- 需要开机自启 / 系统服务形态的守护（`nx-kn watch` 是前台进程，`serve` 的守护随面板进程存在）

## 数据与存储

- 状态存 `~/.nx-kn/store.json`，原子写；环境变量 `NX_KN_STORE` 可覆盖路径
- 知识库列表在 `kb.vaults[]`，每项是 `{ path, name, model, addedAt }`——
  模型是**每库一个**（旧版的全局单值会在读取时自动迁移成列表）
- 采集源在 `crawl.sources[]`（与 `kb.vaults` **分列**）；抓下来的 markdown 落在
  `<数据目录>/sources/<源名>/**/*.md`，每页一个 `.md`（带 `source` / `title` / `fetchedAt` frontmatter）；
  增量清单是各源目录内的 `.nx-kn-crawl.json`（`url → { file, hash }`）
- `sources/` 跟着 store 走（同一个数据目录），所以 `NX_KN_STORE` / `--store` 一次搬动全部数据
- 环境变量 `NX_KN_VAULT` 可临时指定「只看这一个目录」（不落盘、不改列表）
- 环境变量 `NX_KN_CRAWL_DELAY_MS` 改抓取间隔（默认 300ms）
- 索引落在各库自己的 `<vault>/.zvec-grep/`（zg 拥有；删掉它 = 那个库回到未索引状态）
- 删除数据 = 删 store.json（无隐藏状态）

## references

- `00-design.md` —— 架构与不变量的完整阐述（改动核心代码前必读）
- `10-knowledge-base.md` —— 知识库检索域：多库管理、收录范围、模型切换、结果格式与排障
- `20-external-collection.md` —— 外部资料采集域：抓取范围与礼貌、清洗规则、增量判定、落盘布局与排障
