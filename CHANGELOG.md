# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added — scan / check 的项目范围（多项目并发隔离）

- `nx-kn obsidian scan [--project <项目根>]`：带 `--project` 时**只扫该项目目录**
  （`vault/projects/<项目名>/`）里的红链——多项目并发时各扫各的，互不越界。
- `nx-kn obsidian check [... --project <项目根>]`：差分校验同样只算自己项目目录下的红链
  （快照与差分两次要带同一个 `--project`）。
- **解析仍对照全库**：链到共享笔记 / 别的项目的笔记不算红链——否则 agent 会跑去重复建一份，
  那才是真正破坏隔离的地方。
- 有范围时不走外部 obsidian 命令行（它只能扫全库，没有范围概念）；项目目录还没初始化时
  如实提示「先跑 obsidian ask 建根文档」，不报错也不静默扫全库。

## [0.4.3] - 2026-10-23

### Added — 项目域提问的位置入口 `nx-kn obsidian ask`

- 新增 `nx-kn obsidian ask --question "<原始提问>" [--project <项目根>] [--source <出处文档>]`：项目域提问的**唯一位置入口**——定位 / 首次初始化 `<vault>/projects/<项目名>/Base-<项目名>.md`（frontmatter 带 `project` 绑定），把提问清洗成合法文件名后以 `[[…]]` 追加到根文档**末尾**（幂等：重复提问不重复追加），并返回标准 9 步流程要用的全部定位信息（根文档相对路径 / 追加行号 / 答案笔记路径 / 项目根）。
- **一次建立两条关系**：同一个 `[[问题]]` 链接出现在两处、指向同一篇答案笔记——Base 里那一条由命令追加（Base ↔ 目标），出处文档里那一条是用户自己写的（出处 ↔ 目标）。两处都在是预期，不是重复。`--source` 让命令核对出处那篇里确实有这个双链，对不上如实报「请核对出处」，且**不改用户的文档**。
- **目标笔记的 frontmatter 由命令给出**（`note.frontmatter`，照抄即可）：`bklink` 两项（根文档 + 问题链接）、`project` 绑定项目根、`creatime` / `tags` 齐备——agent 不再自己拼 bklink。
- 不带 `--question` 时仅定位 / 初始化根文档（项目解读首次建树的入口）；项目名按 package.json → Cargo.toml → pyproject.toml → 目录名推导，`@scope` 前缀自动去掉。
- skill SOP 同步收紧：项目域提问一律先跑 `ask`，位置与 frontmatter 只由它的返回值决定；**agent 禁止自行决定答案笔记位置、禁止自己拼 frontmatter、禁止创建任何文档树 / 索引 / MOC / 清单文件**（此前 agent 反复冗余地建树建索引）。

## [0.4.2] - 2026-10-22

### Changed — 首页冷启动与设置子页

- 首页不再加载流水线总览；采集源与索引状态移动到「设置 → 流水线」子页，只有进入子页才请求相关 API。
- 修复设置面板 POST 裸键未被 `settings.set` 读取、界面提示已保存但实际未落盘的问题。
- 统一全局开发 shim 从 `package.json` 的 `bin` 字段读取入口，修复错误指向不存在的 `bin/nx-kn.mjs`。

### Added — Obsidian 知识库管理与双链项目解读

- 新增 Obsidian 默认知识库配置与规范文档登记表；支持 `nx-kn obsidian spec` 列表，以及 `spec --doc <key>` 直接获取规范全文。
- 将未解析双链扫描、frontmatter 生成和差分校验集成到 nx-kn 命令；从 skill 内移除 Python 脚本。
- 新增项目解读 SOP：初始化 `<vault>/projects/<项目名>/Base-<项目名>.md` 作为根节点，单项文档之间通过双链建立关系；对文档中的 `[[问题]]`，根据 frontmatter 的 `project` 字段读取对应仓库源码后回答。
- `frontmatter --project <项目根>` 将项目路径写入文档元数据，供后续源码问答定位项目。
- 将 frontmatter 规范放入 Obsidian vault，并登记为 `frontmatter` 规范项。

### Changed — UI 软极简

- 卡片改为圆角浅灰面板，去除双线边框；按钮改胶囊形；弹窗与提示条使用圆角和柔和阴影。
- 保持黑白灰配色，统一圆角 token，避免双线与直角混用。

### Fixed — POST 请求体错误处理

坏 JSON body 现在返回 400 `INVALID_INPUT`，不再被静默当成空参数并回报成功。

### Fixed — 全局安装入口

`link:local` 的启动脚本入口改从 `package.json` 的 `bin` 字段读取。

### Changed — 完全冷启动：采集源与索引管理移入「设置 → 流水线」子页

面板原先在两处挂载即拉昂贵状态：首页的「流水线总览」拉 `/api/crawl/list` 与
`/api/kb/status`（后者要探 zg、逐库起子进程）；知识库页还嵌入采集源管理并在挂载时
请求同一批接口。现在：

- **「设置 → 流水线」子页是唯一的采集/索引管理入口**：流水线总览（①② 阶段 + 一键
  跑流水线）、知识库管理（zg/索引状态、库列表、添加/移除、增量/重建索引、守护）、
  采集源管理（添加/抓取/移除）全部集中在这里；
- 子页**点开才挂载**（不查看，不加载），切走即卸载——首页与设置页的冷启动都不碰
  这些接口；首页冷启动只剩 `/api/bootstrap` 与 `/api/routes` 两个轻请求；
- **知识库页改为纯检索**：查询表单 + 命中结果。查询本身会返回业务结果
  （未建索引时给出可照做的提示），不需要先拉一遍状态来垫底；
- 知识库检索的等价 CLI 提示收窄为 `nx-kn query`；管理命令的提示跟随管理面。

### Fixed — 设置面板的保存按钮此前是假的

`settings.set` 的 `run()` 只读 CLI 的 `k=v` 位置参数（`ctx.pairs`），而面板 POST 的是
JSON 裸键 → patch 恒为空 → service 返回 `skipped` → 界面照弹「已保存」，**实际什么都没写**。
现在两侧都接（CLI k=v / 面板裸键），与 obsidian 域同款。

### Added — 项目解读模式：读大项目 → 生成文档 → 双链拷问

`nx-kn obsidian frontmatter` 新增 `--project <项目根>`：把 `project: "<项目根>"`
写进 frontmatter，将「这篇文档」与「哪个代码库」绑定。配套的
`kn-obsidian-repair-unresolved-links` skill 新增**项目解读模式**（SOP 里的一个特殊场景）：

1. **阶段 A（在项目里）**：探索项目 → 按内容规范生成文档到 vault 指定目录
   （默认约定 `<vault>/projects/<项目名>/`），每篇 frontmatter 带 `project` 字段；
2. **阶段 B（在 vault 里）**：用户在文档里写 `[[问题]]` → 跑标准 9 步流程，
   唯一差别是**步骤 6 必须读项目源码**——答案要落在具体代码上（`文件:行号`、
   真实行为、设计取舍），发现文档写得不对要当场指出，而不是复述文档。

### Changed — `kn-obsidian-repair-unresolved-links` 收成单一 SOP，规范一律走 nx-kn

这个 skill 的定位是**讲清整个 SOP + 引导用 CLI 拿关键上下文与流程点**，所以它现在只有
**一个文件**（`SKILL.md`），没有 `references/`、没有脚本：

- **步骤 0 = 先列清单、再按用途取**：先 `nx-kn obsidian spec` 拿到登记项清单
  （key + 相对路径 + 是否存在），再按用途取具体那几份
  `nx-kn obsidian spec --doc <key>`（直接输出全文）。key 由用户自定，默认约定是
  `content`（内容生成规范）/ `questionnaire`（问卷模式规范）/ `frontmatter`（frontmatter 细则）。
  **清单里没有对应用途的那份 → 停下来问用户**，不许凭记忆编规范。
- **frontmatter 规范也搬进 vault**（`<vault>/nx-kn/frontmatter-spec.md`，登记为
  `docs.frontmatter`）——原先它住在 skill 的 `references/00-frontmatter-spec.md`。
  现在 skill 里只保留**必须遵守的硬约束**（Write content 必须以 `---` 开头、
  必须用命令生成而非手写），细则按需从 vault 取。
- 原 skill 的 `references/` 目录已删除；安装产物只有 `SKILL.md` 一个文件。

### Added — `obsidian` 域：vault 定位与内容规范文档的可配置解耦

新增独立功能域 `obsidian`，专门回答一句话：**「内容规范文档在哪、里面写了什么」**。

```
nx-kn obsidian get                  # 读配置与解析结果（vault 来源 / 规范文档登记表 / 文档存在性）
nx-kn obsidian set k=v...           # 写配置：vault=<绝对路径> / docs.<key>=<相对vault根的路径>
nx-kn obsidian spec [--doc <key>]   # 不给 --doc 列出登记项；给了 --doc **直接输出文档全文**
nx-kn obsidian scan                 # 扫 vault 里的未解析双链
nx-kn obsidian frontmatter --link <文本> [--source <文件>] [--locate]
nx-kn obsidian check --snapshot <文件> / --snapshot-before <文件> --new-file <相对路径>
```

配置落在 `store.json` 顶层 `obsidian{}`：`vault` / `docs{}`（**登记表**：key → 相对 vault
根的路径，可增删任意 key）。vault 解析链：`--vault` > `store.obsidian.vault` > 环境变量
`NX_OBSIDIAN_VAULT` > 第一个含 `.obsidian/` 的 `kb.vaults[]` 登记库 > 从当前目录沿父目录找
`.obsidian`。**兜底只在「未设置」时发生**——设了却指错地方会如实报「目录不存在」，不会悄悄
换成另一个库（那会把配置错误藏进每一篇按错规范写出的笔记里）。未配置是**业务结果**不是错误：
返回 `configured:false` + 可照做的提示，只有 `set` 会因参数非法 / 目录不存在而报错（400 / 404）。

面板新增「Obsidian」页：vault 表单 + 规范文档登记表编辑器 + 解析结果卡片。

### Added — 双链修复的三支脚本收进 nx-kn（skill 不再自带脚本）

原先 `kn-obsidian-repair-unresolved-links` skill 自带三个 Python 脚本
（`scan_unresolved.py` / `gen_frontmatter.py` / `postcheck.py`，约 700 行）。它们现在都是
nx-kn 的命令，**skill 装完即可用，不再需要 python**：

- `nx-kn obsidian scan` —— 扫未解析双链。逐条对照移植原脚本的规则（解码链
  `utf-8 → gbk → 替换`、代码围栏与行内代码剔除、附件扩展名忽略、自链接抑制、
  路径 / basename 两级索引、`ctl/tmpl_*` 跳过），**已用差分测试与原 Python 脚本逐条比对一致**。
- `nx-kn obsidian frontmatter` —— 生成 frontmatter YAML 段（`creatime` / `tags` / `bklink`），
  与原脚本输出逐条一致（仅时间戳与行尾差异：原脚本在 Windows 上是 CRLF）。
- `nx-kn obsidian check` —— snapshot / 差分校验，保留原脚本的 6 条根因诊断文案。

**扫未解析双链优先用外部 `obsidian` 命令行**（它与 Obsidian 实际解析最接近），
不可用时**自动回退内置解析**并用 `via` 字段标明来源。旧 `postcheck.py` 的策略是
「命令起不来才回退」，于是「命令存在却不是 CLI」（本机 `PATH` 上的 `obsidian` 就是
图形界面本体）时会硬失败——移植时没照抄这个坑。另外，探测器会按**磁盘上的真实文件名**
识别 GUI 本体并直接跳过，否则每次扫描都会把 Obsidian 窗口弹到用户面前。

### Changed — `kn-obsidian-repair-unresolved-links` 不再内置内容规范

「四种内容模式」与「问卷模式」两份规范原先打包在 skill 的 `references/10-content-patterns.md`
与 `references/20-questionnaire.md` 里，用户要改规范只能改 skill 源码再重装。现已改为
**从 vault 现读**：skill 新增「步骤 0：拿内容要求」，用 `nx-kn obsidian spec --doc content`
直接取规范全文（不必知道路径、不必自己 Read，SKILL.md 里也不再有 `{content_spec}` 这类
占位符）。命令不存在或报「vault 未设置」时按 `NX_OBSIDIAN_VAULT` → 沿父目录找 `.obsidian`
→ `<vault>/nx-kn/` 的目录约定兜底；**规范取不到就停下来问用户**，不许凭记忆编。

**为什么这么改**：内容规范是**用户的写作偏好**，会频繁迭代；skill 是**工具**，不该背着
用户的内容要求一起发版。解耦之后，改规范 = 改 vault 里的一份 markdown，skill 不用重装。

### Fixed — `link:local` 的全局 shim 指向了不存在的入口文件

`scripts/link-local.mjs` 把全局 `nx-kn` 的启动器写死为 `bin/nx-kn.mjs`，而仓库的入口
早已是 `bin/kn.mjs`——于是 `link:local` 显示「已指向本仓库」（探测只看路径前缀）、
实际全局命令一跑就 `MODULE_NOT_FOUND`。现在 bin 入口从 package.json 的 `bin` 字段取，
不再写死。

### Fixed — POST 的坏 JSON body 不再被静默当成「空参数 + 成功」

`src/runtime/api.js` 原来把请求体解析失败一律降级成空对象（`.catch(() => ({}))`）。
后果是：请求体被截断或转义坏了时，action 收到空参数、返回 `skipped`、HTTP 200，
界面上照样弹「已保存」——**实际什么都没写**。这类「静默失效」比直接报错难查得多。

现在区分两件事：**空 body** 合法（很多 POST 本就不带参数，仍是 200 + skipped）；
**坏 body** 返回 400 `INVALID_INPUT`（`请求体不是合法 JSON: …`）。

### Removed — `needdo` 模块已整体迁出 nx-kn，沉淀为 nx-sk 的 skill

混乱输入收件箱（NeedDo）不再在 nx-kn 维护：
- 命令 `needdo add / list / show / edit / process / brief / apply / review / archive / export / trash / remove / file` 全数移除，CLI 与 HTTP 路由同时退场
- 面板的「NeedDo」tab 已撤，迁移文件 `src/modules/needdo/` 一并删除
- 落盘的收件箱数据目录 `<store>/needdo/` 不再由本工具创建或读取；如果你之前用过，请当作遗留目录手工归档后删除
- 收件箱的「主题整理 + AI 简报 → 写回」流程以 **sk-needdo**（nx-sk 的 skill）继续存在：
  把混乱输入丢给 sk-needdo，agent 会发现或建一个匹配的栏目（section），
  设计字段字典（field dictionary），把每条填进对应条目，并把任务清单以 `md` 字段的
  `- [ ]` 语法写进条目正文，**直接在面板里点击勾选并写回**（这是 nx-sk 的 `MdView` 能力，
  也正是把 needdo 从 nx-kn 迁出的最重要原因）。Skill 安装：`nx-sk skill install sk-needdo`。

迁移原因：needdo 的价值是「先把东西收进来再整理」，但条目本身没有强 schema——
而 nx-sk 的栏目 + 字段字典就是为「一个域一种形状」设计的。把它做成 skill 后，AI
直接产出结构化条目、不再维护一套独立的「条目 / 主题 / AI 附注」数据模型。
原 needdo 的设计文档、`docs/needdo/research-round*.md`、`docs/needdo/progress.md`
保留为历史档案，不再更新。

## [0.4.0] - 2026-10-15

### Added — `needdo export`：把收件箱沉淀成可检索的知识库（round5）

NeedDo 到 round4 为止是个**闭环的孤岛**：收进来 → 整理 → 归档，然后就停在那儿了。
这一轮补上出口——把整理好的条目变成能长期检索的东西，而工具就是本仓自己的知识库域。

**模具与 `crawl` 逐字同构**（这是刻意的，不是巧合）：产物是**普通 markdown 目录**，
自动登记为知识库，索引仍由人显式跑。差别只有一处——crawl 的源在远端，NeedDo 的源
就是 store 自己，所以**不建第二份清单**（crawl 需要 `.nx-kn-crawl.json` 是因为「远端
已删页面」推不出来；这里源头就在手边），权威记录放在条目侧：`exportPath` / `exportRev` /
`exportedAt`（三个字段都进了 store 白名单——归一化是逐字段重建的，漏一个就会让下次导出
重复导一遍）。

```
nx-kn needdo export [--ids a,b] [--topic T] [--redo] [--to <目录>] [--archive]
```

产物落在 `<数据目录>/needdo/export/<主题>/<日期>-<标题slug>-<条目id>.md`，frontmatter
带 `id`（从文件能 grep 回源条目）、`source: needdo`、`title` / `topic` / `kind` / `url?` /
`addedAt` / `exportedAt`。**目标根固定在这里**：绝不能登记 `needdo/` 本身——那儿装着
原件二进制、提取 txt、`trash/` 与整理报告，登记它等于把回收站和流水报告一起塞进索引
（排除名单只有 `.obsidian`/`.trash`，挡不住）。

三条约定都有实证来源，不是拍脑袋：

- **严格单向**：导出物是产物（可重建，同 `sources/` 的定位）。人在 vault 里改了那份 md
  **不回流**——要改就改条目再 `--redo`。本仓没有任何双向同步先例，也不在这儿开这个头
  （自动同步都得回答冲突解决，一次性导出根本不用回答）。
- **不搬家**：路径首次导出时定死，改了主题也不移动文件——Readwise Mirror 改文件名生成
  规则时直接打断了用户已有的内部链接，是踩过的坑。
- **判据用条目指纹而不是产物文件哈希**：frontmatter 里的 `exportedAt` 每次都变，拿它
  算哈希会永远「变了」（正是 crawl 把 frontmatter 排除在内容哈希外的同一个理由）。

跑一次 = 重新检查一遍全部已归档条目，按指纹报 `exported` / `updated` / `unchanged`
（与 `crawl run` 的 added/updated/unchanged 同语义）；`--redo` = 忽略指纹强制重写
（`run --rebuild` 同位）。文档条目**只写 md、不搬原件**，提取不出文本的跳过并计 `skipped`
——一篇没有正文的产物进了检索库只是噪音。`--to` 指向别的目录时**不自动登记**：
那是用户的库，该由 `kb add` 管（用户的库归用户）。

**路径安全**：`needdo edit --topic` 允许自定主题，于是 `../../evil` 这种值就是一次路径
穿越（写文件会跑出 export/，登记库更会把别的目录塞进索引）。主题与标题都过一遍文件名
清洗，单测里钉住了「恶意主题不许把文件写到 export/ 之外」。

**面板**：条目卡一个「沉淀到知识库」按钮（带未沉淀条数）、行内「已沉淀」徽标、
详情里给完整产物路径（可复制）。复用 `.btn`/`.tag`/`Copyable`/`withBusy`——
零新依赖、零新 UI 原语、**kb 域一行代码没动**（只写它的数据）。

### Fixed — 面板深链失效：`#/kb` 打不开，地址栏还会闪一下首页

做 NeedDo 的走查时撞见的：带持久化 tab 访问 `#/kb` 会停在旧 tab；**即便清空 localStorage，
`#/kb` 也会被拽回 `#/home`**。根因在 `App.jsx` 的两个 effect 首帧抢写 hash——负责「回写」
的那个拿的是**尚未被深链改写**的 `ui.view`，于是它把刚打开的深链覆盖掉，顺带触发
`hashchange` 又把 view 改回去。这也解释了前几轮反复记下的「瞬时 `#/home` 跳转」。

修法是给两个 effect 定下先后：启动那一帧**只认领、不写**，把首帧让给深链；顺手让
`hashchange` 只接受注册过的独立 tab（手改地址栏塞个垃圾 hash 不会再污染持久化的 view，
`#/crawl` 这类嵌入视图也正确回落到默认 tab）。

### Added — `needdo` 收件箱：检索 / 编辑 / 回收站（round4）

条目多起来之后的三件日常事——**找、改、撤**——各自补齐，顺手修了两处协议越权。

**找**：`needdo list [q]` 多了一个位置参数，**一个词就是全文入口**（标题 / 摘录 / 正文 /
主题 / 夹链接），刻意不做过滤语法（本地工具的规模感不需要 `tag:` `@label` 那一套）。
`--kind text|link|file`、`--limit N` 与 `--deep`（连文档的提取正文一起搜——那是读盘，
只在你明确要时付）。`--topic` 改成枚举，值取自 service 导出的 `TOPICS`；主题词表随
list 响应一起下发，前端不再复制一份清单（复制就会与 `classifyTopic` 分叉）。
面板上是一个搜索框 + 现成的 `<Highlight>` 标黄，命中数即时更新。

**改**：`needdo edit <id> [--title] [--topic] [--body]`。三条纪律：**改一条不等于重新收一条**
（`id`/`status`/`addedAt` 都不动，只写 `editedAt`——它必须进 store 白名单，否则编辑痕迹
会被归一化静默抹掉）；**正文或标题一变，旧 AI 建议就作废**并归回 `ai.status='pending'`
（brief 默认会重新捞回来），而不是留一个 `rev` 对不上的 `suggested`；**`--topic` 是人显式定的**，
记 `topicSource: 'user'`——这个值在 store 白名单里躺了两轮却没有产出者，SKILL.md 却已经
当既成事实写着，现在补上产出与保护。链接条目改正文会做 http(s) 校验，且只在标题仍是
「从旧 URL 推出来的」时才跟着更新（人写过的标题不许被地址变更带走）。

**撤**：删除改成**软删除**——条目落 `needdo.trash[]`，原件 `rename` 进 `needdo/trash/`；
`needdo trash [--ids --restore] [--empty]` 一条 action 三个方向（照 `archive --undo` 的形状）。
回收站在写入路径上自动淘汰：超 30 天或超 200 条，按删除时间从旧到新丢（不需要清理任务）。
理由很直接：收件箱里随手丢进来的东西**常常没有第二份**（一段粘贴的文字、别人发来的 PDF），
当场抹掉的代价远超留住它们的成本。面板的「删除」跟着改口径，并多了「回收站 N」入口与恢复/清空。

**两处协议越权修复**（都先写成单测钉住）：

- `review` 不看 `rev`：建议生成后条目被人改过，仍能接受那条**针对旧内容**的建议。
  现在会归入 `stale` 拒绝（提示重新 brief），不再静默应用到已经变了的正文上。
- `process` 与 `review` 无条件覆盖 `topic`：人用 `edit --topic` 定的主题会被规则表或
  被接受的 AI 建议顶掉。现在 `topicSource === 'user'` 的条目，规则不覆盖、接受建议也只
  改状态不动主题（并在结果里单列 `protected`，不冒充「已应用」）。

**顺带**：`apply` 的幂等判据从「只看 `suggested`」放宽到「整个 batchId 的痕迹」——
重放一份旧计划会把已接受/已拒绝的建议打回待复核，那是覆盖人的决定；要重开一轮必须换新批次。
`removeFiles` 加了显式目录参数（回收站里的条目，文件在 `trash/` 下，按默认目录找会
「以为删了其实还在」，`force: true` 连报错都没有）。`src/index.js` 导出 needdo service，
并把「库入口漏导出」这条 README 里标着「❗无断言」的清单项补成 `consistency.test.mjs` 的断言。

**测试**：needdo 单测 25 条（新增 edit 身份不变/链接与文件的边界、主题保护、建议过期、
检索与 `--deep` 边界、回收站三方向与淘汰规则）+ smoke 的软删除与恢复全链路。

### Added — `needdo` 收件箱：混乱输入 → 主题整理（含 agent 交接协议）

**是什么**：随手丢进来的杂乱文字 / 公告 / 网址 / PDF·DOCX 文档收进一个收件箱
（第 4 个 tab「NeedDo」），落盘到数据目录，按确定性规则归类并写 markdown 报告；
需要 AI 参与时走**建议**而不是自动改主视图。

**捕获期零 AI、零分类负担**。一条 `needdo add` 吃四种输入：位置参数收文字、`--link` 收网址、
`--file <路径>` 收本地文档（CLI）/ `--data`+`--name` 走面板上传（base64 过境 JSON API，
HTTP 层因此不用引 multipart）。整行是 URL 才当链接（判据在 `classify.js`，纯函数 + 单测——
旧写法先删空白再判，`https://a.com 看一下` 会被整条误存成链接）；混排文字里夹的 URL
**抽进 `links[]` 附挂**，原文一字不动（与 `links[]` 的 round2 惯例同形）。

**文档解析零依赖**（`extract.js`）：DOCX = 自实现 zip 中央目录读取 + `zlib.inflateRaw` +
剥 XML 标签；PDF = 扫 `stream…endstream`、能 inflate 的 inflate，再从内容流里抓
`(…)Tj` / `[…]TJ` 字面量。**尽力而为**：加密 / 扫描件 / CID 字体提取不出就返回 null，
原件照常落盘、条目照常入库——收件箱的第一承诺是「收进来」，文本化是加分项。
原件与提取文本落 `<数据目录>/needdo/<id>.<ext>` 与 `<id>.txt`，元数据进 `needdo.items[]`。

**整理是确定性的**：`process` 走有序规则表（待办 → 公告 → 文档 → 链接 → 杂项，**可执行的
优先于可读的**：带「截止」的公告对收件箱主人来说是待办），写报告、条目归档（`inbox → done`
二态，可逆）。规则产出的 `topic` 记 `topicSource: 'rule'`。

**AI 只写附注，不覆盖确定性字段**（三条硬规则，先例分别来自 crawl 的 `--enhance-level`、
kb 的 `origin`、round2 的 `links[]`）：

- `process --enhance-level 0-3`：级别显式，默认 0 = 纯规则（离线、CI、可复现）；
  非 0-3 直接报错不静默回落。≥1 时同时把条目排进 AI 队列（`ai.status='pending'`）
- `needdo brief [--ids] [--level] [--redo]`：**一次拿全**的自足 JSON（全文含文件提取文本、
  夹链接、规则预判主题 `ruleTopic`、8 位内容指纹 `rev`、该级别要做的 `task`）。
  默认只导出还没被 AI 处理过的（不重复喂、不重复花钱），`--redo` 才含已有的
- `needdo apply --plan <计划.json>`：**只追加 `ai` 段**，`content/title/topic/status`
  一个都不动；幂等键 `(batchId, id, rev)`，重放 = no-op（含已接受/已拒绝的条目——
  重放不许覆盖人的决定）；内容变过的归 `stale` 跳过并回报，全无有效结果才报错
- `needdo review --ids a,b [--reject]`：**接受才生效**——写 `topic` 并记 `topicSource: 'ai'`；
  拒绝只清状态。面板与 CLI 同源（行内徽标、详情里的 AI 附注块、多选批量复核）

「建议而非静默应用」是调研里最硬的一条产品证据：Notion AI Autofill 明确非实时触发、
Readwise 只自动处理手动保存的、Linear triage 由 goalie 拍板——**越靠近改动主视图结构的
动作，越晚介入、越要人拍板**；静默应用只留在「垃圾桶类 + 可逆 + 误判代价低」的场景。

**顺带修的两处 `Number(null) === 0` 陷阱**：`size`（「没记录体积」曾被归一化成 0 字节）
与 `ai.confidence`（「没给置信度」在面板上显示成「置信 0」，看起来像 AI 很不确定）。
`brief` 的 `rev` 把 `topic` 也算进指纹——别人刚接受过另一份建议同样算「动过」。

**测试**：`tests/unit/needdo.test.mjs`（18 条：四通道入库、docx/pdf fixture 提取、批量不误删、
协议三步闭环与幂等/stale/拒绝路径、looksLikeLink）+ smoke 两条 CLI 全链路。

### Added — 抓取产物与源库重叠时，默认只留一份参与检索（F8）

**问题**：`crawl run` 会把产物目录自动登记为知识库，而**本地目录源**（典型是 Obsidian vault）
的源目录本身往往也是登记库——于是同一批笔记在列表里出现两份。nx-kn 是「逐库召回再按融合分合并」、
**没有跨库去重**这一步，两边都会命中，同一篇笔记给两条结果、各占一个 `--limit` 名额。

**为什么不用内容相似度去重**：两份内容**并不相同**。skill-seekers 的产物是重排过的版本
（`SKILL.md` + `references/`，不是源库的镜像），头部被加了 `source:` / `engine:` / `fetchedAt:`，
路径也对不上。只剩标题可猜，而猜错（把两篇真不同的笔记当成同一篇吞掉一条命中）比不去重更糟。

**判据改成确定性的谱系**：产物目录 = `sourceDirOf(源名)`，源目录 = 源的 `url`（本地目录源）
——两条都是我们自己写下的值，不需要猜。落在两处：

- **预防层**：`crawl run` 自动登记时写入 `origin: 'crawl'`；已存在但没记过的记录补记，
  但**绝不**改动 `origin: 'user'`（用户显式要的，降级它等于篡改用户意图）。
- **解析层**：`core/store.js` 新增 `crawlProductVaults()` / `standbyVaults()`；
  `kb/service.js` 的 `resolveVaults()` 把结果拆成 `vaults`（参与）与 `standby`（未参与，
  带原因是哪个源库）。`index` / `query` / `status` / `watch` 是它的全部调用方，
  一处生效四处。

**只收「确实重复」的那一类**，这是规则唯一的安全边界：web 源（url 是网址、没有对应的本地库）
与「源目录从未登记」的本地源都**不**抑制——产物是唯一副本，收起来等于内容凭空消失。

**启用方式复用已有命令**：`kb add <产物路径>` 把记录提成 `'user'`，它就不再被排除。
不单开 `kb standby` / `kb enable`——同一件事两个入口，迟早只改一边。面板对应「启用检索」按钮
（走的就是 `/api/kb/add`）。临时只想搜产物库也可以 `--root <产物路径>`，那是显式指定、
不参与抑制判定。

**绝不静默**：`kb list` 标 `【未参与检索】` 并给出原因与启用命令；`kb status` 单列
`另有 N 个未参与检索`，`totals` 的 `vaults / indexed / stale / notes` 只算参与检索的库
（顶部那句「共 N 篇可索引 md」摆的是虚高数字就失去意义了）；`query` 把它印成独立的
`未参与 [名] …` 行，与「出错跳过」分开——混在一行会让人去排查一个并不存在的故障；
`pipeline` 的索引步骤跳过时说清是「没有知识库」还是「都判为重复」。

**迁移是零成本的**：老 store 没有 `origin` 字段，由谱系推导兜底，不需要迁移命令，
也不改磁盘上任何文件。用户本机的两份重叠（`D:\Obsidian Vault` 与其产物
`~/.nx-kn/sources/obsidian-vault`）在改动后即刻变为「只留源库」。

### Fixed — 全流程审查发现的 9 条问题（F1–F7、F9、F10）

审查方式与逐条证据见 `docs/review/2026-10-08-full-flow-audit.md`（读全部核心代码 + 真跑命令 + 真跑测试）。

- **错误码契约被绕过（F2）**。`toErrorPayload` 只对 `instanceof NxError` 读 `code`，而 5 处写成
  「`new Error(...)` 之后手动赋 `err.code`」——赋了也不生效，一律归成 `INTERNAL`。
  实测 `settings set badformat` 与 `skill get nosuchref` 的 `code` 都是 `INTERNAL`，
  **HTTP 侧因此返回 500 而不是 400**。5 处改用 `badInput()` / `notFound()`；
  新增 `tests/unit/errors.test.mjs`，其中一条专门断言「手赋的 code 传不出去」——
  把这个陷阱钉成回归闸门，而不是只留在注释里。
- **面板「CLI 等价提示」静默消失（F1）**。`CliHints` 只认 `module` prop，而 4 处调用传的是
  `command`：未声明的 prop → `moduleId === undefined` → filter 恒空 → `return null`。
  提示整块不渲染，控制台零告警。组件新增单命令形态，且**按 action id 查命令表**
  （不是传命令字符串）——命令改名后提示会跟着变，不会再过期；id 查不到时 `console.warn`。
- **`watch --off` 不存在（F3）**。实测报「未知参数 --off」exit 1，而 summary 与 3 处注释都宣称
  `--on/--off` 可用。现在 `--off` 已声明并给出明确语义——CLI 侧没有可关的常驻守护
  （它活在 `serve` 进程里），要关 serve 内守护走面板开关或 `POST /api/kb/watch {"on":false}`；
  命令立刻返回、不再挂住终端。`--on` 改走前台路径，因此**会打印启动信息**（原先静默常驻）。
- **`pipeline` 文案与行为不一致（F4）**。`--name` / 位置参数只缩**抓取**范围，索引步骤固定对
  全部库跑增量。summary 与 `--name` 的提示都照实改写，不再让人以为索引也被缩了范围。
- **模板残留与断裂的文档引用（F5）**。用户可见的 `nx-kn help` 首屏 `如 nx-nx help repo`
  （还缺右括号）改成 `如 nx-kn help kb`；`spec.js` 指向不存在的
  `assets/repo-hub/references/agent-workflow.md`，改为本仓实际记录该契约的
  `assets/nx-kn/SKILL.md`；`api.js` / `cli.js` / `errors/index.js` 里的
  `repos` / `git` / `gh` 注释示例换成真实路由与外部命令。另外 `help` / `serve` 的标题行
  不再把名字打两遍（`APP_TITLE` 在本仓与 `APP_NAME` 同值，`appHead()` 判重）。
  `references/00-design.md` 里两处与代码矛盾的说法（`AppError`、「否定式 glob」）也一并订正。
- **`store.json` 解析失败被静默覆盖（F6）**。改造前「文件不存在」与「JSON 坏了」共用一个
  catch 分支、都返回空结构；下一次任意写操作（`kb add` / `index` / `settings set`）就会把那份
  空结构原子写回原路径——**原内容不可恢复，全程零报错**（本机真实发生过，靠人工备份救回）。
  现在只有 `ENOENT` 算「首次运行」；解析失败先把原文件改名成
  `store.json.corrupt-<时间戳>` 再继续，并打一条 stderr 警告。`nx-kn health` 也会报出来
  ——顺带让它**真的读一次 store**，此前它号称「存储可读」却没读过。
- **采集增量的两个盲点（F7）**。① 远端已删的页面留盘，继续被索引、继续被检索到；
  ② 换引擎后旧引擎的产物不会被任何一次抓取覆盖，两套文件并存（同一内容两条命中，
  白占 `--limit` 名额）。新增陈旧产物清理：只在本次确有产出时，清掉**上一次 manifest
  记录过、本次不再产出**的 `.md`，并收掉随之为空的目录。手工放进 `sources/<名>/` 的文件
  不在名单里、永不受影响；清理数与文件名会在 CLI 与面板如实报出。
- **`hasIndex` 判据太松（F9）**。原先只看 `.zvec-grep` 目录在不在，于是一个「建到一半失败」
  留下的空壳目录会被当成可用索引：`query` 失败 → 该库进 `skipped[]` → `hits` 为空 →
  主结论渲染成「（无命中）」。用户读到的意思是「库里没这内容」，而真相是「索引坏了」。
  现在要求 `manifest.json` 存在且非空 + `files.zvec/` 在（本机 zg 0.2.2 实测的目录形状）。
- **抓取引擎的上手前提（F10）**。README 写明：`skill-seekers` 不在 `PATH` 时会回退
  `uvx --from skill-seekers`，而 uvx **首次要在线拉一整套依赖**（本机实测二十分钟仍未装完、
  期间无任何输出，看起来就像卡死），并列出三条出路（`pip install` / 用
  `NX_KN_SKILL_SEEKERS_CMD` 指向已有安装 / `--engine node`）。

### Tests — 审查修复的配套断言

- 新增 `tests/unit/errors.test.mjs`（错误码契约 + 手赋 `code` 的陷阱 + HTTP/退出码映射）、
  `tests/unit/zg-index.test.mjs`（`hasIndex` 的 7 种目录形状）；`kb-store.test.mjs` 补 4 条
  存储损坏用例（备份生成、写入不毁原内容、首次运行不产备份、空白文件也隔离）。
- 流水线新增 **P11b**：远端删页与换引擎两条清理路径，并断言「手工放进源目录的文件不动」
  与「清理是一次性的」。假引擎不联网。
- 新增 `tests/unit/vault-lineage.test.mjs`（11 条）：谱系判定的每条安全边界——
  web 源不误判、源目录未登记时不抑制（否则内容凭空消失）、`origin: 'user'` 永不被自动排除、
  `--root` 逃生舱、`kb add` 一次即启用。两种判错方向都是**静默**的，所以逐条钉住。
- 单元测试 **100 → 119 → 130**。

### Changed — 面板头部收成一行；未加载态改用转圈

- **头部一行**：品牌（logo + 名称 + 副标题）、tab 导航、版本号同排。原先「身份一行 +
  导航一行」要多占约 35px，而 tab 只有三个、版本号也短，横向空间完全够。合并后整块
  sticky（原来只有导航条 sticky）：吸顶的代价从两行降到一行，而 tab 是高频操作，
  值得常驻。窄屏（≤720px）先收起副标题，仍放不下时靠 flex-wrap 换行。
- **加载态转圈**：知识库、资料采集、首页流水线总览、视图懒加载的 fallback 原来都拿
  `…` 顶着——那是把「还不知道」渲染成「就是没有」（知识库状态要逐库起 `zg status`，
  秒级，冷启动必然可见）。新增 `<Spinner>`（`components/ui.jsx`，样式在 style.css 的
  base 层）：纸面灰环，不抢注意力；`prefers-reduced-motion` 下降级为透明度呼吸
  （只关动画会剩一个静止的缺口圆环，看起来像坏掉的图标）。

### Added — 检索结果里的关键词标黄

- 知识库检索的命中**片段与标题**里，问句中的词只要在正文里字面出现，该处就标黄——
  一眼看清「这段为什么被召回」。结果计数行注明「黄底 = 字面命中」：语义（vector）
  召回本就可能一个字都不重合，那种片段没有黄块是对的，不是高亮坏了。
- 切词在面板侧完成（`src/web/frontend/highlight.js`）：英文/数字整词，中文按 **2-gram**。
  **不用 zg 自带的高亮**有两个硬理由：它只在 TTY / `--color=always` 下生效、输出的是
  ANSI 转义（我们经管道 spawn，拿到的是纯文本）；且它的中文分词是「整句当一个 term」，
  中文问句会被整串匹配，一个字都标不出来。
- 相邻 bigram 的重叠区间会合并成整词块（原文里真有「登录超时」时是一整段，不是三段）；
  停用词（「什么」「怎么」「how」「the」…）不标——它们遍地都是，标了反而淹掉真命中。
- 测试：`tests/unit/highlight.test.mjs`（中文 2-gram 切分、停用词过滤、区间合并、
  大小写不敏感、查询含正则元字符时按字面处理、空值安全）。

### Changed — 面板信息架构：资料采集并入知识库 tab（4 → 3 个 tab）

- 「资料采集」不再单独占一个 tab，整块嵌入「知识库」tab 顶部——采集是知识库的
  **上游阶段**而不是并列功能，抓取 → 索引 → 检索是一条流水线，放进同一个 tab
  才能看见前后关系。tab 栏变为：首页 / 知识库 / 设置。
- 采集动作（本地目录一步整理、抓取更新、一键流水线）完成后**自动刷新**同页的
  知识库列表——刚抓完的源已自动登记为知识库，立刻可见，不用手动刷新页面。
- CLI 与 HTTP 不变：`crawl` 域的命令与路由原样保留（`nx-kn crawl …`、
  `/api/crawl/*`），只调整了面板的信息架构；首页总览的跳转同步改为知识库页。

### Added — 一键流水线 `pipeline`：抓取 → 索引一条命令串完（首页按钮同链）

- 新增 `nx-kn pipeline`（`POST /api/pipeline/run`）：**抓取采集源 → 更新索引**两步在
  服务端串联执行——两步是前后关系不是选择关系，产物落盘后必须进索引才能被检索。
- 每步独立容错：抓取失败不阻断索引（上一次的产物还在，索引照样有价值）；没有源/库的
  步骤自动跳过。`--rebuild` 可全量重抓 + 全量重建（默认都走增量）。
- `pipeline` 接受可选目标（本地目录 / 文档站 URL / 已有源名）：**提供目录就直接抓取该目录**——
  未登记自动登记，已登记复用现源，重复提供同目录 = 增量重跑。面板「添加采集源」填本地
  目录后同样一步跑完（整理 + 索引，跑完即可检索）。
- 面板首页新增**流水线总览**卡片：① 抓取（源列表 · 页数 · 上次抓取）→ ② 索引
  （库列表 · 覆盖率 · 片段数）→ 一键跑流水线按钮，跑完 toast 汇总并刷新；
  各阶段可跳转「知识库」tab（采集管理在知识库页内）。
- 测试：流水线新增 P17（pipeline 串联全链路：登记源 → 抓取 → 自动登记 → 索引 →
  结束即可检索 → 幂等重跑全未变，假引擎不联网）。

### Added — `crawl` 支持本地目录源（把 Obsidian vault 整理入库）

- `crawl add` 的位置参数**既认 http(s) 地址，也认本地目录**：磁盘上存在的目录即登记为
  本地源（`kind: local`），语义是「整理」而非「抓取」——典型用法是把一个 Obsidian vault
  交给 skill-seekers 整理成结构化 markdown，再当作知识库检索。判定与 URL 天然二分，不撞车。
- **本地目录源只支持 `skill-seekers` 引擎**（用户决策）：内置引擎只抓 HTTP 页面，
  整理不了本地文件。`--engine node` 在 `crawl add` 与 `crawl run` 两处都会被**响亮拒绝**。
- **原始目录只读**：整理产物落在 `sources/<名>/`（自动登记为知识库），调用 skill-seekers
  时限定 `--file-patterns *.md`，frontmatter 的 `source` 指向原始目录路径。
- `--name` 省略时本地源取路径最后一段（`D:\Obsidian Vault` → `Obsidian-Vault`，中文合法）。
- store 记录与 `.nx-kn-crawl.json` 新增 `kind` 字段（老数据自动补 `web`，无迁移脚本）。
- 面板「资料采集」对话框与源列表支持本地目录（提示文案与「本地目录」标签）。
- 测试：`kind` 归一化单测；流水线新增 P16（本地源全链路：登记 → 假引擎整理 → 落盘 →
  自动登记 → frontmatter/原始目录只读断言）与 P16b（`--engine node` 双闸拒绝）。

## [0.3.0] - 2026-10-04

### Changed — 采集默认引擎改为外部 `skill-seekers`，纯 Node 实现保留为内置引擎

- `crawl` 域引入**双引擎**（用户决策）：
  - **默认引擎 = `skill-seekers`**（外部 Python 进程，[Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)）。
    调用经 `spawn(bin, argsArray)`、**不经 shell**——URL 天然带 `%`（`%20` 等），任何
    shell 垫片都会二次解释参数，数组直达则无此问题。候选链：环境变量
    `NX_KN_SKILL_SEEKERS_CMD`（唯一、不回退）→ PATH 上的 `skill-seekers` →
    `uvx --from skill-seekers skill-seekers`（免安装，首次联网拉约 50 MB）。
  - **内置纯 Node 引擎保留**为 `--engine node`（原 0.2.0 的实现原样可用）——
    npm 包依旧零强制依赖，没有 Python 的机器开箱可用。
  - **失败不静默回落**：默认引擎起不来就报错并给两条出路（装它 / `--engine node`）。
    进程真的跑起来后的非 0 退出是业务失败，换候选重跑无意义。
  - `crawl add --enhance-level 0-3`（默认 0 = 纯抓取不调 LLM）与 `--agent`
    透传给 skill-seekers；`--match` 在两个引擎的落盘文件名空间上语义一致。
  - skill-seekers 在系统临时 scratch 目录里跑，只把 `.md` 摘进 `sources/<名>/`
    （SQLite 索引、缓存等中间产物不进知识库）；增量仍按正文内容哈希，与内置引擎同一套清单。
  - 面板「资料采集」添加源对话框支持引擎与增强级别选择。

### Fixed

- **子进程驱动在 Windows 上会让宿主进程白挂到超时**：曾用 `spawn` 的 `timeout` 选项，
  实测（Node 22 / Windows）ENOENT 路径上该选项把事件循环钉住到超时才放——
  error 已触发、结果已返回，进程却多活 `timeoutMs`（默认 30 分钟）。改为**自己管超时**
  （unref 定时器 + 击杀 + 各 settle 路径 clearTimeout），并新增「超时击杀（code 124）」
  回归测试钉住。

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
