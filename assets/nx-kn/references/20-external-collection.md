# 20 · 外部资料采集域（crawl）

> 本文讲**怎么用**这一域：把 vault 之外的文档站抓下来、清洗成 markdown 入知识库。
> 「这一域内部怎么改代码」属于项目仓库的 README，不在随包手册里。

## 一、一句话

**抓取产物落成普通 markdown 目录，再当作一个知识库登记。** 于是索引（zg）、
检索、增量、多库合并、面板展示全部复用 kb 域 —— 采集域只负责「URL → 干净 markdown」。

```
文档站 URL
   │  nx-kn crawl add <url> --name <名>
   │  nx-kn crawl run
   ▼
<数据目录>/sources/<名>/**/*.md      ← 清洗后的 markdown（带 frontmatter）
   │  （抓完自动登记为知识库，与手动 kb add 完全同构）
   ▼
nx-kn index ──▶ zg 索引 ──▶ nx-kn query（CLI / 面板，多库合并）
```

数据目录默认是 `~/.nx-kn/`（`NX_KN_STORE` 可整体搬走，sources 跟着走）。

## 二、命令

```bash
nx-kn crawl add https://vitepress.dev/guide/ --name vitepress   # 登记采集源（不抓）
nx-kn crawl run --name vitepress                                # 抓取（默认增量）
nx-kn crawl list                                                # 源列表 + 上次抓取统计
nx-kn crawl remove vitepress                                    # 解登记（保留文件）
nx-kn crawl remove vitepress --purge                            # 连抓下来的目录一起删
```

- `add` 的 `--name` 省略时从地址推导（`vitepress.dev/guide` → `vitepress-dev-guide`）
- `add` 只登记，**不抓**；`run` 才联网。两者分开是为了让「先看看要抓什么」不必付网络代价
- `run` 不带 `--name` 就是**全部源**
- `remove` 默认**只解登记**：抓下来的目录与 zg 索引留着（它同时还是一个知识库）；
  `--purge` 才连文件一起删，并撤掉知识库登记

## 三、抓取范围与礼貌

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 发现方式 | **sitemap 优先** | 先取 `<站点根>/sitemap.xml`；是 `sitemapindex` 就递归钻（限深 3 层）；没有则回退**同域 BFS** |
| 边界 | **只抓同源** | 协议 + host + 端口都一致才抓。文档站常链到 GitHub / npm，跟着爬会跑出站点 |
| 页数上限 | 200 | `crawl add --max <n>` 可改 |
| 路径过滤 | `**`（全部） | `crawl add --match '/guide/**'` 只抓某一段 |
| 并发 | **串行**（不并发） | 不去打爆别人的站点 |
| 间隔 | 300ms | `NX_KN_CRAWL_DELAY_MS` 可改（测试用 0） |
| 单请求超时 | 20s | 单页失败不中断整轮 |
| UA | `nx-kn (+https://github.com/On-DevPlan/nx-kn)` | 表明身份，站点可据此封禁 |

## 四、清洗规则（HTML → markdown）

- 正文容器优先 `main` → `article` → `[role=main]` → `#content` → `.theme-default-content`
  （VitePress）/ `.vp-doc` / `.markdown-body`（GitHub 系）/ `.md-content`（mkdocs-material）→ `body`
- 剔除版式噪声：`nav` / `footer` / `header` / `aside` / `form` / `button`、
  侧栏与目录树（`.sidebar` / `.toc`）、面包屑、上下页、编辑链接、`script` / `style`、
  **图片**（检索用不到，CDN 绝对 URL 是噪声）
- 相对链接 / 图片转**绝对 URL**
- 表格转 GFM 表格（`| a | b |`）
- 每个页面 → 一个 `.md`，带 frontmatter：

```yaml
---
source: https://vitepress.dev/guide/getting-started
title: Getting Started
fetchedAt: 2026-10-04T05:20:00.000Z
---
```

## 五、增量是怎么判定的

**按内容哈希，而不是时间戳。** 每个页面算出「清洗后正文」的 sha256，与清单里上次的
哈希比对：一致就**不写文件** —— 不写文件 mtime 就不动，后续 `nx-kn index` 会如实报
`unchanged`，不重复嵌入。

- frontmatter 里的 `fetchedAt` 每次都变，所以**哈希只算正文**（算进去会让「没改的页面」
  永远判定为 changed，增量直接失效）
- 第二次抓取无变更 → `新增 0 / 更新 0 / 未变 N`
- 改了站点上一页 → 只重写那一页（`更新 1 / 未变 N-1`）
- `crawl run --rebuild` = 无视已存哈希、所有页面重写一遍（改了抓取范围后想强制刷新时用）；
  注意它只影响**抓取**，zg 索引侧仍要再跑 `nx-kn index`（如换了 embedding 模型还需 `--rebuild`）

## 六、落盘布局

```
<数据目录>/
├── store.json                      # crawl.sources[]（与 kb.vaults 分列）
└── sources/
    └── <名>/
        ├── .nx-kn-crawl.json       # 采集清单：每页 url → { file, hash }
        ├── index.md
        └── guide/getting-started.md
```

`.nx-kn-crawl.json` 以 `.` 开头 → zg 默认不扫（不污染索引），也是**增量的唯一依据**。

## 七、排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `没有抓到任何页面` | 起始地址不可达 / 返回非 HTML / 需要 JS 渲染 | 确认地址可访问、是静态 HTML；SPA 文档站（内容靠 JS 生成）本版本不支持 |
| 抓到页数远少于预期 | sitemap 缺失 + 同域链接少 | 看 `crawl run --json` 的 `results[].via`（`sitemap` / `bfs`）与 `failed` |
| 想在站点里只抓一段 | 默认 `**` 全抓 | `crawl add --match '/guide/**'` 重建该源 |
| 页数被截断在 200 | 默认 `--max 200` | `crawl add --max 500` 重建该源 |
| 一页失败（404/超时） | 单页问题 | 不中断整轮；`failed` 计数与具体 URL 在 `crawl run --json` 的 `results[].failures` |
| 抓完在 `kb list` 里看不到 | 只登记有内容的源 | 确认 `crawl run` 真的抓到了页（`crawl list` 的 `pages` > 0） |
| 抓下来想改名/换范围 | 源名即目录名 | `crawl remove` 再 `crawl add`（`--purge` 可顺手清掉旧目录） |
| 想删掉整个源的数据 | | `nx-kn crawl remove <名> --purge` |

## 八、为什么不这么做（常见疑问）

**为什么不是「Node 主进程 + Python 子进程」？** nx-kn 是发布到 npm 的包，
要求用户另外装 Python 3.10+ / venv 直接违背「装上即可用」。抓公开文档站既无登录也
无验证码，也不需要浏览器渲染，Node 内置 `fetch` + 解析库足够。

**为什么不用 [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)？**
它是**参考实现**（阅读其抓取与清洗思路），不是被调用的组件，也不作为依赖引入。

**为什么不支持需要登录 / 验证码的站点？** 那需要会话与浏览器，属于另一个问题域，
不在本版本范围。

**为什么不做定时抓取（守护）？** 与 kb 域同一口径：watch 留待后续版本。当前是
「跑一次 `crawl run`」的显式动作。
