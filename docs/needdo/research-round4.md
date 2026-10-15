# NeedDo UIUX 调研 · 第四轮（规模化：找 / 改 / 撤）

日期：2026-10-15。三问：条目多起来怎么定位（找）／收错了怎么改（改）／删错了怎么救（撤）。r1 捕获与归档二态、r2 详情 Modal/多选/链接、r3 AI 三步协议已覆盖，本文不重复。
对齐基线：本仓已有 `web/frontend/highlight.js` + `<Highlight>`（中文 2-gram 切词，有单测）、`store.jsx` 的「刷新后不该丢的用户选择必须持久化」硬标准、「一条 action 派生 CLI+HTTP」同源纪律。

## 一、找

### 现状速记
- 视图：三个状态按钮（收件箱/已归档/全部）+ 纯客户端 `st.items.filter`；`filter` 是裸 `useState`，**没走 store.jsx 的持久化通道**，刷新即回默认。`list` 一次下发全部条目（无 `limit`、无 `q`、无 `kind`），排序恒为 `addedAt` 倒序。
- CLI：`needdo list --status inbox|done --topic T`，`--topic` 是自由字符串（无 enum）；`nx-kn needdo list 会议` 今天报「多余的参数」（`cli.js` 的 mapPositionals 对未声明位置参数直接 badInput）。
- 已有却没被用上的资产：`splitHighlight()` + ui.jsx 的 `<Highlight>`；`--hl-bg` 黄是 tokens 里唯一强调色，注释写明留给「检索命中」；`.opt-row`（`> input { flex:1 }`）是 base 层共享类，kb 的检索框就是它。
- 结构性事实：store 里每条只有「元数据 + 200 字摘录」，而 file 条目的摘录就是提取文本的前 200 字——**摘录本身就是现成的索引**。

### 产品速记
- **Things 3 Quick Find**：任意处直接打字或 ⌘F，**默认只搜名称**（to-do/project/area/tag），popover 底部「Continue Search」才扩到 notes/checklists/Logbook；另有独立的 Find in Text。→ 便宜的先搜，扩大范围是显式动作。
- **Gmail**：一个框三层——操作符 → 搜索框右侧滑杆「Show search options」结构化表单（生成**同一个 query**）→「Create filter」钉成服务端保存规则；结果行内高亮命中词。
- **Todoist**：**搜索与 filter 是两个东西**——主搜索是纯全文（`search:Meeting`），filter 是带语法的**具名保存视图**（`|`/`&`/`!`/`()`、`%label`、`#Project`/`##Project`、`p1`、`date before:`）。语法存在的理由是字段无法穷举 + 要保存复用。
- **Obsidian**：纯命令式（`path:` `tag:` `content:` `section:` `task:` + `/正则/`），可用性靠「Explain search term」把语法翻回人话补偿；空搜索列出**最近搜索词**；查询串可编码进 `obsidian://search?...&query=`（状态进 URI）。
- **flomo / Bear / Apple Notes**：flomo 的标签就在正文里（`#a/b`），点父标签汇总子孙，官方哲学是「先用一级，让层级随笔记量自然生长」；Bear 与 Notes 的侧栏标签树做的是**过滤**（不是搜索），Notes 点多个标签 = 取交集，另有 Smart Folder。
- 成熟解法是**分层/分离**而非三选一：Gmail 一框三层、Todoist 搜索与 filter 分立、Obsidian 用「解释器」补偿语法、Linear/Notion 用 chips 组合 + 保存视图。

### 结论
1. **面板侧不造语法**。Gmail 需要操作符是因为它的字段（from/label/filename/has/is…）无法穷举，Obsidian 需要是因为它没有筛选 UI。NeedDo 的可枚举维度一共三个（status 2 / topic 5 / kind 3）——**能加按钮的地方不该加解析器**。命令式语法在 CLI 侧本来就已经是 flag：两侧各有自然形态，别互相搬运。全文搜索是**正交的第四维**，一个框即可。
2. **不建索引**：store 每次请求都已在内存（`loadStore` + 进程内缓存 + mtime 失效），扫几千条 = 几百 KB 子串匹配，毫秒级。唯一贵的是 file 条目的**提取文本全文**（在磁盘上，每条一次 read）——照 Things 的 Continue Search，把它做成显式的第二档，而不是默认就扫。
3. 过滤状态进 **localStorage**（`patchUi`），**不进 URL**：App.jsx 的 hash 只承载 view（`viewFromHash()` 把整串当 view id），要放 query 得改共享壳，而那段 hash 双向同步代码上正挂着一条两轮未复现的瞬时 `#/home` 跳转（progress.md 遗留问题 4）。「可分享」在单人本地面板里没有消费者，收益只剩「可复制 URL」，不值这个风险。

## 二、改

### 现状速记
- `service.js` **没有任何改条目的入口**：`content` 只在 add 时写一次；`title` 是捕获时从首行/文件名/URL 派生（60 字截断）；`excerpt`/`links` 同为派生。收错了只能删了重收（progress.md 遗留问题 2 原文）。
- `topicSource` 的三态 `'rule'|'ai'|'user'` 里 **`'user'` 至今无人写入**（`store.js:353` 与 `SKILL.md` 第 256 行都写明了它，却没有代码路径产出它）——SKILL.md 已经把它当既成事实对外宣传，这是文档跑在实现前面的欠账。
- **两处会覆盖人的决定**（有了 user 主题后立刻违规）：`process` 对 inbox 条目无条件 `it.topic = classifyTopic(it); it.topicSource='rule'`；`review` 接受建议时无条件 `item.topic = item.ai.topic`。两者都违反 r3 自己立的「人显式定的永不被规则/AI 覆盖」。
- `revOf` = `sha256(kind|title|content|file|ext|topic)` 前 8 位，正文/标题/主题任一变化都让已落盘的 `ai.rev` 对不上（`apply` 会把它计入 `stale` 跳过）。**但 `review` 完全不校验 rev**：只看 `ai.status==='suggested'`——改过正文的条目仍能接受基于旧版内容的建议，这是现成的一条 bug。
- `normalizeNeeddoItem` 是**白名单**（store.js:339 起的 return 字面量）：新字段不写进去，下一次写入就被静默抹掉。

### 产品速记
- **Apple Notes 没有独立标题字段：首行即标题**（标题是正文的投影）；设置里「按创建或编辑的时间」分组，即 created/edited 是两个可切换维度。Taskwarrior 同调：`entry`（创建）与 `modified`（修改）分列，注释走 `annotation_<timestamp>` 逐条追加。
- **Gmail**：没有「改已发邮件」，只有 Undo Send；**移除标签不等于删邮件**——「改归类」与「删数据」解耦；个人 Gmail 也不记录谁改了哪个标签（审计只在 Workspace 管理侧）。
- **就地 vs 详情**：Todoist 两条路都给（`Enter` 开 task view，`⌘/Ctrl+E` **行内就地编辑**）；Linear 全键盘单键改当前行。短字段就地、长内容展开是共识。
- **留痕粒度**：Linear 的 Activity feed 记「哪个字段、谁、何时」且同类事件折叠；Notion 版本历史给 diff + 归属 + 回滚；Obsidian File recovery 存**整文件快照**（最短 5 分钟间隔、留 7 天）。Notion 官方把「谁改的」列成 agent 参与后的刚需。
- **手动覆盖优先**的现成先例：Jellyfin 手动改过的字段可 **lock**，之后刷新元数据不再覆盖；Zotero 标签分「自动/手动」，可一键清除全部 automatic tags 而保留手动的。
- **派生产物过期是一等状态**：GitHub Copilot Memory 的引用在使用前用当前分支校验，失效即视为过期；Linear 的 agent session 有明确的 `stale` 态。反例警示：Plex 里**改名会被当成新条目**、此前自定义元数据不迁移——别把用户的覆盖绑在易变的指纹上。

### 结论
1. 编辑**不动身份**：`status`、`addedAt` 都不许变（view.jsx 自己的注释写着 addedAt 的含义就是「什么时候丢进来的」），另立 `editedAt`（Notes 的 created/edited、Taskwarrior 的 entry/modified；与 Gmail 的 receivedTime vs dateHeader 同理：收到时刻与内容声明的时刻是两件事）。「编辑后仍留在收件箱」= 什么都不用做，因为它本来就不靠编辑流转。
2. `topicSource:'user'` 必须落地并且**锁得住**（Jellyfin lock / Zotero manual tags）：`process` 与 `review` 都要跳过人定的主题。
3. 正文改动 → 过期建议退回 `pending`。**零新枚举值**：`normalizeNeeddoAi` 的四态不动，`brief` 的默认过滤 `!x.ai || status==='pending'` 会自然把它重新捞回队列；同时把「review 不校验 rev」那条一起堵掉。
4. 留痕**只留 `editedAt`（+ 可选 `editedBy`），不建 history 数组**：单人本地库「谁改的」恒等于「我」；store.json 是条目清单不是审计日志（与 crawl 把「几百页 url→hash 映射」放在源目录而不塞进 store 是同一条纪律）。「这条改过」只值一个 `.tag`，与既有的「主题来自 AI」徽标同款。
5. 面板只改**短字段**（标题 + 主题下拉），正文修改留在 CLI：`useDialog` 的 `fields` 只渲染 input/select（没有 textarea），而主题正好是「真枚举一律用下拉」的适用面——刚好落在现成组件的能力边界内，不必为它改共享 ui.jsx。

## 三、撤

### 现状速记
- 归档已是可逆安全网（`archive --undo`、行内与批量的「还原」）。**缺口只在删除**：`remove` 从 `store.needdo.items` 里 splice 掉，再 `fsp.rm({force:true})` 掉原件与提取文本，不可恢复。
- 安全网只有一道**轻量 yes/no 确认框**（文案诚实：「删除不可恢复」），批量删除同样只有确认框。
- 旁证一：`core/store.js` 对损坏的 store 走的是 `rename` 成 `.corrupt-<stamp>` **留档**而不是删——「坏了也别毁掉」在本仓已有先例。
- 旁证二：`removeFiles` 自己的注释写着「清不掉就留着（孤儿文件无害，health 类命令可以后续清扫）」——回收站化的心理预算早就有了。
- 整理报告（`processed/*.md`）永不自动删，且含标题/摘录/内含链接/原件路径——**已整理过的条目在报告里留了半份残影**；但从未整理过的收件箱条目删掉就是彻底消失。

### 产品速记
- **窗口差一个量级**：Gmail Undo Send 是 5/10/20/30 秒（默认 5 秒，实现是人为延迟投递而非远程撤回），归档/标签的 undo 通知条同样约 5 秒；Slack 撤回 15 秒；Todoist 的 Undo 弹窗「只存在几秒」；Linear 的 ⌘Z 支持批量。语义统一是「**toast 消失 = 动作提交**」。
- **软删除普遍是 30 天**：Gmail Trash 30 天（另有 Empty Trash now 一键）、Notion Trash 30 天（且**没有**清空整个垃圾桶的按钮，只能逐页删）、Apple 照片「最近删除」30 天、提醒事项 30 天。Obsidian 更干脆：系统回收站 / 仓库内 `.trash` / 永久删除三选一。
- **CLI 侧等价物**：freedesktop Trash 规范把文件移到 `$XDG_DATA_HOME/Trash`（`files/` + `info/*.trashinfo` 记原路径与删除时间）；`trash-cli` 的命令面就是 `trash-put / trash-list / trash-restore / trash-empty`。git 的兜底是 reflog（90 天）与 dangling objects。
- **确认框 vs 撤销**：NN/g 明确「更好的设计是给用户**撤销**这次破坏性动作的机会」，并警告日常化的确认框会被无脑点过；Nielsen 启发式 #3 就是「支持撤销」；Cooper 的处方是「把文件移到一个 suspense 目录放一个月再物理删除」；WCAG G168 只在「确实无法撤销」时才要求确认。→ **最糟组合恰恰是「轻量确认 + 硬删除」**，即现状。

### 结论
1. 把 `remove` 的语义从「删」改成「移入回收站」：条目记录移出 `needdo.items`（**不引入第三种 `status`**——那会渗进 `process`/`archive`/`list`/报告的每一个判断），落 `needdo.trash[]`；原件与提取文本 `rename` 到 `needdo/trash/` 而非 `rm`（与 `core/store.js` 的 quarantine 同款，同目录内 rename 无跨设备问题）。
2. 恢复路径必须是**命令**而不是 toast：`useToast` 只吃字符串，要在 toast 里放「撤销」按钮就得改共享 ui.jsx（波及 kb/crawl）；更要紧的是**几秒窗口解决的不是同一个问题**——toast-undo 救「手滑点错」，而 NeedDo 的删除是批量 + 连原件，属于「想清楚了但后悔」，那是回收站（天级）而非 toast（秒级）的活。
3. 保留期 30 天 + 上限 200 条，两者都在**写入时淘汰**（无需定时器）；`--empty` 是唯一的真删入口（对齐 Gmail 的 Empty Trash now）。

## 【核心】五条可落地建议（复用现有类与 action 同源模式，零新依赖）

### 1. 找：单框全文 + 现有按钮 + flag，不造查询语言
- 落地：`needdo.list` 增 `args: [{ name:'q', required:false }]`（自由文本走位置参数、枚举走 flag——`add <text>` 与 `query <q>` 都是这个形状）与 `--kind text|link|file`、`--limit N`（照 `kb query` 的 `--limit 7`）、`--deep`（同时扫 file 条目的提取文本全文）；顺带把 `--topic` 从自由字符串改成 `enum`（值取自 service 导出的 `TOPICS`，usage 串因此自带文档）。service 侧在 `list()` 里对 `title/excerpt/content/links/topic` 做大小写不敏感子串扫，`limit` 在排序之后切片。
- 面板：条目卡 colhead 下加一行 `<form className="opt-row">` + `<input>`（**kb 检索框同款，零新 CSS**），过滤用 `useMemo` 即时生效（纯内存，不需要 debounce）；标题与摘录用 `<Highlight text query>` 渲染，`--hl-bg` 黄终于有了第二个消费者。空态分三档（照 `index.js` render 的既有措辞）：收件箱空 / 该视图无条目 / **没有匹配「会议」的条目（此视图共 N 条）**。
- 依据：Things Quick Find 的「默认只搜名称 + Continue Search 显式扩范围」= `--deep`；Gmail 一框三层 vs Todoist 搜索/filter 分立 → 我们两侧都不缺自然形态，只缺一个全文入口；flomo/Bear/Notes 的标签树在只有 5 个固定主题时是过度设计。

### 2. 找：`needdo list [q]` 是唯一的过滤出口，状态进 localStorage 不进 URL
- 落地：`patchUi({ needdo: { filter, q } })`（home/view.jsx 已是这个用法），`store.jsx` 的 `DEFAULT_UI` 加一行默认值；CLI 的 `list` 就是同一条能力的文本面（nx-kv 那条纪律：**过滤在 CLI 里做完，禁止拉全量再自己过滤**）。
- 依据：store.jsx 把「刷新后不该丢的选择必须持久化」写成硬标准，而 needdo 的 `filter` 现在是裸 `useState`；不进 URL 的理由见「一、结论 3」（hash 只承载 view + 那段代码上挂着未复现的跳转 bug + 单人无分享对象）。

### 3. 改：`needdo edit <id> [--title T] [--topic T] [--body T]`，并让 `topicSource:'user'` 真的锁得住
- 落地：新 action `needdo.edit`（POST `/api/needdo/edit`），同一条 `mutateStore` 事务内改字段；`--topic` 写 `topicSource:'user'`（枚举里早就有的值，终于有产出者）；`--body` 用现成的 `excerptOf()`/`extractLinks()` 重算派生字段；`normalizeNeeddoItem` 白名单补 `editedAt`（+ `editedBy`）——**不补就每次写入被静默抹掉**。同时修两处越权：`process` 对 `topicSource==='user'` 的条目只归档、不改主题；`review` 对这类条目跳过并在返回值里加一档 `userTopic:[]`（对齐既有的 `noSuggestion`/`missing`「部分失效不算失败但数字要说话」），render 补一行「跳过（主题是你自己定的）」。
- 面板：行内「查看」旁加 `.btn.small.ghost`「改」→ `dialog({ fields: [{key:'title',label:'标题'}, {key:'topic',label:'主题',options: TOPICS}] })`；空串 = 不改（沿用 r3「topic 缺失/null = 我不改」的约定）。正文修改只在 CLI：dialog 的 fields 没有 textarea。
- 依据：Jellyfin 的字段 lock / Zotero 的 automatic vs manual tags = 「手动覆盖优先」的现成语义；SKILL.md 已经把 `topicSource: user` 写进对外文档，落地它是还欠账。

### 4. 改：编辑不改身份，过期建议退回队列，留痕只留一个时间戳
- 落地：`edit` 不动 `status`/`addedAt`，只写 `editedAt`；`edit` 后若 `item.ai && item.ai.rev !== revOf(item)` → `item.ai.status = 'pending'`（零新枚举值，`brief` 的默认过滤自动重新捞回队列）；`review` 增加 rev 校验，对不上就计入 `stale` 跳过——顺手堵掉「改过正文仍能接受旧版建议」这条现成 bug。视图：`editedAt` 存在时在行内加一枚 `.tag`「已编辑」（与「主题来自 AI」同款）。
- 依据：Apple Notes 的 created/edited 双维度、Taskwarrior 的 `entry`/`modified`（编辑不移动、不改身份）；Copilot Memory 的引用校验与 Linear 的 `stale` 态（过期是可见状态，不是静默重写）；Plex 改名丢元数据的反例（别把人的覆盖绑在易变指纹上）；不做 history 数组的理由见「二、结论 4」。

### 5. 撤：`remove` 改「移入回收站」，新增 `needdo trash [--ids a,b] [--restore] [--empty]`
- 落地：`store.needdo.trash[]`（与 `items` 分列，条目**离开 items**，因此 `list`/`process`/`archive`/报告一行都不用改）+ `paths.js` 增 `needdoTrashDir()`（路径一律从 paths 取是本模块自己的纪律），原件 `rename` 进去；保留 30 天 / 上限 200 条，写入时淘汰，`--empty` 是唯一真删口。一条 action 两个方向（照 `archive --undo`）：`trash` 列、`--restore --ids a,b` 恢复、`--empty` 清空。视图改动只有两处文案：确认框从「删除不可恢复」改为「移入回收站（`nx-kn needdo trash --restore <id>` 可恢复，保留 30 天）」，删除后的 toast 带上恢复命令。**不做 toast 内撤销按钮**（理由见「三、结论 2」）。
- 依据：Gmail/Notion/照片一律 30 天软删（Gmail 另有 Empty Trash now）；freedesktop Trash 规范与 trash-cli 的 `restore`/`empty` 就是这个命令面；NN/g「更好的设计是给撤销的机会」+ Cooper「放进 suspense 目录再物理删」；本仓已有的 quarantine rename 与「孤儿文件无害，health 类命令可后续清扫」两处先例。

## 附：主要来源
- 找：culturedcode.com/things/support/articles/2803584 · .../2803569 · support.google.com/mail/answer/7190 · todoist.com/help/articles/introduction-to-filters-V98wIH · help.obsidian.md/plugins/search · help.obsidian.md/uri · help.flomo.app/basic/tags.md · help.flomoapp.com/community/user-story/classfication-and-tag.html · bear.app/faq/how-to-use-tags-in-bear/ · support.apple.com（Notes 标签 / Smart Folder）· linear.app/docs/custom-views · algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/highlighting-snippeting/js
- 改：support.apple.com（Notes 撰写/设置）· taskwarrior.org/docs/task · developers.google.cn/workspace/gmail/api（InternalDateSource）· todoist.com/help（task view / 键盘 / Reporting）· linear.app/docs/documents · linear.app/changelog/2025-04-03-collapsed-issue-history · notion.com/releases · obsidian.md/help/plugins/file-recovery · jellyfin.org/docs/general/server/metadata/nfo/ · zotero.org/blog/feature-spotlight-tagging/ · support.plex.tv/articles/multiple-editions/ · linear.app/developers/agent-best-practices
- 撤：support.google.com/mail/answer/2819488（撤销发送）· .../answer/7401（Trash 30 天）· notion.com/help/duplicate-delete-and-restore-content · support.apple.com/zh-cn/124460（最近删除）· obsidian.md/help/settings · manpages.debian.org（trash-cli / freedesktop 规范）· git-scm.com/book（reflog 与 dangling objects）· nngroup.com/articles/confirmation-dialog/ · nngroup.com/articles/ten-usability-heuristics/ · w3.org/WAI/WCAG21/Techniques/general/G168 · ant.design/docs/spec/stay/ · flylib.com/books（About Face「Do, don't ask」）
