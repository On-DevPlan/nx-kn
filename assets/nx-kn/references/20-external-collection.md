# 20 · 外部资料采集域（crawl）

> 本文讲**怎么用**这一域：把 vault 之外的文档站抓下来、清洗成 markdown 入知识库。
> 「这一域内部怎么改代码」属于项目仓库的 README，不在随包手册里。

## 一、一句话

**抓取产物落成普通 markdown 目录，再当作一个知识库登记。** 于是索引（zg）、
检索、增量、多库合并、面板展示全部复用 kb 域 —— 采集域只负责「URL → 干净 markdown」。

```
文档站 URL
   │  nx-kn crawl add <url> --name <名> [--engine E]
   │  nx-kn crawl run
   ▼
抓取引擎（默认 skill-seekers，外部进程；--engine node 用内置纯 Node 抓取）
   ▼
<数据目录>/sources/<名>/**/*.md      ← 清洗后的 markdown（带 frontmatter）
   │  （抓完自动登记为知识库，与手动 kb add 完全同构）
   ▼
nx-kn index ──▶ zg 索引 ──▶ nx-kn query（CLI / 面板，多库合并）
```

数据目录默认是 `~/.nx-kn/`（`NX_KN_STORE` 可整体搬走，sources 跟着走）。

## 二、命令

```bash
nx-kn crawl add https://vitepress.dev/guide/ --name vitepress   # 登记采集源（不抓），默认引擎 skill-seekers
nx-kn crawl add <url> --name x --engine node                    # 或显式用内置引擎（零外部依赖）
nx-kn crawl run --name vitepress                                # 抓取（默认增量）
nx-kn crawl run --name vitepress --engine node                  # 临时换引擎（不改源上存的）
nx-kn crawl list                                                # 源列表 + 引擎 + 上次抓取统计
nx-kn crawl remove vitepress                                    # 解登记（保留文件）
nx-kn crawl remove vitepress --purge                            # 连抓下来的目录一起删
```

- `add` 的 `--name` 省略时从地址推导（`vitepress.dev/guide` → `vitepress-dev-guide`）
- `add` 只登记，**不抓**；`run` 才联网
- `run` 不带 `--name` 就是**全部源**；`--engine` 可对单次运行临时覆盖（源上存的引擎不变）
- `remove` 默认**只解登记**：抓下来的目录与 zg 索引留着（它同时还是一个知识库）；
  `--purge` 才连文件一起删，并撤掉知识库登记

## 三、两个引擎怎么选

| | `skill-seekers`（默认） | `node`（内置） |
| --- | --- | --- |
| 前置条件 | 本机 **Python 3.10+**（pip 装过 `skill-seekers`）或 **uv/uvx** | **无**（npm 装上即可用） |
| 首次调用 | PATH 上有就直接跑；没有就经 `uvx` 免安装拉起（**首次联网下载约 50 MB** 依赖） | 立即 |
| 抓取范围 | 由 Skill Seekers 自己决定（无页数上限） | sitemap 优先、同源 BFS 兜底，`--max`（默认 200）封顶 |
| 内容清洗 | 它的清洗与分类 | 见 §五 |
| LLM 增强 | `--enhance-level 1-3` 可让它调 agent 增强内容（见 §四） | 无 |
| 适合 | 有 Python 环境、要它的分类/增强产物 | 离线、CI、或机器上没有 Python |

- **换引擎不需要重抓**：两个引擎写的是同一个源目录，增量按内容哈希判定（§六）。
  切换后第一次 `run` 会因为「引擎变了」把全部页面当作更新重写一遍。
- **不静默回落**：默认引擎起不来时直接报错并给出两条出路（装它 / `--engine node`），
  绝不偷偷换引擎抓出一份「和上次口径不一致」的结果。
- 环境变量 **`NX_KN_SKILL_SEEKERS_CMD`** 是逃生舱：值是可执行文件路径，或 JSON 数组
  （如 `["uvx","--from","skill-seekers","skill-seekers"]`）。适合 skill-seekers 装在
  不在 PATH 上的 venv 里、或想精确控制调用的场合。设了它就**只用**它，不再回退。

## 四、增强级别（仅 skill-seekers 引擎）

`crawl add --enhance-level <0-3>`（默认 **0**）：

- `0` = **纯抓取**，不调任何 LLM —— 非交互、可 CI、可复现
- `1-3` = 抓取后调外部 agent（默认 claude，`--agent` 可换）对内容做增强。
  需要本机有对应 agent CLI 与凭据；**非交互环境下级别 > 0 容易卡住或失败**，
  只在你明确想要增强产物时使用

## 五、抓取范围与礼貌（node 引擎）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 发现方式 | **sitemap 优先** | 先取 `<站点根>/sitemap.xml`；是 `sitemapindex` 就递归钻（限深 3 层）；没有则回退**同域 BFS** |
| 边界 | **只抓同源** | 协议 + host + 端口都一致才抓。文档站常链到 GitHub / npm，跟着爬会跑出站点 |
| 页数上限 | 200 | `crawl add --max <n>` 可改 |
| 路径过滤 | `**`（全部） | `crawl add --match '/guide/**'` 只留某一段。skill-seekers 引擎下**同样适用**（在落盘文件名空间上过滤） |
| 并发 | **串行**（不并发） | 不去打爆别人的站点 |
| 间隔 | 300ms | `NX_KN_CRAWL_DELAY_MS` 可改（测试用 0） |
| 单请求超时 | 20s | 单页失败不中断整轮 |
| UA | `nx-kn (+https://github.com/On-DevPlan/nx-kn)` | 表明身份，站点可据此封禁 |

## 六、清洗规则（node 引擎，HTML → markdown）

- 正文容器优先 `main` → `article` → `[role=main]` → `#content` → `.theme-default-content`
  （VitePress）/ `.vp-doc` / `.markdown-body`（GitHub 系）/ `.md-content`（mkdocs-material）→ `body`
- 剔除版式噪声：`nav` / `footer` / `header` / `aside` / `form` / `button`、
  侧栏与目录树（`.sidebar` / `.toc`）、面包屑、上下页、编辑链接、`script` / `style`、
  **图片**（检索用不到，CDN 绝对 URL 是噪声）
- 相对链接 / 图片转**绝对 URL**；表格转 GFM 表格（`| a | b |`）
- 每个页面 → 一个 `.md`，带 frontmatter：

```yaml
---
source: https://vitepress.dev/guide/getting-started
title: Getting Started
fetchedAt: 2026-10-04T05:20:00.000Z
---
```

skill-seekers 引擎的落盘文件沿用它的清洗结果（外加同样的 frontmatter），不二次清洗。

## 七、增量是怎么判定的

**按内容哈希，而不是时间戳。** 每个文件算「正文」的 sha256，与清单里上次的
哈希比对：一致就**不写文件** —— 不写文件 mtime 就不动，后续 `nx-kn index` 会如实报
`unchanged`，不重复嵌入。

- frontmatter 里的 `fetchedAt` 每次都变，所以**哈希只算正文**
- 第二次抓取无变更 → `新增 0 / 更新 0 / 未变 N`；改了一页 → 只重写那一页
- `crawl run --rebuild` = 无视已存哈希、全部重写（改了抓取范围或换了引擎后想强制刷新时用）；
  注意它只影响**抓取**，zg 索引侧仍要再跑 `nx-kn index`（如换了 embedding 模型还需 `--rebuild`）

## 八、落盘布局

```
<数据目录>/
├── store.json                      # crawl.sources[]（与 kb.vaults 分列）
└── sources/
    └── <名>/
        ├── .nx-kn-crawl.json       # 采集清单：每页 url → { file, hash }，含 engine
        ├── index.md
        └── guide/getting-started.md
```

`.nx-kn-crawl.json` 以 `.` 开头 → zg 默认不扫（不污染索引），也是**增量的唯一依据**。
skill-seekers 的中间产物（SQLite 索引、缓存等）留在系统临时目录里，**不会**混进知识库 ——
抓完只把 `.md` 摘进来。

## 九、排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `找不到 skill-seekers（已尝试…）` | 机器上没有 Python/uv，或都不在 PATH | 按报错里给的两条路：`pip install skill-seekers`（需 Python 3.10+）或装 uv；或者干脆 `--engine node` 用内置引擎 |
| 只是 `crawl list` 却卡了很久 | uvx 首次拉起要联网下载约 50 MB 依赖 | 先跑一次真抓取让它装好；或装好 skill-seekers / 用 `NX_KN_SKILL_SEEKERS_CMD` 指到现成安装 |
| `skill-seekers 抓取失败` | 它的业务失败（站点不可达 / 需要 JS 渲染等） | 看报错里带的 stderr 摘录；可按提示 `crawl run --name <名> --engine node` 换内置引擎重试 |
| uvx 报 `os error 5`（拒绝访问） | uv 缓存目录被占或权限异常 | 设 `UV_CACHE_DIR` 指到可写目录再跑 |
| `没有抓到任何页面` | 起始地址不可达 / 返回非 HTML / 需要 JS 渲染 | 确认地址可访问、是静态 HTML；SPA 文档站两个引擎都不支持 |
| 抓到页数远少于预期（node） | sitemap 缺失 + 同域链接少 | 看 `crawl run --json` 的 `results[].via`（`sitemap` / `bfs`）与 `failed` |
| 页数被截断在 200（node） | 默认 `--max 200` | `crawl add --max 500` 重建该源 |
| 一页失败（404/超时） | 单页问题 | 不中断整轮；`failed` 计数与具体 URL 在 `crawl run --json` 的 `results[].failures` |
| 抓完在 `kb list` 里看不到 | 只登记有内容的源 | 确认 `crawl run` 真的抓到了页（`crawl list` 的 `pages` > 0） |
| 抓下来想改名/换范围/换引擎 | 源名即目录名 | `crawl remove` 再 `crawl add`（`--purge` 可顺手清掉旧目录） |
| 想删掉整个源的数据 | | `nx-kn crawl remove <名> --purge` |

## 十、为什么不这么做（常见疑问）

**为什么默认引擎要外部程序？** Skill Seekers 的抓取/分类/增强能力比内置实现强得多
（18 种数据源、可选 LLM 增强），把它设为默认意味着「有它就用最好的」。同时内置的
`--engine node` 保证**没有 Python 的机器依旧开箱可用** —— 默认值是能力优先，不是依赖强制。

**为什么失败不静默换回 node 引擎？** 两个引擎的抓取范围与清洗口径不同，静默回落会
产出「和上次不一致」的结果而你毫无察觉。宁可报错、把选择权留给你。

**为什么不把 Skill Seekers 打进 npm 依赖？** 它是 Python 项目，npm 装不了它；
把它变成本包的硬依赖会让「`npm i nx-kn` 即可用」失效。

**为什么不支持需要登录 / 验证码的站点？** 那需要会话与浏览器，属于另一个问题域，
不在本版本范围。

**为什么不做定时抓取（守护）？** 与 kb 域同一口径：watch 留待后续版本。当前是
「跑一次 `crawl run`」的显式动作。
