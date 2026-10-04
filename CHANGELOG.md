# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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

### Changed

- **默认 embedding 模型**：`paths.js` 新增 `DEFAULT_EMBEDDING = 'local/qwen3-embedding-0.6b'`。
  取用顺序为「命令行显式 → 已建索引实际生效的 → 该库登记的 → 内置默认」。
  本机 `~/.zvec-grep/config.json` 不存在（既无 key 也无全局默认），没有这一层，
  「添加目录 → 更新索引」在干净机器上必然失败
- **迁移时丢弃旧的全局 `kb.model`**：它是单值字段，`kb use` 切库时被原样保留，
  实测出现过「store 记着 `local/potion-code-16m-v2`、磁盘上没有任何该模型的索引、
  实际索引用的是 `qwen3-embedding-0.6b`」的状态。把它写进每库记录等于把一个
  已知脏值升级成「下次建索引时静默生效的参数」，因此迁移只带 `path` / `name`

### Fixed

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
