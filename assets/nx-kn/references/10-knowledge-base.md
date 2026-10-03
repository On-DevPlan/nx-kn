# 10 · 知识库检索域（kb）

> 本文讲**怎么用**这一域：命令细节、收录范围、结果格式、排障。
> 「这一域内部怎么改代码」属于项目仓库的 README，不在随包手册里。

## 一、它是怎么工作的

```
Obsidian vault (.md)
      │  nx-kn index        →  zg index <vault> -t md -g '!.obsidian/**' -g '!.trash/**'
      ▼
<vault>/.zvec-grep/          →  files.zvec（文件元数据） + index.zvec（片段：文本 + 向量 + 倒排）
      │  nx-kn query "问句"   →  zg query（**子进程 cwd = vault**）
      ▼
三路召回 → RRF 融合 → 返回 vault 内相对路径 + 行号 + 片段
```

三路各管一件事，这也是「问句含糊也能召回」的原因：

| 路 | 命中什么 | 输出里的标记 |
| --- | --- | --- |
| rg 精确 | 字面匹配（符号名、专有词） | `rg` |
| FTS 关键词 | 分词后的倒排匹配（jieba，中文友好） | `fts` |
| 向量语义 | 意思相近但不含原词的段落 | `vector` |

## 二、收录范围（`nx-kn index` 的默认口径）

- **只收 markdown**（`-t md`）。要连 `.txt` 一起收：`nx-kn index --types md,txt`
- **排除** `.obsidian/`（配置、主题、插件）与 `.trash/`（已删笔记）
- 这两者以 `.` 开头，zg 默认本就不扫隐藏路径，所以默认结果是对的；
  显式写排除是为了不把正确性寄托在别人的默认值上
- 空文件、二进制附件不进索引；图片 / PDF 不在范围内

## 三、建立与更新索引

```bash
nx-kn kb use D:\Notes\MyVault   # 第一次：设定知识库（只需一次）
nx-kn index                     # 建索引；之后改完笔记再跑它就增量更新
nx-kn index --rebuild           # 全量重建（换模型、或索引疑似损坏时）
```

- **增量**：`nx-kn index` 会比对已有索引，只处理新增/改动/删除的文件
- **换模型必须 `--rebuild`**：已有索引锁定了旧模型的向量维度，普通 index 不能混用；
  nx-kn 会在你忘加时直接拒绝并说明原因
- 首次索引要下载本地模型（`local/*`）或联网调远程 embedding，会明显慢一些；
  之后快很多
- Windows 上并发跑两次 `index` 可能看到 `Cleanup of retired segment failed` 警告——
  zg 底层文件锁导致的残留清理提示，不影响索引结果；串行跑即可避免

## 四、检索结果的读法

```bash
nx-kn query "登录页为什么提示超时"
```

```
[nx-kn 知识库召回]
知识库根: D:\Notes\MyVault
命中路径为 vault 内相对路径；要读全文直接拼绝对路径: <知识库根>/<相对路径>

#1 notes/登录超时排查.md:6-15   [fts+vector]   登录超时排查记录
    # 登录超时排查记录
    升级至 8.60.17 后登录页出现「登录超时」提示。
```

- 要读全文：`D:\Notes\MyVault\notes\登录超时排查.md` 的第 6–15 行
- `[fts+vector]` = 关键词与语义两路都命中，通常比只有 `[vector]` 的更可信
- frontmatter（`---` / `title:` / `tags:`）**按原文索引**，所以它有时会占掉一两条命中位；
  这是刻意保留的——按 tags 搜笔记是常见用法
- `--preview short|full` 控制片段长度；`--preview none` 只给路径与行号（省 token）
- `--limit N` 返回条数上限（默认 7）
- 结果**已融合**（内部固定加 `zg --fuse`）：无论问句多长，都是一条统一排序的列表。
  不加融合时 zg 会按词拆成多个分组、每组各返回 N 条并互相重复——
  一个三词问句会回来三倍命中，其中大半是同一条的副本，所以这里默认融合。

## 五、排障

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `zg 不可用`（`EXTERNAL`） | 没装召回引擎 | `npm install -g @zvec/zvec-grep`（需 Node ≥ 22） |
| `还没有设定知识库目录` | 没跑过 `kb use` | `nx-kn kb use <vault路径>` |
| query 返回 `needIndex: true` | 还没建索引 | `nx-kn index` |
| `status` 显示「索引待更新」 | 笔记有新增或改动 | `nx-kn index`（增量，不用 `--rebuild`） |
| 覆盖度不是 100% | 有空文件，或索引建在半途 | 看一眼 `status --json` 的 `files/filesTotal`；必要时 `--rebuild` |
| 中文召回不准 | 用的是英文模型 | 换中文模型后 **必须** `--rebuild`（见下） |

## 六、embedding 模型

| 模型 | 维度 | 说明 |
| --- | --- | --- |
| `local/qwen3-embedding-0.6b` | 1024 | 本地、离线、免 key；中文可用。首次索引时自动下载 |
| `local/potion-multilingual-128m` | 256 | 本地小模型，快；质量低于 0.6b |
| `qwen/qwen3.7-text-embedding` | 1024 | 远程（需 qwen API key），长文档强 |
| `qwen/text-embedding-v4` | 1024 | 远程，经典款，8K 输入 |

```bash
# 换模型（必须 --rebuild）
nx-kn index --model qwen/qwen3.7-text-embedding --rebuild

# 远程模型需要的凭据写在 zg 的全局配置里（nx-kn 不接触 key）
zg config provider set qwen --api-key sk-xxxx
```

> 换模型后要**对整个 vault 重建**：向量维度不同，不能在同一索引里混用。
> 面板上的「重建索引」按钮与 `nx-kn index --rebuild` 是同一条命令。
