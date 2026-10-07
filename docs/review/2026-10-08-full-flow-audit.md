# nx-kn 全流程与逻辑审查

> 审查时间：2026-10-08 · 版本：v0.3.0（main @ bdc5cf5，工作区另有未提交改动）
> 审查方式：**读代码 + 真跑命令 + 真跑测试**，每条结论附证据；本机 zg 0.2.2 实测。
> 结论分三档：**缺陷**（行为与设计/文档不符，建议修）／**一致性**（两层说法打架）／**观察**（现状事实，供决策）。
> 本文只记录审查结论，不含改动。

---

## 一、结论速览

| # | 档位 | 结论 | 落点 |
| --- | --- | --- | --- |
| **F1** | 缺陷（中） | 首页与设置页的「CLI 等价提示」**根本没渲染**——4 处调用传了组件不认的 prop，静默返回 null | `web/frontend/components/CliHints.jsx:11` ← `modules/home/view.jsx:181,240`、`modules/settings/view.jsx:82,83` |
| **F2** | 缺陷（中） | 错误码契约被绕过：非 `NxError` 上设 `err.code` 不生效，5 处意图码被吞成 `INTERNAL`（HTTP 500 而非 400/404） | `core/errors/index.js:72` ← `modules/settings/index.js:39`、`runtime/skill.js:46,77,83,90,98` |
| **F3** | 缺陷（中） | `nx-kn watch --off` 不存在（报「未知参数」），但 summary 与 3 处注释都宣称 `--on/--off` 可用；`--on` 则是「静默常驻」 | `modules/kb/index.js:242,243-246,251` |
| **F4** | 一致性（低-中） | `pipeline <源名>` 的「只跑该源」只对抓取成立，索引步骤固定跑**全部库** | `modules/home/service.js:96` 对 `index.js:71` 的文案 |
| **F5** | 一致性（低） | `nx-kn help` 首屏就打印一行模板残留：`如 nx-nx help repo`（还少一个右括号） | `runtime/cli.js:33` |
| **F6** | 缺陷（低） | `store.json` 解析失败会被静默当成「空结构」，下一次写操作直接覆盖原文件 | `core/store.js:52-57` |
| **F7** | 缺陷（低） | 采集侧两个增量盲点：换引擎不清理旧引擎产物；远端已删页面留盘继续被索引 | `modules/crawl/service.js:417-419,555-567` |
| **F8** | 观察 | 本机 store 里两个库内容重叠（原始 vault + 其 skill-seekers 整理产物），同一笔记会有两份命中 | `~/.nx-kn/store.json` |
| **F9** | 观察 | `hasIndex()` 仍只看目录是否存在（对账文档 B3「部分修」），坏索引会表现为「无命中」+ 跳过提示 | `core/zg.js:29` |
| **F10** | 观察 | 本机 `skill-seekers` 不在 PATH、`NX_KN_SKILL_SEEKERS_CMD` 未设（仅剩 `uvx` 回退与 venv 绝对路径两条路） | 环境 / `core/skill-seekers.js:37-58` |

**主干是健康的**：分层约束、一条 action 三端同源、失败抛错/业务结果返回 `{status}` 两条契约在主干代码里执行得很干净；
`lint / build / smoke 15 / unit 100` 全绿，全链路集成测试真起 zg 逐环通过（见 §四）。上述缺陷都在**边缘分支**上，
没有一条会破坏「加库 → 建索引 → 检索」这条主干。

---

## 二、端到端流程逐段核对

### 1. 装配：一条 action 声明 → 三端

- `src/modules/<域>/index.js` 里每条 action 同时声明 `cli` 与 `http`；`runtime/registry.js` 汇总成 `ACTIONS`。
- **装载期自检**（`registry.js:28-52`）是真护栏，不是注释：id 重复 / CLI 路径重复 / HTTP 路由重复 / 缺 `run` /
  有 `http` 无 `cli` 都会在**启动瞬间**抛错。方向性约定刻意不对称：`cli` 必须有，`http` 允许显式 `null`
  （`home.skillGet` 就是这种纯 stdout 契约）。
- CLI 侧 `runtime/cli.js`：`resolveCommand` 按**最长 token 前缀**匹配（支持含 flag 的命令路径与别名数组），
  未知 flag 直接报错而不是静默忽略；`spec.js` 统一强转与校验，`--depth` 这类漏值会报「参数需要提供值」
  而不是被 `Number(true)=1` 变成另一个合法语义。
- HTTP 侧 `runtime/api.js`：路由由 `action.http` 编译并按**具体度排序**（字面量段优先），
  于是声明顺序不影响匹配结果；非 GET/HEAD 走 `originAllowed` 挡跨站；错误码 → HTTP 状态只在 `core/errors` 映射一次。
- 面板侧 `web/frontend/registry.js` 的 `VIEWS` 与后端 `MODULES` 由 `tests/unit/registry.test.mjs` +
  `consistency.test.mjs` 双向钉死（模块没登记、view 没登记、文档命令不存在，都会直接红）。

### 2. CLI 执行链

`bin/kn.mjs` → `runCli(argv)` → 摘全局 flag（`--json` / `--store`）→ `resolveCommand` → `parseRest`
（布尔 flag 不吞下一个 token）→ `applySpec`（强转 + enum + 必填）→ `action.run(ctx, {transport:'cli'})`
→ `emit`（有 `render` 走文本、`--json` 走序列化）→ 失败 `fail()` 输出 `{ok:false,error,code}` 并置 exitCode 1。
`serve` 走独立分支：起 HTTP 服务 → **默认**起进程内守护（`--no-watch` 可关）→ `SIGINT/SIGTERM` 收尾时 `stopWatch`（幂等）。

### 3. 数据与持久化

- `core/store.js`：`initialState()` 定结构 → `normalize()` 合并（**无迁移脚本**，老键自动补默认）。
- 原子写（临时文件 + rename）+ 进程内缓存 + mtime 失效检测；`mutateStore` 先深拷贝、回调抛错则不落盘。
- 两类结构性迁移都做对了：`kb.vault`（单值）→ `kb.vaults[]`；`kb.model` 全局单值**刻意不迁移**
  （已被证实是脏值，宁可丢也不升级成建索引参数）。迁移是惰性的：读命令不写盘，随下一次写落盘。
- 存储路径由 `NX_KN_STORE` / `--store` 一处决定，**`sources/` 跟着 store 走** —— 于是测试指向临时目录即天然隔离，
  用户也能整体挪窝。这一条是采集域复用的前提。

### 4. 采集链（crawl）

`crawl add`（登记，不联网；磁盘上存在的目录即 `kind=local`，只认 skill-seekers）→
`crawl run`（node：sitemap 优先 / 同域 BFS 回退 + cheerio/turndown 清洗；skill-seekers：整段外包）→
产物落 `<数据目录>/sources/<名>/**/*.md` + 同目录 `.nx-kn-crawl.json`（url→{file,hash}）→
**有内容才自动登记为知识库** → 之后索引/检索/增量/多库合并全部复用 kb 域。
细节做对的地方：目标页正文候选按「越具体越优先」逐个试；噪声选择器覆盖到 `[role=navigation]` 一级；
URL→文件路径剥起始目录前缀并逐段清洗（防目录穿越）；页面冲突时补哈希后缀；哈希**只算正文**（
frontmatter 的 `fetchedAt` 不算），否则「没改的页面」永远判为 changed、增量失效；串行 + 节流（默认 300ms）；
一页都没抓到且此前无内容时**绝不建出空源**（抛错并给出「换 `--engine node`」的出路）。

### 5. 索引与检索链（kb）

- `index`：逐库**串行**（zg 并发会抢模型/磁盘），`-t md` + 显式排除 `.obsidian/**`、`.trash/**`。
- 模型选择是一张有优先级的表：`--model` > 已建索引实际生效的 > 登记时记的 > `NX_KN_EMBEDDING` > 内置默认。
  换模型且未加 `--rebuild` 时**主动报错**（而不是把难懂的维度冲突丢给 zg）；增量路径刻意不传 `--embedding`
  （少一个出错面，也避免把已存 schema 当参数再校验一遍）。
- `status`：逐库**并发**探测（每个库一次 `zg status`，2–6s），只认索引里实际生效的模型（未建索引显示「未记录」，
  不回落 store 的残留值）；笔记数按 zg 口径估算并解释差额（隐藏目录 / 内置忽略目录名 / 嵌套 git 仓库 / 0 字节空文件）。
- `query`：逐库并发召回，固定 `--fuse`（不加会被按词拆成多组重复返回）与 `--trace`（拿 RRF `score=`），
  用 **score 跨库可比**这一性质合并排序，同分按库登记顺序、再按库内 rank；命中标注来源库；
  单库失败**不拖垮**整次查询，但进 `skipped[]` 明示；「还没建索引」是 `{needIndex:true}` 业务结果而非错误。
- 解析层（`core/zg.js` 的 `parseQuery` / `parseStatus`）是正式代码而非顺手工具：`--json` 已被 zg 移除，
  HIT_RE 锚定行首且把 `score=` 设为显式可选捕获组（否则贪婪匹配会把路径污染成 `score=0.0328 a.md` 且不报错）；
  解析片段时**只剥 `\r` 不 trimEnd**（空源码行是 `7\t`）；状态覆盖条字符类要同时吃 `#` 与 `-`。

### 6. 守护链（watch）

`core/watch.js`（纯基元：路径过滤 + 防抖合并 + `fs.watch` 封装）与 `modules/kb/watch.js`（会话、串行队列、
dirty 合并）分工清晰。三个「正确性而非优化」的处理都在位：**排除目录根本不挂 watcher**（避开回环与 Linux
递归 watch 的 ENOENT 崩溃路径）、**串行且不重入**、**合并而非排队**。索引失败不掀掉守护；
`close()` 幂等；错误只记状态并自愈重挂。

### 7. 守护的两种形态（同一 action）

CLI `nx-kn watch` = 前台常驻；HTTP `POST /api/kb/watch` = 开关 serve 进程内的守护；`GET /api/kb/watch`
= 轻量状态（**不碰 zg**，面板才敢 3s 轮询）。把守护状态拆成独立路由是重要设计决策：塞进 `/api/kb/status`
会让轮询每次都逐库起 `zg status`（秒级），把面板拖垮。

---

## 三、发现的问题（详述）

### F1 · CliHints 四处调用传错 prop，「CLI 等价提示」静默消失

`web/frontend/components/CliHints.jsx:11` 的签名是 `{ module: moduleId }`，实现是
`boot.commands.filter(c => c.module === moduleId)`，**没有** `command` 参数：

```jsx
export function CliHints({ module: moduleId }) {
  const cmds = (boot?.commands || []).filter((c) => c.module === moduleId);
  if (!cmds.length) return null;
```

而 4 处调用传的是 `command` / `note`：

| 文件:行 | 调用 | 结果 |
| --- | --- | --- |
| `modules/kb/view.jsx:404` | `<CliHints module="kb" />` | 正常渲染 |
| `modules/crawl/view.jsx:257` | `<CliHints module="crawl" />` | 正常渲染 |
| `modules/home/view.jsx:181` | `<CliHints command="nx-kn pipeline" note="…" />` | **返回 null，什么都不渲染** |
| `modules/home/view.jsx:240` | `<CliHints command="nx-kn routes" note="…" />` | **同上** |
| `modules/settings/view.jsx:82,83` | `<CliHints command={\`… settings set …\`} />` | **同上** |

`moduleId === undefined`，而 `commandEntry()`（`cli.js:172`）保证每条命令的 `module` 至少是字符串
`'platform'`，所以 filter 结果恒为空 —— 提示块连空壳都不输出，控制台也不会有任何告警。
故障方式是「少一行 UI」，恰好是本项目 README 里警告的那类「漏了不会报错，只会静默失效」。

**修法二选一**：给 CliHints 增加单命令分支（`command` + `note` 时渲染一行 `<code>`，不再查 `boot.commands`）；
或把 4 处改成 `module="home"` / `module="settings"`（但会列出该域全部命令，与原文案的意图不同）。

### F2 · 错误码契约被绕过：`err.code` 在非 NxError 上不生效

`core/errors/index.js` 明确定义「失败抛 `NxError`」，且注释承诺 `code` 是给 agent 分支用的字段。
但 `toErrorPayload` 只在 `err instanceof NxError` 时读 `code`，其余一律 `INTERNAL`：

```js
export function toErrorPayload(err) {
  if (err instanceof NxError) { … return { code: err.code, message: err.message }; }
  return { code: CODES.INTERNAL, message: String((err && err.message) || err) };
}
```

于是 5 处「先 new Error 再赋 `err.code`」的写法全部失效（实测）：

```
$ node bin/kn.mjs settings set badformat --json
{ "ok": false, "error": "设置项需形如 k=v，收到: badformat …", "code": "INTERNAL" }   ← 应为 INVALID_INPUT
$ node bin/kn.mjs skill get nosuchref --json
{ "ok": false, "error": "未知 ref: nosuchref（可用: SKILL.md, …）", "code": "INTERNAL" } ← 应为 INVALID_INPUT
```

对照：同一命令走 `badInput()` 的路径（`settings set hacker=1` → `INVALID_INPUT`）是对的。

| 位置 | 意图 | 实际 |
| --- | --- | --- |
| `modules/settings/index.js:39-41` | INVALID_INPUT | INTERNAL |
| `runtime/skill.js:77,83,90` | INVALID_INPUT | INTERNAL |
| `runtime/skill.js:46,98` | NOT_FOUND | INTERNAL |

影响面：HTTP 侧返回 **500 而非 400/404**（`httpStatusOf` 拿到的就是 INTERNAL）；agent 若按 `code` 分支会误判成
「内部错误」。message 文本仍带「需形如」「未找到」等关键词，所以靠字符串匹配的老消费方不受影响 —— 这也是它
一直没被发现的原因。

**修法**：这 5 处改成 `throw badInput(...)` / `throw notFound(...)`（各文件都已 import 或可 import `core/errors`）。

### F3 · `--off` 不存在，`--on` 是静默常驻

`modules/kb/index.js` 的声明只有两个 flag：

```js
flags: { on: { type: 'boolean' }, debounce: { type: 'number', hint: '毫秒' } },
```

但同一文件三处宣称有 `--on/--off`：summary（第 242 行）、文件头注释（第 12 行）、
以及 `run` 内的注释「这样 `nx-kn watch --off` 也能在脚本里按意图表达，不至于莫名其妙挂住终端」（第 251 行）。
`--off` 从未声明，而未知 flag 是硬错误。实测：

```
$ node bin/kn.mjs watch --off
错误: 未知参数 --off（用法见 nx-kn help）      exit 1

$ node bin/kn.mjs watch --on       # 6 秒后仍未退出，stdout / stderr 全空
（仍在运行）
```

`--on` 之所以常驻，是因为 `startWatch` 挂上的 fs watcher 持有事件循环；它不打印任何东西，
也不与 serve 进程内的守护互通（守护状态本来就是进程内的，见 SKILL.md 明确写的这一条）。
也就是说：这组开关在 CLI 上**既无法关闭也无法观察**，是纯粹的无用面。

**修法**：删掉 `--on/--off` 的说法（面板走 HTTP body 的 `{on:false}` 不受影响），或把 `off` 声明上并让
`--off` 打印一句「守护是进程内的，CLI 侧无守护可关」。

### F4 · `pipeline <源名>` 的「只跑该源」只对抓取成立

action 文案：「传源名只跑该源」。实际 `modules/home/service.js`：抓取步骤传了 `name: scope`，
索引步骤固定 `kbSvc.index({ rebuild })` —— 不带 `root`，即**对全部已登记库**跑一遍增量索引：

```js
steps.push({ id: 'index', status: 'ok', result: await kbSvc.index({ rebuild: !!rebuild }) });
```

代码注释解释了动机（「增量索引本来就只碰有变化的库」），行为可接受，但**文案与行为不一致**：
多库时 `pipeline some-source` 的耗时与日志会包含其它库。建议文案改成「传源名只抓该源，索引仍是全局增量」。

### F5 · `nx-kn help` 首屏的模板残留

`runtime/cli.js:33`：

```js
summary: '显示帮助（可跟模块名或命令组，如 nx-nx help repo',
```

实测 `nx-kn help` 输出的「平台命令」一节里就是这一行（少了右括号，且 `nx-nx` 是模板项目名）。
同类残留（**只在注释里，用户不可见**）：`runtime/cli.js:40,185,196,241`、`runtime/api.js:11,68`、
`runtime/spec.js:102`、`core/errors/index.js:26`（提到 git/gh）。
其中 `runtime/spec.js:70` 值得单独修：它把「用法:」契约的出处指向
`assets/repo-hub/references/agent-workflow.md`，而本仓的文档实际在 `assets/nx-kn/`，
照这条注释去核对契约会找不到文件。

### F6 · store.json 解析失败被静默当成「空」

```js
} catch {
  // 文件不存在或损坏：返回空结构（首次运行 / 允许外部修复后恢复）
  cache = normalize(null);
```

`ENOENT` 与「JSON 坏了」走同一个分支。后果不只是「读到空列表」：下一次任何写操作
（`add` / `index` / `crawl run` / `settings set` 都会 `mutateStore`）会把空结构**原子写回原路径**，
原文件内容不可恢复，且全程零报错。用户目录里存在 `store.json.bak-20261004`，说明这个场景真实发生过
（当时是人工备份救的）。建议：只在 `ENOENT` 时返回空结构；解析失败抛错或先 `rename` 成 `.bak-<时间戳>` 再继续。

### F7 · 采集侧两个增量盲点

1. **换引擎不清理旧产物**。`runOneViaNode` 的 `sameEngine = manifest.engine !== ENGINE_SS`：
   换引擎后 `prev` 归零（避免假的「未变」），但**磁盘上另一引擎留下的文件不会被删**。
   于是「先 node 抓、后 ss 重抓」（或反向）之后，同一内容在 `sources/<名>/` 下有两份、两份都进索引。
2. **远端删除的页面留盘**。manifest 的 `pages`（`next`）会丢掉不再出现的 URL，但对应 `.md` 文件留在目录里，
   继续被索引、继续被检索到。加上第 1 条，`sources/` 目录会随使用时间单向增长。

**修法建议**：`crawl run --rebuild` 时以本次结果为准清掉未出现的 `.md`（可保守一点，只清 manifest 曾经记录过、
本次未产出的文件）；或至少在 `crawl list` / 面板里报出「manifest 外文件 N 个」，让用户看得见。

### F8 · 本机 store 里两个库内容重叠（现状事实）

```
kb.vaults = [
  { path: "C:\\Users\\joke\\.nx-kn\\sources\\obsidian-vault", name: "obsidian-vault", model: "local/qwen3-embedding-0.6b" },
  { path: "D:\\Obsidian Vault",                              name: "Obsidian Vault",  model: "local/qwen3-embedding-0.6b" }
]
crawl.sources = [ { name: "obsidian-vault", url: "D:\\Obsidian Vault", kind: "local", pages: 226, via: "skill-seekers" } ]
```

第二条是第一条的**派生物**（skill-seekers 从 `D:\Obsidian Vault` 整理出的 226 页）。两者都在索引里，
所以 `query` 对同一篇笔记大概率给出「同一内容、两个库名」的两条命中，占用 `--limit` 名额。
SKILL.md 已把「跨库去重/合并同一篇笔记」列为不支持项，所以这不是 bug；但它是当前配置下的**实际召回质量损耗**，
要么 `kb remove "D:\Obsidian Vault"`（只留整理产物），要么反过来（只留原库、把采集源当备份）。

### F9 · `hasIndex()` 仍只判目录存在

`core/zg.js:29` 的 `hasIndex` 只 `existsSync(<root>/.zvec-grep)`。`.zvec-grep` 存在但内容损坏时：
`query` 把它算作 usable → `zg query` 失败 → 该库进 `skipped[]`、`hits` 为空 → CLI 渲染「（无命中）」。
信息没丢（skipped 会明说），但主结论容易被误读成「库里没这内容」。对账文档已记 B3 为「部分修」，此为延续项。

### F10 · 默认抓取引擎在本机只剩两条路

实测本机环境：

```
skill-seekers on PATH : (none)
uvx on PATH           : D:\DevTools\uv\uvx.exe
python on PATH        : D:\Python\py_v314\python.exe
NX_KN_SKILL_SEEKERS_CMD: (unset)
```

`core/skill-seekers.js` 的候选链是「env → PATH → uvx」。PATH 上没有，所以默认引擎实际走 `uvx --from skill-seekers`，
或者由用户显式设 `NX_KN_SKILL_SEEKERS_CMD` 指向已装好的 venv。**真实可用性已实测**：

- 用 env 指向 `C:\Users\joke\.nx-kn\skill-seekers-venv\Scripts\skill-seekers.exe` → `available: true, via: env`（可用）。
- 裸 `uvx` 回退路径单独复测：**能跑起来，但首次代价是十几分钟级** —— 实测 20 分钟里陆续下载
  pygments / pillow / numpy(12MB) / networkx / skill-seekers / anthropic / pydantic-core /
  llama-index-core(11.4MB) / sqlalchemy / nltk / cryptography / pymupdf(18.9MB) 等，仍未结束，
  由我手动终止（**未等到结果，如实记录**）。也就是说：不设 `NX_KN_SKILL_SEEKERS_CMD` 的机器上，
  第一次 `crawl run`（默认引擎）会长时间「看起来卡住」，而它其实在下载。这一点值得在文档里写明预期。

这不是代码缺陷（候选链设计正确且错误信息给了两条出路），但它是「换台机器/换 shell 就可能抓不动」的运维前提，
值得写进 README 的上手段落。

---

## 四、验证记录（本次实跑，非推断）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查（含分层约束） | `pnpm run lint` | **0 问题**（exit 0） |
| 前端构建 | `pnpm run build`（vite 6.4.3） | 成功，53 modules，主包 235.16 kB / gzip 74.39 kB |
| 端到端冒烟 | `pnpm run test:smoke` | **15/15 通过**（含 zg 在场分支、Windows 带空格路径引号回归） |
| 单元 + 一致性 | `node --test tests/unit/*.test.mjs` | **100/100 通过**（8 个测试文件） |
| 全链路集成（真起 zg、真建索引、真监听） | `pnpm run test:pipeline` | 见下 |
| 命令表实测 | `nx-kn routes --json` | **24 条 / 5 个模块**（platform, home, settings, kb, crawl） |
| zg 可用性 | `probe()` | 已安装 **0.2.2** |
| skill-seekers 可用性 | `probeSkillSeekers()`（env 指向 venv） | `available: true, via: env` |

全链路集成测试（`NX_KN_PIPELINE_MODEL=local/potion-code-16m-v2`，离线小模型；本地 `node:http` 假文档站；
假 skill-seekers fixture）逐环结果：

```
$ NX_KN_PIPELINE_MODEL=local/potion-code-16m-v2 pnpm run test:pipeline
1..23
# tests 24
# pass 24
# fail 0
# skipped 0
# duration_ms 538539      （≈ 9 分钟）
exit=0
```

源码里 P14（守护）刻意排在 P16b 之后 —— 因为 P9/P13 会把库移除，守护需要先把 vault 重新登记回来；
TAP 子测试编号按**执行顺序**输出，所以看到的是 P13 → P15 → P15b → P16 → P16b → P14 → P17 → P18。
23 个子测试逐环都有断言：

| 环节 | 断言了什么 |
| --- | --- |
| P0 / P0b | skill 落盘且重复安装幂等；`skill get` 一次取到全文 + 安装状态 |
| P1–P5 | 空现场引导 → 加库 → **不给 `--model` 建索引**（默认兜底）→ 状态复检 → 检索命中并**按提示拼出的绝对路径真能读到原文** |
| P3b / P6 | 重复 index 零新增；加一篇后 `added 1 / unchanged 2`（旧向量原样保留 = 真增量） |
| P7 / P8 | 新笔记可召回；加第二库后跨库命中带来源库名 |
| P9 / P13 | `kb remove` 只解登记、索引仍在磁盘；`crawl remove` 默认保留文件与登记、`--purge` 连目录删 |
| P10–P12 | 本地假文档站：sitemap 发现、frontmatter、噪声剔除、抓完自动登记；增量 0 重写 / 改一页只重写那页；抓下来的词可被 index+query 命中 |
| P15 / P15b | 外部引擎后端全链路（假引擎，不联网）；命令不存在时报错并给两条出路，**绝不静默回落** |
| P16 / P16b | 本地目录源整理入库（原始目录只读）；`--engine node` 在 add 与 run 两处都被拒绝 |
| **P14** | 真起常驻 `watch`，往库里写一篇新笔记、**不跑任何 index 命令**，守护自己增量并让该笔记可被检索 |
| P17 / P18 | `pipeline` 串联抓取+索引、结束即可检索、幂等重跑全未变；`pipeline <目录>` 自动登记+整理+索引、同目录重复=增量 |

---

## 五、未覆盖 / 建议下一步

1. **面板 UI 未在真实浏览器实测**。F1 是代码级判定（prop 名不匹配 → filter 恒空 → `return null`），
   逻辑上无悬念；若要把「首页/设置页确实少了那行提示」变成可截图的事实，按既定做法用 CDP 实测一遍。
2. **真实（非 fixture）抓取未跑**。本次只探了引擎可用性，没跑一次真实 `crawl run --engine skill-seekers`
   （会联网、会耗分钟级）；建议在真实站点上跑一次小范围（`--match` + `--max 5`）验证产物形状。
3. **建议的修复顺序**：F2（5 处 error 码，改一行一处、有测试兜底最佳）→ F1（补 CliHints 单命令分支）→
   F3/F5（文案与声明对齐）→ F6（store 损坏区分分支）→ F7（采集清理策略，需要先定策略再改）。
4. **工作区有未提交改动**（9 改 + 2 新增，含高亮切词 `highlight.js` 与其单测、面板头部收成一行、
   加载态 Spinner、crawl 并入 kb tab），CHANGELOG 已写好 [Unreleased] 段落但未提交 —— 修 F1/F2 时可一并归拢。

---

## 六、修复记录（本报告之后的两轮改动）

本节是**事后补记**，上游正文保持审查当时的原样（它的价值是那份快照）。
逐条内容与验证数字见 `CHANGELOG.md` 的 `[Unreleased]` 段落。

**第一轮：F1–F7 / F9 / F10 全部修复。**

| 条目 | 修法 | 关键点 |
| --- | --- | --- |
| F1 | `CliHints` 重写为按 **action id** 查命令表 + 新增单命令形态 | 按 id 而非命令字符串——命令改名后提示跟着变，不再过期 |
| F2 | 5 处改用 `badInput()` / `notFound()` | 新增单测把「非 NxError 上赋 `code` 无效」钉成回归闸门 |
| F3 | `--off` 补声明并给明确语义；`--on` 改走前台路径（**会打印启动信息**） | 原先 `--on` 静默常驻，用户看不到任何反馈 |
| F4 | `pipeline` summary / 注释照实改写 | 只缩**抓取**范围，索引仍是全库增量 |
| F5 | `help` 首屏模板残留、`spec.js` 断裂引用、`api.js`/`errors` 注释示例 | 另修 `help`/`serve` 标题把名字打两遍（`appHead()` 判重） |
| F6 | `loadStore` 区分 `ENOENT` 与解析失败，后者先改名 `store.json.corrupt-<时间戳>` | `health` 顺带真的读一次 store（此前号称「存储可读」却没读过） |
| F7 | 新增陈旧产物清理（只清 manifest 记录过、本次未产出的 `.md`） | **踩过的坑**：`next` 是从上次 manifest 继承的，拿它当保留集合等于什么都没删 |
| F9 | `hasIndex` 升级为「`manifest.json` 非空 + `files.zvec/` 在」 | |
| F10 | README 写明引擎上手前提与三条出路 | |

**第二轮（本节重点）：F8 从「数据取舍」升级为「机制」。**

原先的判断是「同一篇笔记两份命中，需要用户在两个库里二选一」——**这个判断只对了一半**：

- **对的一半**：`kb remove` 产物库**不持久**——`crawl/service.js` 的自动登记条件是
  `produced > 0 && 未登记`，所以删掉它下次 `pipeline` 会加回来。只删源库才稳定。
- **错的一半**：不需要用户二选一，也不需要靠内容相似度猜。谱系**已经躺在 store 里**：
  `crawl.sources[].url` 是源目录，产物目录 = `sourceDirOf(源名)`。两条都是自己写下的值。

落地为「预防 + 解析」两层，判据完全确定：

- `core/store.js` 新增 `crawlProductVaults()` / `standbyVaults()`；`kb.vaults[]` 加 `origin`
  （`'crawl'` / `'user'` / `null` 三态，`null` 才允许被推导兜底）。
- `kb/service.js` 的 `resolveVaults()` 拆成 `vaults` / `standby`；`index` / `query` / `status` / `watch`
  是它的全部调用方，一处生效。
- 启用复用**已有命令** `kb add <产物路径>`（把 `origin` 提成 `'user'`），不新增 `kb standby`。
- 安全边界：**只有「源目录也是登记库」时才抑制**。web 源、源目录未登记的本地源都不抑制——
  收起来等于内容凭空消失。

**本机实测（真实 store，只读）**：`kb list` 报「共 2 个知识库（其中 1 个默认不参与检索）」；
`query "前端流程"` 输出 `检索了 1 个库`，并把产物印成独立的 `未参与 [obsidian-vault] …` 行；
`--root` 指向产物库可临时绕过。**磁盘上没有任何文件被改动。**

**顺带发现的真实差异**（值得知道）：源库 `D:\Obsidian Vault` 可索引 173 篇（另 1 个克隆仓库 48 篇、
5 篇空文件被 zg 默认跳过），而产物是 226 篇——**226 = 173 + 48 + 5**，即产物把 zg 刻意不收的
克隆仓库也收了。所以「留源库」同时意味着那 48 篇克隆仓库内容不再出现在检索里；
这与 zg 的默认口径一致（克隆来的仓库不算你的笔记），但确实是内容增减，不是纯去重。

**验证数字**：lint 0 · build 成功 · smoke 15/15 · unit **130/130**（新增 `vault-lineage.test.mjs` 11 条）·
`test:pipeline` **26/26**（新增 P19）。
