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
