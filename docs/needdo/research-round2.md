# NeedDo UIUX 调研 · 第二轮（详情预览 / 混排链接 / 选择性整理）

日期：2026-10-15。范围：三个具体问题的成熟产品对照 + 本仓代码现状。
注意：工作区有未提交 WIP（service/index/store）——链接抽取 `links[]`、`needdo file`（原件 base64 下载）、
`process --ids` 子集已在后端落地或半落地，**缺口全在 view 层**；本轮建议以「接线」为主，少动 service。

## 一、条目详情/预览：点开一条看全文/看原件

### 产品速记
- 邮件三栏（Gmail/Outlook/Win Mail，MS Learn「list/details 模式」）：列表保持可扫读、阅读窗格稳定不跳动；
  适合**高频大量分诊**。窄屏时 master-detail 折叠成「列表 → 钻入全屏 → 返回」单栏流。
- NN/g progressive disclosure / accordions：详情按需展开适合「次级内容」； excerpt 已给 200 字摘要，
  全文属二级内容，藏一下不过分。
- Raindrop：点击书签默认弹内置**预览浮层**（读保存的全文），没有保存副本才退回原网页；右键才有 Preview 菜单——
  「看」是默认路径，浮层不打断列表上下文。
- Notion 剪藏：存进来的就是内容本体，点开即读；列表（数据库视图）仍只显示标题等属性，密度优先。
- 移动端共性：无侧栏，浮层变全屏（Modal 的 `min(900px,100%)` + `84vh` 在窄窗口天然退化为全屏感）。

### 本仓现状
- 后端已就绪：`needdo show`（GET，text 给全文/file 给提取文本）与 `needdo file`（base64 过境下载）。
  **view.jsx 完全没有点开条目的交互**——行不可点，excerpt 到 200 字为止，文件条目看不了提取文本。
- ui.jsx 的 `Modal`（900px/84vh/滚动/Esc+遮罩关）**至今零消费**；useDialog 只是确认/输入（460px，不适合长文）。
- WIP 隐患：`needdo.file` 的 render 引用 `r.path`，而 `fileData()` 返回里没有 path 字段，CLI 会打出 undefined。

### 结论
点行 → **Modal 展全文**（本项目面板宽度撑不起第三个常驻栏，低频收件箱不配三栏）；原件用「下载」而不做内嵌预览
（PDF 内嵌要新依赖，违反零依赖）；操作（归档/删除）随详情就地提供，看完即可处理掉——Raindrop 范式。

## 二、混排文本里的链接识别

### 产品速记
- Slack/Telegram/Discord：**渲染时**对纯文本跑正则成链，不存预链接文本（Slack 为此开源了 URL-Detector）；
  经典边界是去尾标点（句号/右括号）与长 URL 截断显示、保留完整 href。
- Slack unfurl：原文一字不动，富预览作为**附挂元数据**出现在消息旁——「文本是本体，链接信息挂外面」。
- flomo：卡片里贴的 URL 自动渲染为可点链接，链接就在文本流里；内部关联默认折叠，点「关联」才展开。
- 共识：**不拆条**。拆条毁掉原文上下文（「看一下这个 https://… 再决定」的语义就没了）。

### 本仓现状
- 后端方向正确：`addText` 已存 `links: extractLinks(body)`（原文不动 + 抽出去重附挂，即 Slack unfurl 模式），
  store.js 归一化，整理报告里单列「内含链接」。
- 缺口：view.jsx 不渲染 `it.links`，「这条里藏着链接」在列表里不可见；CLI `needdo show` 也没列 links（只有报告列）。

### 结论
入库后端已对，**露出层补齐**：列表行给「藏链接」暗示，详情/CLI show 给可点可复制的链接清单；永远不拆条。

## 三、选择性整理：只整理部分条目

### 产品速记
- Gmail：行首 checkbox → 列表上方浮出工具条（打标签/归档 E）；打完标签**选择保留**，可接着归档——连续操作不重选；
  还能「选择符合此搜索的全部」按过滤集批量。
- Linear：点 checkbox 或 Shift+方向键范围选；选中数 >0 时浮出批量操作条（底部）。
- Todoist：Ctrl/Cmd+点 多选、Shift+点 范围选；底部多选工具条（`,` 快捷键聚焦）；移动端长按进入选择态；
  明确**不做橡皮筋拖选**；动作完成后清空选择。
- 共性：**选择是临时态**——平时行首不放 checkbox（视觉噪音），进入选择态或勾第一个才浮现工具条；动作后清空。

### 本仓现状
- 视图：行操作只有单条归档/删除；「按主题整理」按钮永远整理全部 inbox，没法「这 3 条先整理」。
- 后端：`process({ids})` + CLI `--ids`（`type:'array'` 逗号切分，spec.js 原生支持，kb `types` 有先例）已在 WIP。
- CLI 运行时约束：`runtime/cli.js` parseRest 对重复 flag 是**覆盖语义**（`--id a --id b` 只剩 b），支持重复 flag 要改解析器；
  范围语法（1-5）对 `nd-` 随机 id 无意义。

### 结论
视图走 Gmail 式 checkbox 多选 + 条目卡头浮出批量条（归档/整理/删除选中，动作后清空）；
CLI 统一 `--ids a,b` 逗号惯例（仓内解析器与 spec.js 决定的自然解，不引入重复 flag/范围）。

## 【核心】可落地建议（5 条）

### 建议 1：点行开 Modal 看全文与原件，操作随详情就地做
- 建议：`.row` 的 name/desc 区可点 → 调 `GET /api/needdo/show?id=` → `Modal`（现有组件）里 `<pre>` 展全文；
  file 条目加「下载原件」按钮（`/api/needdo/file` base64 → atob → Blob → a[download]，`toBase64` 反向即可）；
  Modal 尾部放「归档/删除」（复用现有 handler），看完即处理。
- 依据：Raindrop 点击即开预览浮层；MS list/detail 三栏适合高频邮件而非低频收件箱；NN/g 二级内容按需展开；
  Modal 在窄窗口自动全屏，覆盖移动端钻入范式。零新依赖、零新 css。
- 落地：view.jsx 加 `detail` state（存 id），打开时置 null 转 Spinner、加载后渲染；无 textFile 的 file 条目给
  「无文本——原件已保留」空态。service.js 不动；顺手修 WIP 的 `r.path`（render 里删掉该行或让 fileData 返回 path）。

### 建议 2：links[] 露出——列表暗示 + 详情可点 + CLI show 单列
- 建议：行 desc 里把 excerpt 命中的 URL 片段用 `Copyable` 渲染（前端按后端同款正则切分 excerpt）；excerpt 被截断
  或链接没进摘录时，acts 区加 `.tag`「内含 N 链接」；详情 Modal 与 CLI `needdo show` 都列「内含链接」清单。
- 依据：Slack unfurl「原文不动 + 元数据附挂」正是本仓已实现的形态；flomo 卡内 URL 自动可点——藏着的链接要可见
  才有入口；不拆条是各家共识。
- 落地：view.jsx 行渲染读 `it.links`（list 响应已含）；index.js `needdo show` render 补一行
  `if (it.links?.length) push('  内含链接: ' + it.links.join('  '))`。service.js 不动（extractLinks 已在）。

### 建议 3：checkbox 多选 + 卡头批量条，动作完成清空选择
- 建议：每行 acts 首位放小 checkbox（原生 input，配 needdo.css 三五行即可）；选中非空时条目卡 colhead 的
  过滤按钮组切换为「已选 N · 归档 · 整理 · 删除」；「整理」调 `POST /api/needdo/process` body `{ids:[...]}`；
  批量删除走 dialog 确认（复用 removeItem 的确认文案逻辑）；动作后清空 sel 并 refresh。
- 依据：Gmail（勾选 → 上方工具条 → 选择保留可连续操作）+ Linear/Todoist（选中浮现工具条、动作后清空、
  不做拖选）；平时无 checkbox 保持行密度。
- 落地：view.jsx 加 `sel`（Set）state 与批量条；process/删除已可直接接；批量归档若不想循环单条端点，
  依建议 4 给 service.archive 加 ids 后一次调用。

### 建议 4：CLI 子集选择统一 `--ids a,b`（type:'array'），推广到 archive/remove
- 建议：`needdo process --ids`（WIP 已加）之外，`needdo archive` 与 `needdo remove` 也加
  `ids: { type: 'array' }`，service 侧接受数组、单个 mutateStore 事务内处理；不做重复 `--id`，不做范围语法。
- 依据：clig.dev/urfave/cli 里逗号与重复 flag 并为惯例，但本仓 parseRest 重复即覆盖、改解析器成本高，
  spec.js 原生逗号切分且 kb `types` 已是先例；`nd-` 随机 id 使范围无意义。
- 落地：service.archive/remove 的签名从 `id` 扩为 `ids`（兼容单值：`Array.isArray` 判断同 process 写法），
  remove 沿用事务后 `removeFiles(gone)`；index.js flags 与 render 汇总（`已归档 N 条`）。
- 落地注意：positional `id` 参数保留不动，`--ids` 是它的批量版，两者互斥时报 badInput。

### 建议 5：全文只在详情按需取，list 响应保持轻
- 建议：列表继续只带 excerpt（200 字）+ links + 元数据；全文/提取文本只经 `needdo show` 取，不做进 list。
- 依据：Notion 剪藏列表（数据库视图）只显示属性、内容本体点开才见；store.js 自己的注释——store.json 是
  「条目清单不是文档仓库」；列表回传全文会让每次刷新搬运几 MB。
- 落地：service.list 不动；view.jsx 详情打开时按 id 拉 show（loading 期 Modal 内放 `Spinner`，口径同
  「列表未到转圈」）。

## 附：主要来源
- MS Learn list/details：learn.microsoft.com/en-us/windows/apps/develop/ui/controls/list-details
- NN/g：nngroup.com/articles/progressive-disclosure · nngroup.com/articles/accordions-on-desktop
- Raindrop 预览/全文：help.raindrop.io/articles · Notion 剪藏：notion.com/help/web-clipper
- Slack：docs.slack.dev/messaging/unfurling-links-in-messages · URL-Detector（linkedin.com/engineering）
- flomo 链接：help.flomoapp.com/thinking/link.html
- Gmail 整理：support.google.com/mail/answer/9259770 · Linear：linear.app/docs/select-issues
- Todoist 多选：todoist.com/help/todoist/features/add-or-manage-multiple-tasks-in-todoist-PcPoskdUp
- CLI 惯例：clig.dev · github.com/aquasecurity/trivy/discussions/8446（重复 flag vs 逗号之辩）
