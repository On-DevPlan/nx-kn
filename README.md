# nx-kn

Obsidian 知识库检索（zg 引擎）

```bash
pnpm install
pnpm start    # 构建并启动面板
```

## 它是什么

把本机的若干 Obsidian vault 当成知识库，用 [zvec-grep](https://github.com/zvec-ai/zvec-grep)（CLI 名 `zg`）
做「精确 + 关键词 + 语义」混合检索。可以加多个目录，检索时逐库召回、
按融合分（RRF）合并成一张列表，每条标出所属库。本机工具：CLI 与 Web 面板共享同一份
action 声明（`src/modules/*/index.js`），一条命令三端同源——CLI、HTTP API、面板按钮不会分叉。

需要时还能把 **vault 之外的文档站抓下来**：`crawl run` 抓取、清洗成 markdown、
落成普通目录并**自动登记为知识库**，于是索引 / 检索 / 增量 / 多库合并全部复用 kb 域。
抓取引擎二选一（`--engine`）：默认 `skill-seekers`（外部 Python 引擎，需本机
Python 3.10+ 或 uv；抓取/分类能力更强，可选 LLM 增强）；`node` 为内置纯 Node 引擎
（零外部依赖，离线可用）。

索引也可以**自动跟上**：`nx-kn watch` 常驻监听各库，笔记一变就自动跑增量索引；
`nx-kn serve` 起的面板里**默认已开**这道守护，面板上能看最近刷新、随手开关。

| | |
| --- | --- |
| CLI 命令表 | `nx-kn help`（或 `routes` 看命令 ↔ 路由对照） |
| Web 面板 | `pnpm start` 后打开 `http://127.0.0.1:7881` |
| 数据 | `~/.nx-kn/store.json` + `~/.nx-kn/sources/`（原子写；环境变量 `NX_KN_STORE` 覆盖，sources 跟着走） |
| 索引 | 每个库各自的 `<vault>/.zvec-grep/`（由 zg 拥有） |
| 自检 | `nx-kn health` |

### 上手

```bash
npm install -g @zvec/zvec-grep        # 召回引擎（需 Node ≥ 22）
nx-kn kb add D:\Obsidian Vault        # 加一个知识库（可加多个，写进 store.json）
nx-kn kb list                         # 看有哪些库
nx-kn index                           # 建索引（默认增量、只收 md；每个库一份）
nx-kn query "登录页为什么提示超时"      # 跨全部库检索
nx-kn status                          # 各库的索引状态 / 生效模型 / 覆盖度
```

抓一个文档站（静态 HTML）：

```bash
nx-kn crawl add https://vitepress.dev/guide/ --name vitepress   # 登记采集源（不联网），默认引擎 skill-seekers
nx-kn crawl add <url> --name x --engine node                    # 没有 Python？显式用内置引擎
nx-kn crawl run --name vitepress                                # 抓取 + 清洗成 markdown（默认增量）
nx-kn index                                                     # 抓下来的目录已自动登记，直接建索引
nx-kn query "怎么配置主题"                                       # 与本地 vault 一起被检索
nx-kn crawl remove vitepress --purge                            # 不要了：连文件一起删
```

把本地目录（如 Obsidian vault）整理入库——与文档站同一条流水线：

```bash
nx-kn crawl add "D:\Obsidian Vault" --name myvault   # 磁盘上存在的目录即本地源（kind=local）
nx-kn crawl run --name myvault                        # skill-seekers 整理成结构化 markdown，原始目录只读
nx-kn index                                            # 产物已自动登记为知识库，建索引
nx-kn query "笔记里写了什么"                            # 检索整理产物
```

本地目录源只支持 skill-seekers 引擎（`--engine node` 会被拒绝）；要不要保留原库的
`kb add` 登记自便——只想用整理产物检索时 `kb remove <原路径>` 解除原库即可。

嫌两条命令麻烦？**一键流水线**把「抓取 → 索引」串完（抓取和索引是前后关系，
不是选择关系；首页面板的「一键跑流水线」按钮就是这条链）：

```bash
nx-kn pipeline          # 抓取全部源（增量）→ 更新全部索引（增量），跑完即可检索
nx-kn pipeline <目录>    # 提供目录就直接抓取该目录：未登记自动登记，已登记增量重跑
```

`query` 的输出带一段归属头（每个库的根 + 库名）；多库时命中带 `[库名]` 前缀，
agent 拿到后可以拼出绝对路径去读全文。`--json` 给结构化 `hits[]`
（`path / start / end / heading / snippet / matchedBy / score / vault / vaultName`）。

`index` 不带 `--rebuild` 就是**增量**（zg 默认行为：只嵌入新增/改动的文件）；
只有换 embedding 模型才需要 `--rebuild`。面板上也分成「更新索引」与「重建索引」两个按钮。

## 结构

```
src/
├─ core/      基础设施：paths（参数化中心）/ errors / store（JSON 持久化）/ zg（召回引擎驱动）/ web（HTML→markdown 等纯函数）/ watch（文件监听基元）/ open
├─ modules/   功能域，各含 index.js（action 声明）+ service.js（业务）+ view.jsx（面板）
│   ├─ home/       示例域（读路径）
│   ├─ settings/   示例域（写路径：面板表单 → POST → mutateStore → CLI 同源可读）
│   ├─ kb/         知识库域：kb add / kb remove / kb list + index / query / status + watch（守护）
│   └─ crawl/      资料采集域：crawl add / run / list / remove（抓文档站 → markdown → 当知识库）
├─ runtime/   装配：registry（action 汇合）/ cli / api / server / spec
└─ web/       React 面板壳（vite 构建，产物被零依赖 node:http 服务）
docs/
└─ plan/      计划文档与「计划 ↔ 实现」对账记录
```

模块之间禁止互相依赖（eslint 枚举式禁列 + 一致性测试强制），共享逻辑下沉 `core/`。

## 加一个功能域要碰哪几处

以 `kb` 域为例（A07 闭环清单），漏掉带 ❗ 的几处**不会报错**，只会静默失效：

| # | 落点 | 漏了会怎样 |
| --- | --- | --- |
| 1 | `src/modules/<域>/{service,index,view}` | 功能不存在 |
| 2 | `src/runtime/registry.js` 的 `MODULES` | 模块整个不生效（一致性测试会红） |
| 3 | `src/web/frontend/registry.js` 的 `VIEWS` | 面板少一个 tab（一致性测试会红） |
| 4 | `src/index.js` 的 `export * as <域>` | 库用方拿不到 service ❗**无断言** |
| 5 | `eslint.config.js` 的 files + group 禁列 | 模块互依规则对它失效 ❗**无断言** |
| 6 | `tests/unit/*`（纯逻辑）、`tests/smoke.mjs`（只读路径）、`tests/pipeline.mjs`（真起 zg 的全链路） | 端到端坏了没人知道 |
| 7 | `assets/nx-kn/`（SKILL.md + references） | agent 永远不知道这条命令存在 ❗**单向断言** |
| 8 | `README.md` / `CHANGELOG.md` | 文档与实际脱节 |

纯逻辑（如 zg 输出解析）必须下沉到 `core/` 并配单测，否则 CI 上跑不到。


## 开发

```bash
pnpm dev            # vite + serve 双进程，一个 ctrl-c 一起退
pnpm test           # 快检：lint + build + smoke + unit（秒级，不需要 zg）
pnpm test:pipeline  # 全链路：skill 安装 → 建库 → 建索引 → 检索 → 增量 → 多库（需 zg，真建索引）
pnpm test:all       # 上面两个连着跑
pnpm logo           # 手动重出 logo（svg + png + ico 全套）
```

`test:pipeline` 是「skill 装完之后这一整串事能不能自动做完」的可执行证明。
它隔离出一份临时 store / skills 目录 / vault，然后逐步断言：skill 落盘且幂等、
空现场把用户引到 `kb add`、加库、**不给 `--model` 也能建索引**（默认兜底）、
检索命中后按提示拼出的绝对路径真能读到原文、增量只嵌新文件（旧向量保留）、
多库合并命中带来源库名、`kb remove` 只解登记不删索引。

采集链路也在里面：起一个 `node:http` **本地静态「文档站」**（带 sitemap、导航/页脚噪声、
每页独有词），跑 `crawl add` → `crawl run` → 断言 sitemap 发现、三页落盘带 frontmatter、
导航页脚被剔除、**抓完自动登记为知识库** → 再跑一次断言「内容未变 0 重写」、
改一页后断言「只重写那一页」→ `index` + `query` 命中抓下来的词并能读到原文 →
`crawl remove` 默认保留文件与知识库登记、`--purge` 连目录删。**全程不联网**，
CI 不会因为别人的站点波动而红。

每一步是一个独立子测试，失败能直接看出卡在哪一环。CI 与发版流水线都会跑它，
用 `NX_KN_PIPELINE_MODEL=local/potion-code-16m-v2` 指一个小模型省下载。

运行时依赖只有 `react` / `react-dom`（面板）与 `cheerio` / `turndown`（+`turndown-plugin-gfm`，采集侧 HTML→markdown）；
zg 是外部引擎，通过 npm 全局安装，不在本包依赖里。

## 发版

tag 幂等 + npm provenance 见 `.github/workflows/npm-publish.yml`：推 tag 到 main，
CI 自动构建、测试、跑全链路流水线、`npm publish --provenance`（需要 `NPM_TOKEN` secret）。
