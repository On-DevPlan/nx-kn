# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [0.2.1] - 2026-10-04

### Fixed — 守护在 Linux 上会被索引自身打崩

- **Linux 上 `nx-kn watch` / `nx-kn serve` 的守护进程会因 `ENOENT` 直接退出**，
  于是「改了笔记自动刷新索引」这个能力在 Linux 上实际不可用。根因是 `core/watch.js`
  原先用 `fs.watch(dir, { recursive: true })` + **事件级**过滤。但 Linux 的 recursive 是
  **用户态实现**（`node:internal/fs/recursive_watch` 自己 `readdir` 整棵树），事件过滤只能丢掉
  事件、**拦不住 Node 走进** `.zvec-grep/`；而那里正是索引时不断重建 RocksDB 分片段目录的地方，
  父目录与子目录两次 `readdir` 之间目录被换掉就抛 `ENOENT`：
  `ENOENT: no such file or directory, scandir '…/index.zvec/3/scalar.index.1.rocksdb'`。
  更关键的是该错误以 FSWatcher 的**异步 `error` 事件**抛出，原先无人监听 →
  `Unhandled 'error' event` → **整个守护进程当场退出**。而「索引 churn」恰恰是守护自己触发
  索引造成的，属自毁回环。macOS 的 recursive 走原生 FSEvents、不经过这条 scandir 路径，
  所以此前在 macOS 上试不出来（CI 上的表现是时绿时红：同一个 SHA 可能过、下一个纯文档提交反而红）。
- 修法（两处，都在 `core/watch.js`）：
  - **改逐目录监听**——自己从根枚举目录、跳过排除目录（`shouldSkipDirName`），
    给每个目录挂**非递归** watcher。于是 `.zvec-grep/` **连 `readdir` 都不会发生**，
    回环与那条 `ENOENT` 路径同时消失，顺带让 Linux / macOS / Windows 行为一致；
    目录增删由 `rename` 事件触发节流重扫来动态挂/摘。
  - **每个 watcher 都挂 `error`**——异步错误只报告不抛，摘掉出错的 watcher 并在重扫时
    重新挂上（自愈）；同一目录持续出错不刷屏。
- `modules/kb/watch.js`：watcher 级故障现在记进守护状态并报一条事件（文案标明「已自动重挂」），
  与既有的「索引失败不掀掉守护」是同一条原则；收到变化即清掉该标记（免得自愈后仍挂着旧错误）。
- 新增 6 条单测：断言**排除目录绝不被监听**（用「误闯即报 ENOENT」的假文件系统做闸门）、
  **watcher 异步 error 不掀翻进程且能自愈重挂**、目录增删会挂上/摘掉、同目录出错不刷屏、
  `close` 不留句柄。
- 文档同步更正：`assets/nx-kn/SKILL.md`（第 6 条不变量 + 守护小节）、
  `assets/nx-kn/references/10-knowledge-base.md` §五——原先写的是「过滤放在事件入口」，
  这条在 Linux 上不充分，已改为「排除目录根本不挂 watcher」。

`0.2.0` 是带着这个问题发出去的（在 Linux 上守护不可用），因此补 `0.2.1`。

## [0.2.0] - 2026-10-04

本次把计划里阶段 4 的「守护」与阶段 5 的「外部资料采集」一起交付——
**0.1.0 之后新增的两个能力域**（0.1.0 只到多库 + 增量索引为止）。

### Added — 守护（watch）：让索引随笔记自动跟上

- **阶段 4 的「守护」落地**。此前只有「增量索引」（`zg index` 默认增量 + 面板「更新索引」按钮），
  缺的是「自动触发」那一环：改完笔记仍需手动补一次索引。现在有两条路：
  - `nx-kn watch [--debounce ms]` —— **前台常驻**，监听所有已登记库，改了哪个库就只对那个库
    跑一次增量索引，Ctrl+C 停
  - `nx-kn serve` —— 面板进程内**默认**已开守护（`--no-watch` 关掉），面板「知识库」页新增
    「守护」一行：运行状态 + 最近刷新时间与变更数 + 启停开关（运行中每 3s 轻量轮询一次状态）
- **`nx-kn watch status`**（`GET /api/kb/watch`）：查是否在跑、监听哪些库、累计刷新/错误次数与
  最近记录。单独一条**轻量**路由——只读内存里的会话、不碰 zg，所以面板能高频轮询它，
  而不会像 `status` 那样每轮都逐库起一次 `zg status`（秒级）
- **`core/watch.js`**（纯函数 + 单测）：路径过滤 `shouldWatchRelPath`、事件合并
  `createBatcher`（防抖 + 去重）、`fs.watch` 递归封装 `watchTree`。零业务语义
- **`modules/kb/watch.js`**：守护会话（单例）——逐库 watcher、**串行 + 不重入**的索引队列、
  最近 20 条事件的环形缓冲、状态快照。**只做「触发」**：索引本身走的还是
  `service.index({ root })` 那条路，模型选择 / 收录口径 / `--rebuild` 规则一字不差
- **`NX_KN_WATCH_DEBOUNCE_MS`** 环境变量（默认 1500ms）：防抖窗口可调，测试用
- **面板配套修复**：守护状态走独立接口，不并入 `kb/status`——否则一次状态刷新会
  逐库起 `zg status` 子进程（冷启动实测 5.9–6.5s），把「刷新一行守护状态」变成面板卡顿

三条**正确性**必需（都不是优化）：

- **过滤放在事件入口**：只认 `.md`，`.obsidian/`（本机 325 篇 md，占全部 md 的 59%）、
  `.trash/`、`.zvec-grep/` 整棵不看。`.zvec-grep/` 是我们**自己**的索引目录，
  不过滤就会「索引写盘 → 触发 → 再索引」自激成回环；防抖挡不住它（防抖只合并密集事件，
  不改变「该不该响应」）
- **同库串行、不重入**：索引期间来的变化只置一个 dirty 标记，跑完补一轮——
  **不是**排 N 次队（否则一次批量编辑会把队列塞满重复索引）
- **索引失败不掀掉守护**：错误记进状态（`watch status` 可见）并继续监听，
  否则一次偶发的磁盘/模型问题会让用户以为「守护坏了」，而其实下一笔改动就好了

### Added — 全链路流水线测试的守护段

- `tests/pipeline.mjs` 新增 **P14**：起一个**真的常驻 `nx-kn watch` 进程** → 往已登记的库里
  写一篇新笔记 → **不跑任何 `index` 命令**，轮询 `query` 直到命中 → 按提示拼出的绝对路径
  读到原文 → 断言守护的日志里确有一次「已增量更新」。
  防抖用 `NX_KN_WATCH_DEBOUNCE_MS=200` 压短；带超时护栏与 `finally` 收尾
- 新增单测 `tests/unit/watch.test.mjs`（11 条）：只认 md / 隐藏目录整棵不看 /
  `.zvec-grep` 回环防护 / 反斜杠路径 / 空值；防抖合并去重、窗口以最后一次变化为起点、
  `flushNow` 与 `dispose`；`watchTree` 的过滤（注入假 `fs.watch`，不碰真实文件系统）、
  拿不到文件名时保守触发、监听起不来时返回 `error` 而非抛出

### Added — 外部资料采集（把文档站抓成知识库）

- **`modules/crawl/`（阶段 5）**：把 vault 之外的**静态 HTML 文档站**抓下来、清洗成
  markdown 入知识库。核心设计是「抓取产物落成**普通 .md 目录**，再当作一个知识库登记」——
  于是索引 / 检索 / 增量 / 多库合并 / 面板全部复用 kb 域，采集只负责「URL → 干净 markdown」
- 四条 action（CLI + HTTP 同源）：`crawl add <url> [--name N] [--match glob] [--max N]`、
  `crawl run [--name N] [--rebuild]`、`crawl list`、`crawl remove <name> [--purge]`
- **发现**：优先 `<站点根>/sitemap.xml`（`sitemapindex` 递归，限深 3 层），回退**同域 BFS**；
  只抓同源、串行、间隔 300ms（`NX_KN_CRAWL_DELAY_MS` 可改）、单请求超时 20s、自定义 UA
- **清洗**（`core/web.js`，纯函数 + 单测）：正文容器优先 `main`/`article`/`[role=main]`/
  `.theme-default-content`/`.vp-doc`/`.markdown-body` 等；剔除 nav/footer/aside/侧栏/目录树/
  面包屑/编辑链接与图片；相对链接转绝对；**表格转 GFM**；每页一个 `.md`（带
  `source`/`title`/`fetchedAt` frontmatter）
- **增量按内容哈希**（不是时间戳）：哈希只算**正文**（`fetchedAt` 每次都变，算进去会让
  增量永远失效），未变的页面**不写盘** → 后续 `zg index` 如实报 `unchanged`，不重复嵌入
- **落盘**：`<数据目录>/sources/<源名>/`，增量清单 `.nx-kn-crawl.json`（`url → { file, hash }`，
  以 `.` 开头 → zg 默认不扫）。**sources 跟着 store 走**（同一个数据目录），所以
  `NX_KN_STORE` / `--store` 一次搬动全部数据 —— 测试隔离也因此是全覆盖的
- **`crawl remove` 默认只解登记**：抓下来的文件与 zg 索引留着（它同时还是一个知识库）；
  `--purge` 才连目录带知识库登记一起删。与 `kb remove` 的语义对齐
- **面板新增「资料采集」tab**：源列表（页数 / 失败数 / 上次抓取 / 是否已入知识库）+
  添加源 / 抓取更新（增量、主按钮）/ 重新抓取（全量）/ 移除，附 CLI 等价提示
- 随包手册新增 `references/20-external-collection.md`；`SKILL.md` 补采集触发词、
  第 5 条核心不变量与「资料采集」典型会话（抓取 → 清洗 → 建索引 → 检索）

### Added — 全链路流水线测试的采集段

- `tests/pipeline.mjs` 新增 P10–P13：起 `node:http` **本地静态「文档站」**（sitemap +
  导航/页脚噪声 + 每页独有词），断言 sitemap 发现、三页落盘带 frontmatter、版式噪声被剔除、
  **抓完自动登记为知识库**；再抓一次断言「内容未变 → 0 重写」，改一页断言「只重写那一页」；
  `index`+`query` 命中抓下来的词并按提示拼路径读到原文；`crawl remove` 默认保留文件与
  知识库登记、`--purge` 连目录删。**全程不联网** —— 流水线的目标是「CI 可复现」，
  依赖外部站点会把不确定性引进门
- 新增单测 `tests/unit/web.test.mjs`（URL 归一、同源判定、sitemap 解析、glob、
  路径映射与目录穿越、HTML→markdown 噪声剔除与表格转换、空白收敛）与
  `tests/unit/crawl-store.test.mjs`（`crawl.sources[]` 归一化：缺键补默认、按名去重、
  老 store 自动补齐）

### Added — 多知识库（多个 vault 一起检索）

- **`kb.vault`（单值）→ `kb.vaults[]`（列表）**：可以添加多个目录，检索时逐库召回再合并。
  读取老 `store.json` 时自动迁移（`normalizeKb`），无需迁移脚本
- 新增 `kb add` / `kb remove` / `kb list` 三条 action（`kb use` 保留为 `kb add` 的同义别名）；
  `add` 支持 `--model`，把「这个库建索引用哪个模型」跟着库一起记
- **跨库合并**：`query` 对每个库各跑一次 `zg query --fuse --trace`（cwd = 各自库根），
  按 `score`（RRF 融合分，由排名派生、跨库可比）合并排序，切到 `--limit`。
  命中带 `vault` / `vaultName`，输出与文档都标出「读全文该拼哪个库根」
- `index` 默认处理**全部库**（`--root` 缩到单个）；多库串行执行，逐库汇报
  新增/改动/删除/未变与覆盖度
- `status` 逐库给出笔记数、覆盖度、**实际生效的模型**、待更新标记与各自的下一步提示；
  同时给一份 `totals` 聚合视图。多库探测**并发**执行，面板首屏不随库数线性变慢
- 单个库目录丢失或召回失败**不再拖垮整次操作**：`status` 标「目录不存在」，
  `query` 把它记入 `skipped[]`，其余库照常返回

### Added — 全链路流水线测试（skill 装完即可用）

- **`tests/pipeline.mjs`（`pnpm run test:pipeline`）**：把「一个 agent 装完 skill
  之后要做的一整串事」真跑一遍——skill 安装（含重复安装幂等）→ `skill get` 导出 →
  空现场 `status` 引导到 `kb add` → `kb add` → **不给 `--model` 的 `index`**（验证
  默认模型兜底）→ `status` 复检覆盖度与生效模型 → `query` 命中并**按提示拼出的绝对
  路径真能读到原文** → 增量索引（`added 1 / unchanged 2`，旧向量原样保留）→
  新笔记可召回 → 多库合并命中带来源库名 → `kb remove` 只解登记、不删索引。
  每一步是独立子测试，失败能一眼看出卡在哪一环；隔离临时 store / skills 目录 / vault，
  不碰用户真实数据
- **CI 与发版流水线都跑它**：`.github/workflows/ci.yml` 把「装 zg 0.2.2」提到所有
  步骤之前（让冒烟也走真实分支），末尾加 `pnpm run test:pipeline`（用
  `NX_KN_PIPELINE_MODEL` 指一个小模型省下载）。此前冒烟测试刻意不起 zg，
  「加目录 → 建索引 → 检索」这条主干**只在开发者本机验证过**，流水线里没有护栏；
  `npm-publish.yml` 同样如此——装好却用不起来的 skill 不该发出去
- 新增单测：`tests/unit/kb-embedding.test.mjs`（模型取用优先级）、以及
  「skill 文档里出现的每条 `nx-kn` 命令都能解析到真实命令」（用**真正的命令匹配器**
  逐条解析，而非字符串包含——包含判断会漏掉「写了 `nx-kn index`、命令其实叫
  `indexing`」这类漂移）

### Changed

- **默认 embedding 模型支持环境变量覆盖**：新增 `NX_KN_EMBEDDING`，取用顺序变为
  「命令行 `--model` → 已建索引实际生效的 → 该库登记的 → `NX_KN_EMBEDDING` → 内置默认」。
  它压不过前三层（换模型始终是显式动作，不该被环境变量偷袭），用途是 CI / 内网
  不改代码即可换默认模型。面板「添加目录」的预填模型改从 `status.defaultModel` 取，
  与 CLI 保持一致（否则设了变量的机器上，面板会预填一个拉不下来的模型）
- **默认 embedding 模型**：`paths.js` 新增 `DEFAULT_EMBEDDING = 'local/qwen3-embedding-0.6b'`，
  作为取用链最后一层兜底（完整顺序见上一条）。本机 `~/.zvec-grep/config.json` 不存在
  （既无 key 也无全局默认），没有这一层，「添加目录 → 更新索引」在干净机器上必然失败
- **迁移时丢弃旧的全局 `kb.model`**：它是单值字段，`kb use` 切库时被原样保留，
  实测出现过「store 记着 `local/potion-code-16m-v2`、磁盘上没有任何该模型的索引、
  实际索引用的是 `qwen3-embedding-0.6b`」的状态。把它写进每库记录等于把一个
  已知脏值升级成「下次建索引时静默生效的参数」，因此迁移只带 `path` / `name`
- **笔记计数改为对齐 zg 的收录口径**：zg 建索引时会静默跳过隐藏目录、它内置的忽略
  目录名（`node_modules` / `dist` / `build` / `tmp` / `logs` …）、**嵌套 git 仓库整棵**
  与 0 字节空文件。此前 nx-kn 照实数所有 md，于是在正式 vault 上报出「226 篇」而索引
  只有 173 篇——差额 48（克隆仓库 `辅助工具/抓包/langgraph-claude-code`）+ 5（空文件）
  = 53，用户会以为漏索引。现在按同一口径估算，并把差额原因写进 CLI 与面板
  （「另有 1 个克隆仓库、5 篇空文件，zg 默认不收」）。这只是**估算**：权威数字以索引
  自己的 `files / filesTotal` 为准

### Fixed

- **`normalizeVault` 的显示名依赖平台的 `basename`**：`name` 只用于显示，却用
  `node:path` 的 `basename` 推导——POSIX 上 `basename('D:\Notes\Vault')` 返回的是整串
  路径（反斜杠不是分隔符），于是「在 Windows 上写过、在 Linux 上读」的 store.json
  会把 name 变成一条完整路径。CI 因此**连红三次**（kb-store 4 条断言），而且挂在最前面，
  把后面的全链路流水线步骤一起挡住了。改为与平台无关的分段取末（两种分隔符都认）
- **冒烟里「未建索引 → 下一步 `nx-kn index`」的断言过严**：没有 zg 的机器上提示会
  正确地变成「先装 zg」，断言却只认前者 → 干净机器上跑 `pnpm test` 会红。改为两者都接受
  （只要是可照做的提示即可）；CI 则把「装 zg」提到所有步骤之前，让冒烟走真实分支
- **参数含空格时整条 zg 调用被 cmd.exe 切碎**：Windows 上 zg 是 `.cmd` 垫片，必须经
  `cmd.exe /d /s /c` 调用；而 cmd 会**把命令行再解析一遍**，Node 默认又给整行套引号、
  把内层 `"` 转义成 `\"`（cmd 不认）。两者叠加使 `"D:\My Vault"` 裂成两个参数，
  zg 报 `accepts at most one root path` —— 表现为**路径带空格就建不了索引**，
  而且不止路径：`query "多个 词"` 这类调用同样中招。改为**自己加外层引号**
  （`cmd` 的 `/s` 专门剥掉它）并声明 `windowsVerbatimArguments`，让 Node 原样传参。
  真实行为由 smoke 测试驱动真 zg 钉住，源码写法另有单测
- **千分位数字被截断**：zg 给大数加千分位（实测 `Entities    1,490`），而
  `parseStatus` 的数字模式写成 `(\d+)`，**在逗号处就停下**——1490 读成 `1`，
  面板上显示「1 片段」（`num()` 里那句 `replace(/,/g,'')` 永远等不到逗号，成了摆设）。
  覆盖度、Queue、Changes 同类修复，并补单测
- **`zg query --trace` 的 `score=` 会静默污染路径**：命中头形如
  `#1 matchedBy=fts+vector score=0.0328 a.md:1-3`，而 `HIT_RE` 的 `(.+)` 是贪婪的，
  会把 `score=0.0328 ` 连同路径一起吞下——`path` 变成 `"score=0.0328 a.md"`，
  不报错、只是路径全错。改为显式可选捕获组，`score` 落成数字（无 `--trace` 时为 `null`），
  并补单测钉住
- **面板「重建索引」是唯一入口**：增量能力在 CLI 一直有（`zg index` 默认就是增量），
  但面板只暴露 `--rebuild`，用户看到的就是「索引只能被整体替换」。现在拆成
  「更新索引」（增量）与「重建索引」（全量，带二次确认）
- **无索引时「模型」行显示的是上一个库的残留值**：`status` 不再回落到 store 的
  全局 model，索引不存在就显示「（未记录）」；`kb list` 把登记时的模型单独挂在
  `plannedModel` 上，措辞明确为「建时计划用 X」
- **面板无法管理多目录**：改为目录列表（名称/路径/笔记数/覆盖度/模型/待更新徽标 + 移除），
  「添加目录」弹窗同时收集路径与模型（后者默认 `local/qwen3-embedding-0.6b`）
- `useDialog` 支持多字段形态（`fields: [...]`），避免「加目录」要弹两次窗、
  中途取消留下半配置

### Added — kb 域（Obsidian 知识库检索）

- `core/zg.js`：zg（zvec-grep）进程驱动 + 输出解析（`zg query --json` 在 0.2.2 已移除，
  只能解析 agent markdown，规则有单测 `tests/unit/zg-parser.test.mjs` 钉住）
- `modules/kb/`：`kb use` / `index` / `query` / `status` 四条 action（CLI + HTTP 同源）
  - 收录口径：只收 md，排除 `.obsidian/` 与 `.trash/`
  - query 以 **子进程 cwd = vault** 运行（zg 0.2.x 无 root 参数），
    结果带 `[nx-kn 知识库召回]` 归属头，供 agent 拼绝对路径读全文
  - 「还没建索引」返回 `{ needIndex: true }` 业务结果，不是错误
- 面板新增「知识库」tab：状态 + 检索 + 设目录 + 重建索引
- 随包 skill 补 `references/10-knowledge-base.md`；SKILL.md 去掉模板占位符（`<app>` 等）

### Fixed — 面板可读性（CDP 实测驱动）

- **`--mid` 对比度不达标**：原值 `#8b9096` 在白底上只有 **3.22:1**（WCAG AA 要求 4.5:1），
  而它是唯一的「次要文字」色，被 11 处样式引用（`dt` / `.tab` / `.row .desc` / `.tag` /
  `.cli-hint` / `brand .sub` / `.muted` / `.empty` / 按钮禁用态 …）。面板上 39/62 个文本
  元素都是这个灰，观感糊成一片。改为 `#6a6f76`（白底 5.06:1、灰底 4.7:1）。
  实测三页（home / settings / kb）低于 4.5:1 的元素：39 / 18 / 37 → **0 / 0 / 0**
- **模板遗漏 `.opt-row` / `.opt-label` / `.opt-actions` 的样式**：`server-cli-web` 模板
  的 settings 视图与各模块面板都用这三个类名，但模板没有任何 CSS 定义（生成后查
  `document.styleSheets` 无这三条规则）。后果是表单输入框退回浏览器默认宽 **151px**、
  动作按钮不归位。已在 `style.css` base 层补齐，input 宽度变为随容器伸展
- **input / placeholder 落到 UA 默认色**：`input` 未设 `color` → Chrome 默认 `#545454`，
  placeholder → `#757575`（4.6:1，压线）。改为 `--ink` / `--mid`
- **多行片段撑破行高叠字**：`.row` 固定 `28px` + `.desc` 的 `nowrap/ellipsis`，
  检索命中的多行代码片段被裁到与相邻行互相压字。新增 `.row.wrap` 变体（自适应高 +
  允许换行 + `.desc` 独占第二行），`.snippet-box` 显式用 `--ink`（它是内容不是注脚）
- **加载中把「还不知道」渲染成「就是没有」**：`/api/kb/status` 冷启动实测要 **5.9–6.5s**
  （zg status 子进程），期间面板已显示「目录（未设定）/ zg 未安装 / 索引未建」，
  用户会以为 zg 坏了。改为状态未回来时显示 `…`
- `.cli-hint-flag`（如 `--json`）补 `--ink`，与 `.cli-cmd` 同等地位

> `.opt-row` 系列缺样式与 `--mid` 低于 AA 都是**模板级缺陷**，`nx-nx` 的
> `templates/server-cli-web` 与 `tokens@light` 同样存在，会在后续生成的项目里复现。

## [0.1.0] - 生成即初始状态

由 [nx-nx](https://github.com/On-DevPlan/nx-nx) 的 `server-cli-web` 模板生成。
此后按 Keep a Changelog 惯例增条目。
