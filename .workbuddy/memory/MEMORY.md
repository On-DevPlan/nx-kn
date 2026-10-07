# nx-kn 项目长期记忆

## 项目定位

把本机 Obsidian vault 当知识库，用 zg（zvec-grep）做「rg 精确 + FTS 关键词 + 向量语义」
三路混合检索；nx-kn 提供 CLI 与 Web 面板。骨架来自 nx-nx 的 `server-cli-web` 模板
（letters = `kn`，port 7881 / vite 7882，tokens light / layout tabs / style paper / scheme mars）。

## 架构约定（改动前必读）

- 一条 action 同时声明 `cli` 与 `http`（`src/modules/<域>/index.js`），命令表/路由表/help 全部由此派生。
- 分层：`core ← modules ← runtime`；模块之间禁止互相 import（eslint 枚举式禁列 + 一致性测试）。
- 失败 `throw NxError`，业务结果 `return { status }`（例：「还没建索引」= `{ needIndex: true }`，不是错误）。
- 新增功能域的 8 处落点见 README「加一个功能域要碰哪几处」；其中 `src/index.js` 导出、
  `eslint.config.js` 禁列、`assets/nx-kn/` 文档三处**没有任何测试兜底**，必须人工对。

## zg（zvec-grep）接入事实（0.2.2 本机实测）

- Windows 上 `zg` 是 `zg.cmd`，必须经 `cmd.exe /d /s /c` 调用；参数含 `"` 或 `%` 直接拒绝
  （cmd 会改变语义，无法可靠转义）。
- **`zg query` 没有 root 参数**，workspace 由**子进程 cwd** 解析 → 必须 `cwd = vault`。
- **`zg query --json` 已被移除**（报错提示用 agent markdown 或 `--human`）→ 输出解析是正式代码：
  `src/core/zg.js` 的 `parseQuery` / `parseStatus`，规则由 `tests/unit/zg-parser.test.mjs` 钉住。
  - 命中头锚定行首 `#N matchedBy=...`；片段正文的 `#` 标题在行号之后，不会混淆。
  - 解析时**只能剥 `\r`，不能 trimEnd**：空源码行是 `7\t`，吃掉字符会让片段里的空行整段丢失。
  - status 覆盖条是 `#` 与 `-` 混排（`################----  79%`），字符类要同时吃这两种。
- `zg onboard` 命令已不存在（nx-rp 的写法过时）；授权用
  `zg auth grant <dir> --capability embedding --scope workspace`，签名落 `<kb>/.zvec-grep/authorization.json`。
- 换 embedding 模型**必须** `--rebuild`（旧索引锁定维度）；`zg config provider set qwen --api-key <k>`
  写的是 `~/.zvec-grep/config.json`，nx-kn 不接触 key。
- 收录口径：`-t md`，显式 `-g '!.obsidian/**' -g '!.trash/**'`（隐藏路径 zg 默认不扫，显式写是防默认值变化）。
- 可用本地模型 `local/qwen3-embedding-0.6b`（1024 维，llama-cpp，离线免 key，中文可用）；
  远程 `qwen/qwen3.7-text-embedding`（1024 维，128K）需 key。
- 并发跑 index 会看到 `Cleanup of retired segment failed`（Windows 文件锁残留清理警告），不影响结果。

## 本机环境注意

- PowerShell stdout 常捕获不到 → 一律写文件再 Read；含中文的输出经 PowerShell 管道会乱码，
  要看真实输出就用 Node 脚本 `writeFileSync(..., 'utf8')` 中转。
- `Remove-Item` 会静默失败 → 用 `[System.IO.File]::Delete()`，删完必须独立列举复核。
- IDE/会话注入 HTTP 代理，但本地模型下载与 npm 安装实测未被掐。
- 后台起服务用 `node bin/kn.mjs serve --no-open`；`Start-Process pnpm`（.cmd shim）拉不起来。

## 面板视觉与可读性约定

- **对比度是硬指标，不是审美偏好**：正文 ≥ 4.5:1、大字/粗体 ≥ 3:1。审核方式是用 CDP
  在真实浏览器里算（技能 `web-ui-cdp-audit`），不许靠截图目测。改完必须复测同一指标
  并给前后数字。
- CSS 分四层，改动要对号入座：`tokens.css`（只准 `:root` 定义变量）→ `style.css`
  （base：reset/工具类/表单/空态）→ `style/*.css` 十件（组件策略，换风格换这层）→
  `layout.css`（版式壳，永远最后 import）。**别把原子类抄进 layout 层。**
- `--mid` 是唯一的「次要文字」色（`--ink` 正文、`--paper` 纸面、`--soft/-2` 面与线、
  `--bad` 唯一语义色）。light 主题用 `#6a6f76`（5.06:1）；**dark 主题的 `#8b9096`
  在深底上是 5.47:1，合格，不要跟着改。**
- 沿用骨架原子类（`.card` / `.row` / `.tag` / `.kv` / `.colhead` / `.snippet-box` /
  `.cli-hint`），不要自造类名——模板里 `.opt-row` / `.opt-label` / `.opt-actions`
  只有 JSX 引用、无 CSS 定义（已在 `style.css` 补上）。
- 单行行（`.row`）固定 28px 高；放多行内容（代码片段等）必须用 `.row.wrap` 变体，
  否则 `overflow: visible` 会把内容压到相邻行上叠字。
- 面板状态卡：**`st === null` 是「还不知道」，不是「没有」**。`/api/kb/status` 冷启动
  要 5–6.5s，期间必须显示 `…`，不能渲「未设定 / zg 未安装 / 未建」。

## 库之间的谱系：抓取产物 ←→ 源目录（F8，已落地）

- `crawl run` 会把产物目录**自动登记为知识库**，而**本地目录源**（`kind: 'local'`，典型是
  Obsidian vault）的源目录本身往往也是登记库 → 同一批笔记两份登记、各占 `--limit` 名额。
  **唯一被自动处理的重复就是这一种**；两库互为父子目录之类的嵌套仍不处理。
- 判据是**确定的谱系**，不是内容相似度（产物是重排过的版本 + 加了 frontmatter，路径与哈希都对不上）：
  产物目录 = `sourceDirOf(源名)`，源目录 = 源的 `url`。实现：`core/store.js` 的
  `crawlProductVaults()` / `standbyVaults()`。
- `kb.vaults[]` 的 `origin` 是**三态**：`'crawl'` / `'user'` / `null`（历史数据）。
  只有 `origin !== 'user'` 才可能被抑制；`kb add <路径>` 一次即「我确认要它」——
  这是启用被排除库的**唯一**入口（刻意**不**新增 `kb standby`：同一件事两个入口迟早只改一边）。
- `resolveVaults()` 返回 `{ vaults, standby, source }` 而不是一个大数组加标志位——
  调用方必须自己选（合成一个数组，将来某个调用方漏看标志位就会静默把重复算进去）。
  调用方全集：index / query / status / watch。
- **安全边界（唯一）**：只在「源目录也是登记库」时抑制。web 源、源目录未登记的本地源都不抑制
  ——收起来等于内容凭空消失。判宽和判严都是**静默**的，所以 `tests/unit/vault-lineage.test.mjs`
  + 流水线 P19 逐条钉住。
- 呈现必须说清「为什么没参与 + 怎么参与」：`kb list` 标 `【未参与检索】`、`query` 的
  `skipped[]` 里 `standby: true` 单列、`status` 的 `totals.standby`（**totals 其余口径只算参与的库**）。
- `kb remove` 掉**产物**库**不持久**（自动登记条件是 `produced > 0 && 未登记`，下次 pipeline 加回来）；
  删源库才稳定。

## 已修的审查问题（2026-10-08，F1–F10 全部，勿再引用旧结论）

- 判据：凡 `new Error(...)` 后手赋 `err.code` **一律无效**（`toErrorPayload` 只认 `instanceof NxError`），
  必须用 `badInput()` / `notFound()`。`tests/unit/errors.test.mjs` 已钉成回归闸门。
- `CliHints` 按 **action id** 查命令表（不是传命令字符串）；id 查不到时 `console.warn`，
  不再静默 `return null`——「静默失效」是这套代码库最需要防的失效模式。
- `store.json` 解析失败先改名 `store.json.corrupt-<时间戳>` 再继续（只有 `ENOENT` 算首次运行）；
  `health` 会**真的读一次** store。
- 采集陈旧产物清理：只清「上次 manifest 记录过、本次未产出」的 `.md`，且只在 `produced > 0` 时清理。
  **坑**：`next` 是从上次 manifest 继承的，拿它当保留集合 = 什么都没删。

## 测试约定

- `tests/pipeline.mjs` 是「一个外层测试 + 25 个内层子测试」的嵌套结构。**`node --test --test-name-pattern`
  对嵌套子测试是假绿**：它按文件名过滤，报 `1..0 / 0 subtests / exit 0`，实际一条没跑。
  → 要跑 pipeline 就整文件跑（`pnpm run test:pipeline`），别用 name-pattern 图快。
- 快检 = `pnpm test`（lint → build → smoke → unit）；集成另跑 `test:pipeline`（约 8–12 分钟）。
- **测试里建了索引才算数**：被 `resolveVaults` 排除的库不会进 `index`，所以「`kb add` 之后应该能搜到」
  这类断言必须自己补一步 `index`，否则失败信息会误导成「规则没生效」。

## 当前状态

vault 暂指向 `D:\DevProjects\my\github\nx-kn-smoke`（3 篇中文笔记 + 已建索引，可作回归样例）；
真实 vault 路径与 qwen key 待用户提供。计划文档在仓库同级 `nx-kn-plan.md`，待归档 `docs/plan/`。
