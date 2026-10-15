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
