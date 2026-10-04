# 10 · 知识库检索域（kb）

> 本文讲**怎么用**这一域：多库管理、命令细节、收录范围、结果格式、排障。
> 「这一域内部怎么改代码」属于项目仓库的 README，不在随包手册里。

## 一、它是怎么工作的

一个知识库 = 一个目录（通常是一个 Obsidian vault）。**可以加多个**，
每个库各自一份索引；检索时逐库召回，再按融合分并成一张列表。

```
D:\Notes\Work   (.md)  ──┐  nx-kn index
D:\Obsidian Vault (.md) ─┤  （默认全部库；--root 只处理一个）
                         ▼
   每个库各自： zg index <库根> -t md -g '!.obsidian/**' -g '!.trash/**'
                         ▼
   <库根>/.zvec-grep/  →  files.zvec + index.zvec（文本 + 向量 + 倒排）
                         │  nx-kn query "问句"
                         ▼
   逐库召回（子进程 cwd = 各自库根）→ 各带 RRF 融合分
                         ▼
   按 score 合并排序 → 一张列表，每条标出所属库
```

三路各管一件事，这也是「问句含糊也能召回」的原因：

| 路 | 命中什么 | 输出里的标记 |
| --- | --- | --- |
| rg 精确 | 字面匹配（符号名、专有词） | `rg` |
| FTS 关键词 | 分词后的倒排匹配（jieba，中文友好） | `fts` |
| 向量语义 | 意思相近但不含原词的段落 | `vector` |

**为什么不是「一个大索引」**：zg 的索引按 workspace 根组织（`<root>/.zvec-grep/`），
没有「把两个目录塞进一个索引」的命令。硬做只能建一个包含两库的父目录，而两个
vault 往往在不相干的路径上。所以 nx-kn 选择记住多个根、检索时合并——
副产品是**每个库可以用不同的 embedding 模型**。

## 二、多库管理

```bash
nx-kn kb add D:\Notes\Work            # 加一个库（kb use 是同义别名）
nx-kn kb add "D:\Obsidian Vault" --model local/qwen3-embedding-0.6b
nx-kn kb list                         # 看有哪些库、各自索引到哪一步
nx-kn kb remove D:\Notes\Work         # 解除登记（不删磁盘上的索引）
```

- 按**绝对路径**去重：同一个目录加两次只会有一条记录
- 路径不存在时直接拒绝（不会登记一个假路径）
- `remove` 只解除登记。索引是 zg 的产物、留在原库根下；要真删掉跑
  `zg index <库根> --drop`
- **某个库的目录被删/移走不会让整条命令失败**：它会显示成「目录不存在」，
  其余库照常工作。查询时该库记入「跳过」而不是整体报错

## 三、收录范围（`nx-kn index` 的默认口径）

- **只收 markdown**（`-t md`）。要连 `.txt` 一起收：`nx-kn index --types md,txt`
- **排除** `.obsidian/`（配置、主题、插件）与 `.trash/`（已删笔记）
- 实测数据：一个 551 篇 md 的 vault 里，`.obsidian/` 独占 325 篇（59%）——
  排除规则不是可选项
- 这两者以 `.` 开头，zg 默认本就不扫隐藏路径，所以默认结果是对的；
  显式写排除是为了不把正确性寄托在别人的默认值上
- 图片 / PDF 等二进制附件不在范围内

### zg 还有一套自己的默认忽略（实测 0.2.2）

这几类**根本不会进索引**，也不在 nx-kn 的排除名单里——是 zg 内置的：

| 被跳过 | 说明 |
| --- | --- |
| 隐藏目录 / 隐藏文件（`.xxx`） | 含 `.git`、`.zvec-grep`（这两个是硬跳过） |
| 依赖与产物目录名 | `node_modules`、`vendor`、`dist`、`build`、`out`、`target`、`coverage`、`generated`、`tmp`、`temp`、`logs`、`locale`、`locales`、`translations` 等 |
| **嵌套 git 仓库整棵** | 子目录里若有 `.git`，整棵跳过——vault 里放着的克隆仓库不会污染你的知识库 |
| **0 字节空文件** | Obsidian 里点出来的空笔记 |

此外，仓库根与各子目录的 `.gitignore` 规则也会被 zg 遵守。

**所以 `status` 报的「篇数」是「可索引的 md」，不是磁盘上 md 的总数**，
差额会写明原因：

```
[Obsidian Vault] D:\Obsidian Vault
    173 篇 md · Obsidian（另有 1 个克隆仓库、5 篇空文件，zg 默认不收）
    索引 已建 · 100% 173/173 文件 · 1490 片段   模型 local/qwen3-embedding-0.6b
```

（这是真实数字：226 篇 md − 48 篇在克隆仓库 `辅助工具/抓包/langgraph-claude-code` 里
− 5 篇空文件 = 173。**权威数字始终是索引的 `files / filesTotal`**，nx-kn 的计数是估算。）

zg 有 `--no-ignore`（不套默认与 .gitignore 规则）与 `--hidden`（收隐藏路径）两个开关，
但 nx-kn 的 `index` 目前**不透传**它们。真有需要就直接跑
`zg index <库根> --no-ignore`（嵌套 git 仓库的排除是另一条独立逻辑，未验证是否一并放行）。

## 四、建立与更新索引

```bash
nx-kn index              # 增量：只处理新增 / 改动 / 删除的文件（**默认**）
nx-kn index --rebuild    # 全量重建（换模型、或索引疑似损坏时）
nx-kn index --root D:\Notes\Work   # 只处理其中一个库
```

**默认就是增量**（zg 0.2.2 实测）：加 1 篇新笔记后跑一次不带 `--rebuild` 的 index，
返回 `3 scanned, 1 added, 2 unchanged` —— 已建向量原样保留，只嵌入了新笔记。
所以日常「改完笔记补索引」用 `nx-kn index` 就够了，**不要习惯性加 `--rebuild`**：
那会把整个库重新嵌入一遍，大 vault 上要等很久。

- **换模型必须 `--rebuild`**：已有索引锁定了旧模型的向量维度，普通 index 不能混用；
  nx-kn 会在你忘加时直接拒绝并说明原因
- 面板上是两个按钮：「更新索引」（增量）与「重建索引」（全量，有二次确认）
- 首次索引要下载本地模型（`local/*`）或联网调远程 embedding，会明显慢一些；
  之后快很多
- 多库是**串行**建索引的：同时跑会抢模型与磁盘，实测会出现
  `Cleanup of retired segment failed` 之类的残留告警。串行换来确定的顺序与可读日志
- Windows 上并发跑两次 `index` 也可能看到同样的警告——不影响索引结果，串行即可避免

## 五、守护：让索引自动跟上

不想每次改完笔记都记得手动跑一次 `nx-kn index`，就让守护替你盯着：

```bash
nx-kn watch                 # 前台常驻，监听所有已登记库；Ctrl+C 停
nx-kn watch status          # 看：在不在跑、监听了哪些库、最近刷新记录
nx-kn serve                 # 面板进程内默认已开守护（--no-watch 可关）
```

改了哪个库，就只对那个库跑一次**增量**索引——报出来的数字与手敲 `nx-kn index` 完全一样。

**它只做「触发」，不重写索引逻辑。** zg 的 `index` 本来就是增量的（见 §四），
所以守护唯一的本职是「在笔记变了的时候把它叫起来」。这意味着：模型选择、收录口径、
换模型的 `--rebuild` 规则，与手动路径**一字不差**，不存在「守护建的索引和手动建的不一样」。

它自己必须处理的只有三件（都不是优化，是正确性）：

| 事 | 为什么 |
| --- | --- |
| **过滤**（入口） | 只认 `.md`；`.obsidian/`、`.trash/`、`.zvec-grep/` 整棵不看。本机 `.obsidian/` 里有 325 篇 md（占全部 md 的 59%），不管它、光是打开 Obsidian 就会触发索引；`.zvec-grep/` 则是**我们自己**的索引目录，不管它就会「索引写盘 → 触发 → 再索引」自激成环 |
| **防抖**（默认 1.5s） | Obsidian 保存一篇笔记会连发好几个事件（写临时文件 → 改名），键盘停顿前的自动保存也是独立事件流。不合并的话，改一篇笔记会起好几个 `zg` 子进程 |
| **串行、不重入** | 同一库并排跑两次索引毫无意义；同时跑多个 workspace 还会抢模型与磁盘（见 §四末）。索引期间来的改动只置一个标记，跑完补一轮——**不是**排 N 次队 |

几个要知道的行为：

- 守护状态**只在内存里**（进程一停就没了，不写 `store.json`）。这是有意的：
  「谁在监听」是进程事实，持久化它只会制造「记录说在跑、其实没有进程」的假象
- 于是 CLI 的 `watch` 与面板上的守护**互不可见**（各看各的进程）
- 索引失败**不会**让守护退出：错误记进状态（`watch status` 里能看到），下一笔改动照常处理
- 防抖窗口可用 `NX_KN_WATCH_DEBOUNCE_MS` 调（测试用；日常不必改）
- 不做开机自启 / 系统服务：它是前台进程（`watch`）或面板进程的一部分（`serve`）

## 六、检索结果的读法

```bash
nx-kn query "登录页为什么提示超时"
```

```
[nx-kn 知识库召回]
知识库（2 个）:
  [nx-kn-smoke] D:\DevProjects\my\github\nx-kn-smoke
  [Work]        D:\Notes\Work
命中路径是**所属库内**的相对路径；读全文拼 <该库的根>/<相对路径>

#1 [nx-kn-smoke] notes/登录超时排查.md:1-2   [fts+vector]   score 0.0328
    ---
    title: 登录超时排查
#2 [Work] notes/鉴权设计.md:31-48   [fts+vector]   score 0.0321
    ...
```

- **先找到库、再拼路径**：`[nx-kn-smoke]` + `notes/登录超时排查.md`
  → `D:\DevProjects\my\github\nx-kn-smoke\notes\登录超时排查.md` 的第 1–2 行
- 只检索一个库（例如用 `--root` 指定）时，输出**不带** `[库名]` 前缀——
  此时唯一的库根就是归属
- `score` 是 zg 的融合分（RRF，由排名派生）。它**跨库可比**，多库合并后的顺序
  就是按它排的；同一个问题在两个库里排第 1 的命中会得到相同的 score
- `[fts+vector]` = 关键词与语义两路都命中，通常比只有 `[vector]` 的更可信
- frontmatter（`---` / `title:` / `tags:`）**按原文索引**，所以它有时会占掉一两条命中位；
  这是刻意保留的——按 tags 搜笔记是常见用法
- `--preview short|full` 控制片段长度；`--preview none` 只给路径与行号（省 token）
- `--limit N` 是**合并后的**条数上限（默认 7），不是每个库各 N 条
- 结果**已融合**（内部固定加 `zg --fuse`）：无论问句多长，都是一条统一排序的列表。
  不加融合时 zg 会按词拆成多个分组、每组各返回 N 条并互相重复——
  一个三词问句会回来三倍命中，其中大半是同一条的副本，所以这里默认融合

## 七、排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `zg 不可用`（`EXTERNAL`） | 没装召回引擎 | `npm install -g @zvec/zvec-grep`（需 Node ≥ 22） |
| `还没有添加知识库目录` | 列表是空的 | `nx-kn kb add <vault路径>` |
| 某个库显示「目录不存在」 | 目录被删/移走/改名 | 重新 `kb add` 新路径，或 `kb remove` 掉旧记录 |
| query 返回 `needIndex: true` | 所有库都没建索引 | `nx-kn index` |
| query 结果里有「跳过 […]」 | 那一个库目录丢了或召回失败 | 看 `status --json` 里该库的 `hint`；其余库结果仍然可用 |
| 结果里出现同一篇笔记两次 | 两个库有目录嵌套（同一文件被两个索引各收一次） | 只登记父目录，或把其中一个库移出列表 |
| `status` 显示「索引待更新」 | 该库笔记有新增或改动 | `nx-kn index`（增量，不用 `--rebuild`） |
| 覆盖度不是 100% | 索引里有文件空了/变二进制，或建在半途 | 看 `status --json` 的 `files/filesTotal`；必要时 `--rebuild` |
| 笔记数比磁盘上的 md 少 | zg 默认不收克隆仓库 / 空文件 / 隐藏目录（见第三节） | 是预期行为；数字后面会写明原因 |
| Windows 下「路径带空格就报 `at most one root path`」 | 已修（cmd.exe 引号二次解析） | 升级到本版本；勿自行把 `windowsVerbatimArguments` 去掉 |
| 中文召回不准 | 那个库用的是英文模型 | 换中文模型后 **必须** `--rebuild`（见下） |
| 找不到「模型」该填什么 | 面板里显示「（未记录）」 | 索引没建时就是这么显示的；建完会显示实际生效的模型 |
| 默认模型拉不下来（离线 / 内网） | 内置默认是 `local/qwen3-embedding-0.6b` | 用 `NX_KN_EMBEDDING=<本机已缓存的模型>` 换掉默认，或直接 `--model` |

## 七、embedding 模型（**每库一个**）

模型是**每个库各自的属性**：两个库可以用不同模型、不同维度，互不影响
（正因如此才不能用一个大索引）。

```bash
# 建索引时指定（新库直接用这个模型；已建过则必须叠加 --rebuild）
nx-kn index --model local/qwen3-embedding-0.6b --rebuild

# 只对某个库换模型
nx-kn index --root D:\Notes\Work --model qwen/text-embedding-v4 --rebuild
```

| 模型 | 维度 | 说明 |
| --- | --- | --- |
| `local/qwen3-embedding-0.6b` | 1024 | **默认**。本地、离线、免 key；中文可用。首次索引时自动下载 |
| `local/potion-multilingual-128m` | 256 | 本地小模型，快；质量低于 0.6b |
| `qwen/qwen3.7-text-embedding` | 1024 | 远程（需 qwen API key），长文档强 |
| `qwen/text-embedding-v4` | 1024 | 远程，经典款，8K 输入 |

不指定 `--model` 时的取用顺序（高 → 低）：**命令行 `--model` → 已建索引里实际
生效的 → 这个库登记时记的 → 环境变量 `NX_KN_EMBEDDING` → 内置默认
`local/qwen3-embedding-0.6b`**。最后两层保证了在一台从未配置过 zg 的机器上，
「添加目录 → 更新索引」这条最普通的路径也能一次跑通——不需要用户先去配模型。
`NX_KN_EMBEDDING` 是给 CI / 内网留的「换默认模型」开关（不改代码即可），
但它压不过前面几层：换模型始终是显式动作，不该被环境变量偷袭。

> 远程模型需要的凭据写在 zg 的全局配置里（nx-kn 不接触 key）：
> ```bash
> zg config provider set qwen --api-key sk-xxxx
> zg auth grant <库根> --capability embedding --scope workspace
> ```
