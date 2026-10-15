# NeedDo UIUX 调研 · 第一轮（快速捕获/收件箱）

日期：2026-10-15。范围：本项目现有设计语言（对照基线）+ 5 个成熟产品的捕获/收件箱交互。

## 1. 现有设计语言小结（对照基线）

- 「纸上规范」：黑白灰纸面（`--ink #14161a` / `--paper #fff` / `--mid` 次要灰），唯一语义色 `--bad` 朱、唯一强调 `--hl-bg` 黄（检索命中）；无 emoji、不用原生弹窗（toast/dialog 页内实现）。
- 卡片 `.card` = 1.5px 墨线直角 + outline 退 2px 双线书口、无投影；列表 `.row` 28px 发丝线分隔、hover `--soft`，`.row.wrap` 自适应多行；徽标 `.tag` 18px（`.strong` 灰泥绿 / `.bad`）；卡头 `.colhead` 28px；空态 `.empty`；按钮 `.btn` 28px 按下反色（ghost/small/danger）；表单内凹聚焦用 `--shadow-relief-inset`（tokens 注明立体感不扩散到卡片列表）。
- 组件库（ui.jsx）：toast / useDialog（确认·单输入·多输入，真枚举一律下拉）/ Modal / Spinner / Copyable / ErrorBoundary；最新视图范式见 crawl/view.jsx：refresh + busy + err + dialog + toast + CliHints，「列表未到转圈，不用 … 冒充空」。
- 壳：单行 sticky header + tab（底部 2px 指示条）；新 tab = registry.js 登记一行 + `modules/<域>/view.jsx`；主区 16px 边距，`.stack` 纵排卡片。

## 2. 各产品模式速记

### Things 3（Inbox + Magic Plus + Logbook）
- Inbox 是默认落地页，官方定位「未处理想法的临时集散地（staging ground）」，与其他清单并列但语义独立。
- Magic Plus：任何位置插入新条目，还能拖着放到目标位置——捕获点与处理点合一。
- 条目极简：单行 + checkbox，详情按需展开，列表里零表单。
- 完成项自动沉入 Logbook：不是删除，是免整理的自动归档；配合周回顾清 Inbox。（culturedcode.com 支持文档/features）

### Drafts（capture first, route second）
- 打开即一张新空白草稿，文字直接落进去；去向（归档/发布/发送）之后才选——「文本收件箱」范式的开创者。
- 输入区就是主界面：没有分类、没有表单、没有「新建」按钮。
- 列表按时间排，草稿永不丢，可随时回溯。
- 社区也指出代价：把收件箱当二级邮箱会堆积——必须有处理节奏。（blakecrosley.com 设计案例、benchpad 对比）

### flomo（输入即列表）
- 唯一主操作 = 顶部一个极简输入框，「像发推一样记笔记」，刻意不做字体排版。
- 回车保存，新卡片立即按时间插入流；`#标签` 内联输入即打标，不弹表单。
- 卡片流展示 = 时间 + 内容 + 标签徽标；menu bar 常驻入口进一步降低捕获摩擦。（ypplog 评测、macmenubar）

### Raycast（键盘优先单框）
- 快捷键唤起 → 直接输入/粘贴 → 路由到目标 → 消失，全程不碰鼠标。
- 单框多类型：打字、选中内容、剪贴板内容走同一输入口，路由在输入之后才决定。
- 官方 Notes 命令强调「open, write and format without touching your mouse」。（raycast.com/core-features/notes）
- 同范式：Obsidian QuickAdd 的 Capture——热键 → 输入 → 自动 append 到 Inbox.md，不打开笔记。

### Notion Web Clipper（URL/网页捕获）
- 保存的不是裸链接：链接 + 图片 + 正文文本一并入库，回来看的是内容本体。
- 保存时可顺带选目标库、加标签备注，但都可跳过——默认落到既定位置，不强制当场整理。
- 类型即身份：剪藏在库中以 bookmark 类型呈现。（notion.com/help/web-clipper）

### 文件拖放的通用准则（NN/g 等）
- 热区要比可见边界更大（边界外一点松手也算命中），整页可作 drop target。
- 拖放不能是唯一路径，必须配点击选择兜底（键盘/无障碍）。
- dragover 要有明确视觉态变化；落下一律自动处理，不追问。

## 3.【核心】NeedDo 首版可落地建议（5 条）

### 建议 1：单框多类型输入区置顶，Enter 即存，不做分类表单
- 建议：捕获区只有一个大输入框，文字/链接/粘贴混收；类型由系统识别（URL 正则、文件另走拖放），绝不让用户先选类型再输入。
- 依据：Drafts「capture first, route second」+ flomo 顶部输入框 + Raycast 单框收文本/选中/剪贴板。
- 落地：NeedDo tab 顶部放 `.card`：`.colhead` 写「收件箱」+ `.tag` 显示待处理数；卡体内一个 textarea（1-3 行自增高），placeholder「随手丢：文字 / 链接 / 拖入 PDF·DOCX」；描边 `--ink`、聚焦内凹 `--shadow-relief-inset`；Enter 提交、Shift+Enter 换行；成功后 `useToast('已收进收件箱')`。URL 判定放后端，前端不做类型下拉（ui.jsx 约定：下拉只用于真枚举）。

### 建议 2：整 tab 即拖放区，落下一律自动入库，并保留点击兜底
- 建议：文件不需要「先点上传再选文件」——PDF/DOCX 直接拖到 NeedDo 页面任意位置即可；同时必须有非拖拽路径。
- 依据：NN/g 拖放准则（热区大于可见边界、必须兜底、dragover 状态、自动处理）。
- 落地：视图根节点挂 dragenter/over/leave/drop；dragover 时给捕获卡加激活态（虚线 `--ink` 边 + `--soft` 底，写在 needdo 视图层自己的 css，不动 tokens 层）；drop 后逐文件调上传 API 并 toast 文件名；旁置 `.btn.ghost`「选择文件」+ 隐藏 `input[type=file]`（accept=".pdf,.docx"）兜底。

### 建议 3：列表复用 crawl 视图同构行 + `.tag` 类型徽标，不做图标卡片流
- 建议：条目行沿用「名称 + 徽标组 + 摘要 + 行内操作」四段式，与资料采集页视觉完全同构；类型/状态用文字徽标表达，不引入图标体系。
- 依据：flomo 卡片流的「时间+内容+徽标」信息密度、Notion 剪藏「类型即徽标」；crawl/view.jsx 是本项目最新写法范式。
- 落地：文本/链接条目用 `.row`（`.name` 放首行摘要、`.desc` 放来源/时间）；文件条目用 `.row.wrap`（第二行 `.desc` 放文件名+大小+时间）；`.acts` 区 `.tag` 标类型（文本/链接/文件，默认灰即可）、agent 已加工的加 `.tag.strong`「已整理」、失败 `.tag.bad`；URL/文件名套 `Copyable`；加载中 `Spinner`、空态 `.empty`「收件箱空了——随手丢点东西进来」，口径与 crawl 一致。

### 建议 4：处理 = 归档而非删除；默认只看收件箱，归档项可切看
- 建议：条目二态 inbox/done，主视图永远只显示 inbox；「归档」把条目移出视野但数据保留——兼顾 inbox-zero 的清爽感与「agent 加工后条目仍持久化」。
- 依据：Things 3 Inbox 官方定位「未处理想法的临时集散地」+ 完成项自动沉入 Logbook（不是删除）。
- 落地：`.colhead` 右侧 `.tag` 显示「待处理 N」；每行 `.acts` 放 `.btn.small.ghost`「归档」；colhead 处放「已归档」切换（`.btn.small.ghost`），切换后列 done 列表。全部复用现有类，零新增 css。

### 建议 5：键盘链路全通——切到 tab 即聚焦，粘贴即填入，Esc 清空
- 建议：捕获摩擦压到极限：切到 NeedDo tab 输入框已聚焦；焦点在别处时 Ctrl+V 也直接进输入框；Esc 清空；Enter 提交后焦点不丢，可连续录入。
- 依据：Raycast「唤起→粘贴→消失不碰鼠标」、Obsidian QuickAdd「热键→输入→自动归位」；Drafts 的产品价值就建立在「少一步是一步」上。
- 落地：textarea `autoFocus`；视图根节点 `onPaste`：事件带文件则走建议 2 的文件路径，是文本则写入输入框并聚焦；Esc 清空输入框；提交成功后清空且保持焦点。全部原生 React 事件，无新依赖、不引 UI 框架。

## 附：主要来源
- Things 3：culturedcode.com/things/support/articles/4001304 · culturedcode.com/things/features
- Drafts：blakecrosley.com/guides/design/drafts · benchpad.app/notes/vs-drafts
- flomo：ypplog.cn/en/posts/flomo-card-note-taking-complete-guide · macmenubar.app/app/flomo
- Raycast / QuickAdd：raycast.com/core-features/notes · quickadd.obsidian.guide/docs/Choices/CaptureChoice
- Notion 剪藏：notion.com/help/web-clipper
- 拖放：nngroup.com/articles/drag-drop · smart-interface-design-patterns.com/articles/drag-and-drop-ux
