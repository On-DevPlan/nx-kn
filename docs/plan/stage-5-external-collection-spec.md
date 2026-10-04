# 阶段 5 独立 spec — 外部资料采集（爬虫）

> 本文件是 `nx-kn-plan.md` §4「阶段 5」的展开。该节原文的前置条件写着
> 「**启动前把本节展开为独立的 spec**」——本文件即履行该门禁。
>
> 状态：**已实现**（2026-10-04）。三项核心决策按 §1 的建议值落地：
> **D1 纯 Node**、**D2 首个数据源 = 静态 HTML 文档站**、**D3 引入 `cheerio` + `turndown`(+`turndown-plugin-gfm`)**、
> **D4 JS 渲染 MVP 不做**。代码在 `src/modules/crawl/` + `src/core/web.js`，
> 使用手册见随包 `assets/nx-kn/references/20-external-collection.md`。
> §1 保留为决策依据（为什么推翻原计划的 Python 子进程），不再改动。

---

## 0. 现状盘点（2026-10-04 实测）

| 事实 | 证据 |
| --- | --- |
| 仓库**没有任何爬虫代码** | 全仓搜 `crawl｜spider｜cheerio｜puppeteer｜playwright｜jsdom` **零命中** |
| 运行依赖只有 `react` / `react-dom` | `package.json`（仅面板需要） |
| nx-kn 是**纯检索**、不联网 | zg 只读本地 vault / 已加目录里的 `.md` |
| 已发布到 npm | `nx-kn@0.1.0`（`dist-tags.latest = 0.1.0`） |
| 外部进程已有纪律可复用 | `src/core/zg.js`：spawn 引号规则、拒绝 `"`/`%`、**永不抛异常**只回 `{ok,code,stdout,stderr}`、解析函数一等公民且有单测 |

**一句话定位**：本阶段把**vault 之外的资料源**清洗成 markdown 入知识库，再走同一套 zg 索引。

---

## 1. 待确认的核心决策

### D1 · 运行形态：纯 Node（**建议**） vs Node → Python 子进程（原计划）

原计划把「进程形态 = Node 主进程 → Python 子进程，stdio 通信」写成了既定项。逐条复核其依据：

| 原计划的理由 | 复核结果 |
| --- | --- |
| 「借 [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) 思路」 | Skill Seekers 确实是 Python，但 §7 已明确**不引入为依赖**。要借的是「抓取与清洗**思路**」，与实现语言无关 → 不构成需要 Python 的理由 |
| 「Python 侧实践参考 rt：scraper / playwright / OCR」 | **实测 rt 的抓取栈**：简单站点用 `httpx + bs4`（`anime_season/yuc.py`、`sicau_timetable/service.py`），`playwright.async_api` **只出现在登录+验证码场景**（`sicau_timetable_v2/browser.py`）。**公开文档站两者都不需要** → 该参考在这里没有对应问题 |
| （隐含）「抓取需要浏览器渲染」 | `playwright` 有**一等公民的 Node 包**，渲染不构成 Python 的必要条件 |

成本对比：

| 维度 | 纯 Node | Python 子进程 |
| --- | --- | --- |
| 用户安装 | `npm i -g nx-kn` 一步 | 额外要 Python 3.10+、venv、pip 依赖；若需渲染还要 playwright 浏览器（约百 MB） |
| 与已定目标一致 | ✅「装上即可用、不需要用户额外手动操作」 | ❌ 直接冲突 |
| 项目形态 | 保持单一 Node 运行时；`core/zg.js` 的进程纪律可复用 | 新增 Python 资产打包、B05 stdin 协议、跨平台解释器发现、错误映射 |
| 打包 / CI | 不变 | 要管 Python 版本与 wheel；CI 需装 Python |
| 面板/CLI 一致性 | 与现有 action 模型同源 | 跨语言边界需另立约定 |

**建议：纯 Node。** 若将来确实需要 Python（如 PDF / OCR），再按 `B05-multi-line-cli-input` 以**可选旁路**加入，而不是把 Python 设为主干前提。

> **若维持原计划的 Python 子进程**：§2 数据流、§5 抓取实现、§7 测试三节需按 B05 重写，
> 并新增「Python 解释器探测 / 依赖安装 / 资产打包」三块内容。请明确指示。

### D2 · 首个数据源：文档站（**建议**）

计划自己举的例子就是「单个文档站」。理由：公开、无鉴权、URL 结构规整（VitePress / Docusaurus /
mkdocs 等一律是静态 HTML）、多数带 `sitemap.xml`。

GitHub 仓库、PDF、本地 HTML 留作后续源类型。

### D3 · 依赖策略：允许 1~2 个成熟解析库（**建议**）

HTML → Markdown 的可靠转换**不适合手写**。候选：

- `cheerio` —— HTML 解析 + 选择器（正文抽取、去导航）
- `turndown` —— HTML → Markdown
- 页面抓取用 Node 内置 `fetch`（18+），**不需要额外依赖**

备选「零依赖自研」：只对结构规整的文档站用正则/状态机抽正文。**脆弱、且站点一改就崩**，不建议。

### D4 · JS 渲染：MVP 不做（可后续加）

先只收静态 HTML。确有站点必须跑 JS 时再评估 `playwright`（Node 包，体积可控地按需安装）。

---

## 2. 数据流（与现有架构的关系）

```
文档站 URL
   │  nx-kn crawl add <url> --name <n>
   │  nx-kn crawl run
   ▼
~/.nx-kn/sources/<name>/**/*.md          ← 清洗后的 markdown（带 frontmatter）
   │  （抓完自动登记为知识库，复用 kb 域，零特化）
   ▼
kb add  →  store.kb.vaults[]  ← 与手动添加的 vault 完全同构
   │  nx-kn index
   ▼
zg 索引（<sources>/<name>/.zvec-grep/）
   │  nx-kn query
   ▼
CLI / Web 面板（多库合并，命中带来源库名）
```

**设计要点**：抓取产物落成**普通 .md 目录**，并作为 vault **自动登记**。
于是索引、检索、增量、多库合并、面板展示**全部免费复用**——crawler 只负责「URL → 干净 markdown」。
这是整个方案能保持「一丢丢」的关键。

---

## 3. 命令面

沿用现有约定：**一处声明同时派生 CLI / HTTP / help**（见 `src/modules/kb/index.js`）。
新模块 `crawl`（`title: 资料采集`，`order: 20`，排在 kb 之后）。

| action id | cli | http | 说明 |
| --- | --- | --- | --- |
| `crawl.add` | `crawl add <url> --name <n> [--match <glob>] [--max <n>]` | `POST /api/crawl/add` | 登记一个采集源（按 `url + name` 去重） |
| `crawl.run` | `crawl run [--name <n>] [--rebuild]` | `POST /api/crawl/run` | 抓取并落成 md；**默认增量**（只重写内容变更的页面） |
| `crawl.list` | `crawl list` | `GET /api/crawl/list` | 源列表 + 上次抓取时间 / 页数 / 失败数 |
| `crawl.remove` | `crawl remove <name>` | `POST /api/crawl/remove` | 解登记（**默认保留**已抓文件与索引） |

统一动词口径与 kb 域对齐：`add/list/remove/run`，`run` 对应 kb 的 `index`。

---

## 4. 落盘与元数据

```
~/.nx-kn/
├── store.json                      ← 新增 crawl.sources[]（与 kb.vaults 分列，互不干扰）
└── sources/
    └── <name>/
        ├── .nx-kn-crawl.json       ← 采集清单（见下）
        ├── index.md
        └── guide/getting-started.md
```

`.nx-kn-crawl.json` 记录：源 URL、`name`、上次抓取时间、`include` glob、`max`、
以及**每页的 `url → { file, hash }` 映射**（增量的唯一依据）。

每个页面 → 一个 `.md`，带 YAML frontmatter：

```yaml
---
source: https://example.com/guide/getting-started
title: Getting started
fetchedAt: 2026-10-04T05:20:00.000Z
---
```

---

## 5. 抓取与清洗

- **发现**：优先 `sitemap.xml`（含 sitemap index 递归）；回退方案为从起始 URL **同域 BFS**，
  受 `--match`（默认 `**`）与 `--max`（默认 200）双重限制。
- **礼貌**：串行（不并发，避免打爆站点）、请求间隔默认 300ms、单请求超时 20s、
  自定义 UA（标识自身）、**只抓同域**。
- **正文抽取**：优先级 `main` → `article` → `[role=main]` → `body`；剔除
  `nav/footer/header/aside/script/style/.sidebar`；相对链接转绝对。
- **去重/增量**：以「清洗后 markdown 的内容哈希」为准；**内容未变则不写文件**，
  从而让后续 zg 增量索引如实报 `unchanged`。
- **失败隔离**：单页失败不中断整轮，计入 `failed` 并在 render 里报出具体 URL。

---

## 6. 错误与边界（沿用现有约定）

- 网络/解析失败 → `external()`；参数不合法 → `badInput()`（`src/core/errors/index.js`）
- 站点不可达 / robots 禁止 / 起始 URL 返回非 HTML → **明确报错**，绝不静默产出空目录
- 抓取结果为空 → 按 `INVALID_INPUT` 处理（**绝不建出空内容的源**，与 B05 同一条纪律）
- `name` 冲突、`url` 重复 → 报错并提示已有源，不覆盖

---

## 7. 测试（对齐现有三层，**全部不联网**）

| 层 | 内容 |
| --- | --- |
| 单测 | sitemap 解析（含 index）、HTML→MD 转换（本地 fixture 逐字节断言）、URL 归一化与同域判定、增量哈希判定、`--match` glob |
| 冒烟 | 用 `node:http` 起**本地静态「文档站」**，全链路 crawl → md → `kb add` → `index` → `query` 命中 |
| 流水线 | 把 crawl 步**并入 `tests/pipeline.mjs`** —— 保证 CI 不联网也能跑完整链路 |
| 面板 | 资料采集页（源列表 + 添加 + 抓取按钮）；沿用 `.card/.row/.tag/.kv/.colhead` 原子类与四层 CSS |

**为什么强调不联网**：现有 `test:pipeline` 的目标就是「CI 可复现全链路」。
若测试依赖外部站点，CI 会因别人的站点波动而红——那是把不确定性引进门。

---

## 8. 验收标准

- [ ] `crawl add <url> --name docs` → `crawl run` 产出 md，`crawl list` 可见页数
- [ ] 抓完自动出现在 `kb list`，与手动添加的 vault **完全同构**
- [ ] `nx-kn query "<只在被抓文档里出现的词>"` 命中，路径指向 `sources/<name>/`
- [ ] 第二次 `crawl run` 无变更 → **0 文件改写**；改一页 → 只重写该页
- [ ] 单页 404/超时不影响整轮，`failed` 计数与 URL 可见
- [ ] `pnpm run test:all` 全绿，且 `test:pipeline` 覆盖 crawl 步（不联网）
- [ ] 面板可完成「添加源 → 抓取 → 看到页数」，无 JS 报错

---

## 9. 决策记录与回填（实现后必做）

- 若 D1 改判为**纯 Node**：需回填 `nx-kn-plan.md` 阶段 5 的「进程形态」行与 §7「不做」清单，
  并在「决策修正」处记一条（该节的「参考实现」段落另行保留为纯阅读参考）。
- D3 若引入依赖：记入 `package.json`、`README.md`、`CHANGELOG.md`。
- `assets/nx-kn/references/` 增补一节「外部资料采集」，并把新命令补进 `SKILL.md`。
- 新命令需通过一致性测试「skill 文档里出现的每条 `nx-kn` 命令都能解析到真实命令」。

---

## 10. 明确不做（与 plan §7 一致）

- 不做 LLM 问答（RAG）、不做 wikilink 图谱、不做图片/PDF 多模态索引
- **不把 Skill Seekers 引入为依赖**（仅作参考实现阅读）
- MVP 不做 JS 渲染；不做需要登录/验证码的站点；不做全站镜像
- 不做爬虫的定时守护（沿用阶段 4 的口径：watch 留 v0.2）
