# NeedDo 模块进度（rp-loop 10 轮迭代）

> 任务：nx-kn 新增 NeedDo 模块——混乱输入收件箱（文字/公告/链接/PDF/DOCX → 用户目录存储 → CLI/agent 按主题整理）。
> 本文件每轮更新：本轮完成 / 遗留问题 / 下轮建议。

## Round 1 · 2026-10-15

### 本轮完成

**调研**（docs/needdo/research-round1.md，5 条建议全部采纳落地）：
1. 单框多类型、Enter 即存——类型由系统识别（整行 URL → 链接），不让用户先选类型
2. 整个面板都是拖放区（深度计数稳住激活态），「选择文件」按钮兜底
3. 列表与 crawl 视图同构（.row/.tag/Copyable），零图标体系
4. 归档二态（inbox | done）而非删除，默认只看收件箱
5. 键盘链路全通：进 tab 即聚焦、焦点在外 Ctrl+V 直入输入框（文字与文件都支持）、Esc 清空、提交后焦点归位

**实现**（全部落地为代码）：
- 模块三件套：`src/modules/needdo/{index,service,view}.jsx?`（index.js 声明 6 条 action：add/list/show/archive/remove/process，CLI 与 HTTP 同源派生）
- 存储：store.json 增 `needdo.items`（`initialState` + `normalizeNeeddo` 逐条校验，老 store 自动补齐）；文件原件与提取文本落 `<数据目录>/needdo/`（`core/paths.js` 增 `needdoDir()`，跟 NX_KN_STORE 走）
- 文档解析零依赖：`extract.js`——DOCX（自实现 zip 中央目录读取 + zlib inflate + XML 剥离）、PDF（Flate 流 inflate + Tj/TJ 字面量抓取，尽力而为，失败保留原件不挡入库）；白名单 pdf/docx/txt/md，上限 3MB
- 主题整理：`process` 确定性分类（待办事项/公告通知/文档资料/链接收藏/杂项收集，可执行优先于可读的有序规则表），写整理报告到 `needdo/processed/`，条目归档；`--agent` 预留 AI 接入点
- 前端：新 tab「NeedDo」（order 15），needdo.css 策略文件入 pack.json；捕获便签（柔和底 + 内凹阴影）
- 注册：runtime/registry.js + frontend/registry.js + eslint.config.js 模块互依禁令（consistency 测试驱动补齐）

**验证**：`pnpm test` 154/154 全绿（含 7 条 needdo 单测：四通道入库、docx/pdf fixture 提取、分类归档、归档可逆、normalize 边界）；CLI 端到端冒烟通过（add×3 → list → process 分类归档 → 报告落盘）。

### 决策记录

- **PDF 提取走「尽力而为」而不是引库**：本仓依赖观是零依赖或声明外部引擎（crawl 双引擎先例）；加密/扫描件/CID 字体提取不出就保留原件——收件箱第一承诺是「收进来」。后续若需要高质量 PDF 文本，参照 crawl 模式加外部引擎选项。
- **文件条目 store 里只存元数据与 200 字摘录**：store.json 是条目清单不是文档仓库，全文在 needdo/ 下的文件。
- **主题在 process 时才分配**：捕获期零摩擦（不逼用户分类），整理期才归类——与「capture first, route second」一致。

### 遗留问题

1. 焦点在外时粘贴文件的竞态：paste effect 闭包捕获首帧的 `uploadFiles`，`busy` 可能读到旧值（并发上传不会坏数据，但有双重 toast 的可能）
2. 文件条目无法从面板预览/下载原件（list 只有摘录；原件路径仅在 CLI show 里可见）
3. URL 识别只认「整行无空白的 http(s)」，混在文字里的链接会被当文字收
4. `process` 一次整理全部 inbox 条目，无法只整理选中条目

### 下轮建议

- 面板预览原件：GET /api/needdo/file?id= 流式返回原件（MIME 按 ext），行内「查看」按钮 + Modal 展示提取文本
- UIUX 走查：真实浏览器里过一遍捕获 → 整理 → 归档 → 还原全流程，对照调研报告找落差
- agent 接入点设计：`process --agent` 现在只记录名字；下一轮确定 AI 复核的输出结构（每条目的 AI 摘要 + 主题修正建议如何落盘）
- 修粘贴竞态（busy 用 ref 而不是 state 做守卫）

## Round 2 · 2026-10-15

### 本轮完成

**调研**（docs/needdo/research-round2.md，5 条建议，1–4 已落地，5 已是现状）：
1. 详情用现成 Modal 展全文/原件（Raindrop 点击即预览范式）✓
2. 露出已入库的 links[]（行内徽标 + 详情可点 + 报告单列；不拆条，原文不动）✓
3. checkbox 多选 + 卡头批量条（选中非空时切换为「已选 N · 归档/还原 · 整理 · 删除」）✓
4. CLI 子集统一 `--ids a,b` 逗号惯例，推广到 process/archive/remove ✓
5. 全文只在详情按需取（list 保持 excerpt 轻量）✓ 第 1 轮即如此

**实现**：
- 详情 Modal：`needdo show` 全文/提取文本 + 夹链接可点 + `needdo file` 原件 base64 下载（新 action，CLI 侧打印路径与尺寸）
- 混排文字里的链接：`extractLinks()` 抽 URL 附到条目（全角标点断开、尾部 ASCII 标点修剪），原文一字不动
- 批量：`process/archive/remove` 全部支持 `--ids`；多选批量条随选择出现/消失，动作后清空选择
- 竞态修复：busy 守卫从 state 改 ref（paste 监听闭包读旧值的问题）
- 细节打磨：摘录与标题同文不再重复显示；无摘录行不再留孤立的 `· 时间`
- 测试：158/158 全绿（新增混排链接、批量归档/missing、批量删除不误删不连续条目、fileData 四例）

**真实浏览器走查**（Playwright + 面板实跑，截图存 docs/needdo/shots/）：
- 捕获：Enter 即存、整行 URL 识别为链接、退出后焦点归位 ✓
- 整理：3 条 → 待办事项/公告通知/链接收藏分类正确 ✓
- 详情 Modal、原件下载、多选批量整理（勾 2 → 「已整理 2 条」→ 收件箱 3→1、选择自动清空）✓

### 决策记录

- **批量删除用过滤重建而不是下标 splice**：选中的条目在列表里不连续，`splice(首个命中下标, N)` 会把夹在中间的无辜条目一起带走（已写成单测钉住）。
- **批量操作「部分不存在」不算失败**：missing 如实回报、全部不存在才 notFound——条目可能已被别处删掉，静默空操作比报错更难排查。
- **原件下载走 base64 过境 JSON API**：HTTP 层是纯 JSON 的（无 multipart），3MB 上限内 base64 是最小改动；不破坏「路由全部由 action 派生」的结构保证。

### 遗留问题

1. 面板不自动刷新：CLI 侧改了数据、面板不会自己更新（kb 有 kb-changed 事件机制可参考）
2. 走查中观察到一次瞬时 `#/home` 跳转（点「按主题整理」后），后续无法复现且自愈、控制台零报错——记入观察，若复现再查 App.jsx 的 hash 双向同步
3. 条目无「编辑」能力（收了错字只能删了重收）
4. PDF 提取对 CID 字体/扫描件无能为力（原件在，只是无文本）——见第 1 轮决策
5. 多选没有「全选」入口（条目多了以后需要）

### 下轮建议

- agent 接入点设计：`process --agent` 目前只记录名字；确定 AI 复核的输出结构（每条目摘要 + 主题修正建议落盘格式），并在 CLI 里给出接入说明
- 面板自刷新：参考 kb 的 kb-changed 事件，整理/归档后广播 needdo-changed（或本视图内已 refresh，主要用于跨视图/跨进程）
- 浏览器走查第二轮：文件条目（真实 PDF/DOCX 上传 → 提取 → 详情 → 下载原件）全链路 + 拖放交互
- 「全选」与 shift 连选

## Round 3 · 2026-10-15

### 本轮完成

**调研**（docs/needdo/research-round3.md）：AI 怎么接进收件箱——三问三答，结论全部有仓内先例支撑：
AI 只在整理期出现且只产出「建议」（Notion Autofill 非实时、Readwise 只自动摘要手动保存的、
Linear triage 的 goalie 拍板）；AI 结果只能是**附注**（git notes / Notion AI 独立属性 / 本仓 links[] 同形）；
交接用「一次拿全的简报 + 一份计划文件写回」（nx-kv 收单 SOP 已明令禁止逐条拉）。

**实现（agent 交接协议，5 条建议全部落地）**：
- `process --enhance-level 0-3`：形状/校验/归一化逐字对齐 crawl 的 `--enhance-level`（非 0-3 直接报错不回落）；0 = 纯规则（离线、CI、可复现），≥1 = 同时把条目排进 AI 队列（`ai.status='pending'`）
- `needdo brief [--ids] [--level] [--redo]`：一次拿全的自足 JSON（全文含文件提取文本、夹链接、**规则预判主题**、8 位内容指纹 `rev`、该级别要做的 task）；默认只导出未处理过的，`--redo` 才重跑
- `needdo apply --plan <计划.json>`：只追加 `ai` 段，绝不覆盖 content/title/topic/status；幂等键 `(batchId,id,rev)`，重放 = no-op；内容变过的归 `stale` 跳过并回报（对齐 archive 的 missing 口径）
- `needdo review --ids a,b [--reject]`：接受才写 `topic` 并记 `topicSource:'ai'`（kb 的 origin 直系同类：人显式定的永不被 AI 覆盖）；拒绝只清状态
- store：条目新增 `topicSource`（rule/ai/user）与 `ai` 附注（level/agent/at/rev/batchId/topic/summary/tags/confidence/status 四态机）
- 面板：行内「AI 建议 · X」/「待 AI」徽标、详情里的 AI 附注块（含摘要/标签/置信）、接受/拒绝按钮、多选批量「接受建议/拒绝建议」
- SKILL.md：新增「NeedDo 收件箱」一节（三步命令 + 计划文件形状 + 5 条铁律）+ 命令速查 8 行 + 数据存储说明——外部 agent 的接入点

**顺带完成（第 2 轮遗留）**：
- 面板自刷新：`visibilitychange` / `window focus` 时重取列表（CLI 外部写入后切回窗口即见，零常驻开销）
- 全选（只选当前视野里的条目，不把已归档的悄悄选上）
- 修复 `looksLikeLink` 真 bug：原先先删空白再判，`https://a.com 看一下` 会被整条误存成链接；抽成纯函数 + 单测钉住
- 修复 `confidence` 的 `Number(null)=0` 陷阱（面板把「没给置信度」显示成「置信 0」）

**验证**：
- `pnpm test` **165/165 全绿**（新增 7 条：协议三步闭环、幂等、stale/missing、--redo 语义、拒绝路径、plan 文件通道、looksLikeLink）
- smoke **18/18**（新增 CLI 侧协议全链路）
- 真实浏览器走查（Playwright）：真实 DOCX/PDF 上传 → 提取文本显示 → 详情 → **原件下载**（字节校验）；面板自刷新；AI 建议徽标 → 详情 AI 块 → 点「接受建议」→ 状态转「已采纳」、按钮消失
- CLI 端到端：模拟外部 agent 走 `process --enhance-level 2` → `brief` → 写计划 → `apply` → 幂等重放报 unchanged → `review` → 主题生效且 `topicSource=ai`

### 决策记录

- **AI 不许直接写 topic**：确定性规则「可解释、可回归测试」是地基，AI 会漂移——两者分列，建议先落 `suggested`，人/面板接受后才生效。这是调研里最硬的一条产品证据（Notion/Readwise/Linear 都从「捕获时静默标注」退到「整理时显式触发 + 人复核」）。
- **HTTP 侧计划走 `body.planData`**：CLI 的 `--plan <路径>` 是 string flag；若 HTTP body 也复用 `plan` 键，applySpec 会把对象强转成 `'[object Object]'`。用未声明键透传（api.js 既有行为）绕开强转，代价是键名不对称——已在 action summary 里写明。
- **restart 才生效**：服务端命令表在进程启动时构建，改完 action 要重启 `serve`（走查时踩到：面板 CliHints 还是旧的命令列表）。

### 遗留问题

1. `brief` 的选区间距：`--redo` 目前是「全量重导」，没有「只重导被拒绝过的」这一档
   （更正：rejected 的条目**不会**被默认导出——默认只导 `!ai || pending`，已由 round4 的单测钉住；
   实际缺的是「只针对 rejected 再问一轮」这条更细的选区）
2. 条目编辑能力仍然缺失（收了错字只能删了重收）
3. PDF 提取对 CID 字体/扫描件无能为力（原件在，只是无文本）
4. 走查中观察到一次瞬时 `#/home` 跳转（第 2 轮记录），仍未复现
5. `process --enhance-level ≥1` 目前只把条目挂进队列，没有提醒「队列里积压了多少」（面板无入口）

### 下轮建议

- 「AI 队列」在面板上的可见性：收件箱卡头显示「N 条待 AI 复核」，点开看到队列（现在只有条目上的「待 AI」徽标）
- 条目编辑（改文字/改标题/换主题，同时把 `topicSource` 记 `user`）
- 拖放交互的走查补完（拖入激活态、多文件、取消）
- 端到端二次走查：把 `--enhance-level` 的完整链路从面板侧暴露（现在面板的「按主题整理」固定级别 0）

## Round 4 · 2026-10-15

### 本轮完成

**调研**（docs/needdo/research-round4.md）：收件箱规模化后的三件事——找 / 改 / 撤。三条结论带证据：
过滤语法（`tag:` `@label`）在本地工具规模下是过度设计，一个词的全文入口就够（Things Quick Find /
Gmail 搜索的取舍）；编辑要「改而不换身份」（Gmail 改草稿不刷新收件时间）；删除的安全网要么是
秒级 undo 窗口、要么是回收站——**批量误删连原件的场景下，几秒的 toast 撤销救不了，回收站才行**。

**实现（5 条建议 + 2 个调研发现的真 bug）**：

- **找**：`needdo list [q] [--kind] [--limit] [--deep]`——`[q]` 是全文入口（标题/摘录/正文/主题/夹链接），
  `--deep` 才读文档的提取正文（读盘代价只在明确要时付）；`--topic` 改枚举、值取 `service.TOPICS`，
  主题词表**随 list 响应下发**（前端不许 import service.js，复制清单必然与 classifyTopic 分叉）。
  面板：搜索框 + 现成 `<Highlight>` 标黄 + 命中数；过滤与检索词进 `localStorage`（store.jsx 的
  「UI 状态持久化是硬标准」），**不进 URL**（App.jsx 的 hash 只承载 view，且那段有个未复现的跳转 bug）
- **改**：`needdo edit <id> [--title] [--topic] [--body]`。三条纪律落地：不动身份字段（只写 `editedAt`，
  且它必须进 store 白名单，否则编辑痕迹被归一化静默抹掉）；正文/标题一变旧 AI 建议归回 `pending`
  （brief 默认会重新捞）；`--topic` 记 `topicSource: 'user'`——这个值在 store 里躺了两轮却没有产出者，
  SKILL.md 却已经当既成事实写着，现在补上产出方
- **撤**：删除改**软删除**——条目落 `needdo.trash[]`、原件 rename 进 `needdo/trash/`；
  `needdo trash [--ids --restore] [--empty]` 一条 action 三方向；写入路径上自动淘汰（30 天 / 200 条）。
  面板：删除弹窗改口径 + 「回收站 N」入口 + 列/恢复/清空的 Modal
- **修 bug 1**：`review` 不看 `rev`——建议生成后条目被改过，仍能接受那条**针对旧内容**的建议。
  现在归入 `stale` 拒绝并提示重新 brief
- **修 bug 2**：`process` 与 `review` 无条件覆盖 `topic`——人定的主题会被规则表或 AI 建议顶掉。
  现在 `topicSource === 'user'` 时规则不覆盖、接受建议只改状态不动主题（单列 `protected` 回报）
- **顺带**：`apply` 幂等判据放宽到「整个 batchId 的痕迹」（重放旧计划不许把已接受/已拒绝的建议
  打回待复核）；`removeFiles` 加显式目录参数（回收站条目的文件在 `trash/` 下，按默认目录找会
  「以为删了其实还在」）；`src/index.js` 导出 needdo service，并把 README 里标着「❗无断言」的
  第 4 条清单项补成 `consistency.test.mjs` 的断言；README / CHANGELOG / SKILL.md 同步

**验证**：
- `pnpm test` **173/173 全绿**（needdo 单测 25 条：新增 edit 身份不变与链接/文件边界、主题保护、
  建议过期、检索与 `--deep` 边界、回收站三方向与淘汰规则 6 条）；smoke **18/18**
- 真实浏览器走查（Playwright，截图存 docs/needdo/shots/）：搜索「报销」→ 匹配 2 条 + 2 处标黄；
  编辑弹窗预填 + 主题下拉 → 保存后行内出现「主题你定的 · 改过」；删除 → 弹窗说明「30 天内可恢复」→
  回收站 1 → 恢复 → 回收站 0
- CLI：`trash` 三方向、`edit` 各分支、`list --deep` 边界均由单测/smoke 覆盖

### 决策记录

- **一个词的全文入口，不做过滤语法**：本地工具的条目量级不需要 `tag:` `@label`；语法是「要先学才能用」的
  成本，而搜索框是零学习成本。真需要结构化筛选时，`--status/--topic/--kind` 三个枚举已经够用。
- **软删除而不是 toast 撤销**：`useToast` 只吃字符串、没有动作槽；更重要的是批量误删连原件时，
  几秒的窗口救不回来。回收站 + 自动淘汰把「永远不删」和「不无限膨胀」同时满足。
- **`topicSource: 'user'` 是护身符**：与 kb 的 `origin: 'user'` 同款语义。它的产出方（edit）与保护点
  （process / review）必须成对存在——只有白名单值没有产出者是文档在说谎，只有产出者没有保护点
  等于给了个假开关。

### 遗留问题

1. AI 队列只有「卡头计数 + 一条简报命令」的可见性，没有专门的队列视图（点进去看有哪些条目在排队）
2. PDF 提取对 CID 字体/扫描件无能为力（原件在，只是无文本）
3. 走查中观察到一次瞬时 `#/home` 跳转（第 2 轮记录），仍未复现；round4 因此刻意不把过滤状态放进 URL
4. `test:pipeline`（真起 zg 的全链路）在本机跑不通：`~/.zvec-grep/models/` 为空，内置默认模型
   要首次下载 ~600MB，本环境下卡住超过 25 分钟。**与 needdo 改动无关**（未触碰 zg / kb 路径），
   属环境问题；`pnpm test` 这道质量门是绿的
5. 回收站没有「按条清理」之外的批量恢复 UI（CLI 支持 `--ids a,b`）

### 下轮建议

- 真实浏览器走查补完拖放细节（多文件、拖动中途取消、非白名单类型拒绝）
- 空状态与首次使用引导：收件箱为空时给一条「试试点这里」的示例注入
- 条目详情里显示 `rev` 与 AI 深链（把「这条建议基于哪一版内容」变成可见信息）
- 处理 `#/home` 瞬时跳转的复现尝试（若复现则修 App.jsx 的 hash 双向同步）
## Round 5 · 2026-10-15（收尾：发版 0.4.0）

### 本轮完成

**调研**（docs/needdo/research-round5.md）：收件箱的**出口**——整理完之后怎么沉淀成可检索的知识。
结论：走**手动、显式、批量**的一键导出，不做自动同步（本仓零后台/零账号/零双向先例，
自动同步必然要回答冲突解决，一次性导出根本不用回答）；不做模板引擎（引入依赖 + 多一个
「模板写坏」的失败面）；模具**逐字复用 crawl**（普通 markdown 目录 → 自动登记为知识库）。

**实现（5 条建议全部落地）**：
- `needdo export [--ids a,b] [--topic T] [--redo] [--to <目录>] [--archive]` + `POST /api/needdo/export`：
  产物落 `<数据目录>/needdo/export/<主题>/<日期>-<slug>-<id>.md`（frontmatter 带 `id`/`source`/
  `title`/`topic`/`kind`/`url?`/`addedAt`/`exportedAt`），自动登记为知识库 `[needdo-export]`（`origin: 'user'`）
- 条目侧三个字段 `exportedAt`/`exportPath`/`exportRev`（**都进了 store 白名单**——漏一个就会重复导一遍）；
  幂等判据 = 指纹相符 + 产物文件仍在 → `unchanged`；一次导出 = 重新检查全部已归档条目，
  按指纹报 exported/updated/unchanged（与 crawl run 同语义），`--redo` = 强制重写
- 三条纪律：严格单向（导出物是产物，库里改了不回流）、不搬家（改主题也不移动文件——
  Readwise Mirror 改文件名断链的实证）、判据用条目指纹而非产物哈希（exportedAt 每次都变）
- 路径安全：主题与标题一律过文件名清洗（`edit --topic` 允许自定主题 → `../../evil` 就是路径穿越），单测钉住
- 面板：「沉淀到知识库 N」按钮、行内「已沉淀」徽标、详情里的完整产物路径（可复制）
- **kb 域一行未动**（只写它的数据）——这就是「同一个模具」的全部含义

**顺带修的真 bug（走查撞见）**：**面板深链一直失效**——带持久化 tab 开 `#/kb` 停在旧 tab；
即便清空 localStorage，`#/kb` 也被拽回 `#/home`。根因是 App.jsx 两个 effect 首帧抢写 hash
（回写那个拿的是尚未被深链改写的 `ui.view`）。**这也解释了前两轮反复记下的「瞬时 #/home 跳转」**。
修法：启动首帧只认领不写 + hashchange 只接受注册过的独立 tab。修后深链全部正常（含 `#/crawl` 与垃圾 hash 的正确回落）。

**另**：卡头「待 AI / AI 建议」徽标改成可点即过滤（徽标即入口）；空状态给「填个示例」引导
（往输入框填示例，不往用户 store 里塞演示数据）；回收站加「全部恢复」；详情显示 AI 建议的
`rev`/时间/批次（「建议基于哪一版内容」变成可见信息）；拖放走查补完（中途取消、多文件、
非白名单拒绝）。

**验证**：`pnpm test` **177/177**（needdo 单测 29 条，新增 export 四例）+ smoke 18/18；
浏览器走查：搜索高亮 / 编辑 / 删除→回收站→恢复 / 徽标过滤 / 拖放三态 / 沉淀 12 条并看到产物路径。

### 遗留问题

1. `test:pipeline` 本机仍跑不通（`~/.zvec-grep/models/` 为空，内置默认模型需首次下载 ~600MB）——
   环境问题，与 needdo 无关；`pnpm test` 这道门是绿的
2. 沉淀后没有「一键建索引」的按钮（CLI 提示 `nx-kn index`，面板上要切到知识库 tab）
3. 导出物在库里被改动不回流（刻意的单向）；若将来要双向，得先回答冲突解决
4. PDF 提取对 CID 字体/扫描件无能为力（原件在，只是无文本 → 导出时跳过）

### 下轮建议

- 面板沉淀后给「去建索引」的直达入口（跨 tab 引导，不自动跑 zg 子进程）
- 导出产物与条目的双向提醒：产物被手改过时，面板给一条「产物已偏离」的提示（只读检测，不回流）
- 整体 UIUX 走查（第 10 轮的收尾项）：把 5 轮的功能串成一条真实用户路径演一遍

