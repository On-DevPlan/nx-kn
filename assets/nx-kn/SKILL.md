---
name: nx-kn
description: 当需要检索本机 Obsidian 知识库（笔记全文 / 语义搜索）、建立或更新索引、增减知识库目录、查看索引状态时使用。触发词：知识库、笔记、检索、搜索、召回、Obsidian、vault、索引、query、index、多个库、添加目录。不适用：需要 LLM 问答或摘要（本工具只召回、不生成）；需要爬取 vault 之外的网页文档（未实现）。
---

# nx-kn

一句话：把本机的**若干** Obsidian vault 当成知识库，用 zg（zvec-grep）做「精确 + 关键词 + 语义」
三路混合检索，跨库结果按融合分合并成一张列表，带所属库名 + 库内相对路径 + 行号；
CLI 与 Web 面板共享同一份 action 声明。

## 核心不变量（违反会怎样）

1. **一条 action 定义，三端同时暴露**——在 `src/modules/<域>/index.js` 里同时声明
   `cli` 路径与 `http` 路由。漏了 http 面板就没有这个操作；漏了 cli 则启动时
   registry 自检直接报错（「Web 操作必须有 CLI 等价」）。
2. **失败抛错，业务结果返回 `{status}`**——「还没建索引」这类可决策的情形
   返回 `{ needIndex: true }` 而不是抛错，面板要拿它渲染引导。
3. **索引归 zg 所有**——nx-kn 只调 zg、不碰 `.zvec-grep/` 里的文件；
   zg 的 provider key 存在 `~/.zvec-grep/config.json`，nx-kn 不存储、不回显、不转发。
   `kb remove` 只解除登记，**不删**磁盘上的索引。
4. **多库是「多个索引 + 一次合并」，不是「一个大索引」**——zg 的索引按 workspace 根
   组织（`<root>/.zvec-grep/`），两个 vault 天然是两个索引、可以有两个不同模型。
   因此：查询是逐库召回后按 score 合并，命中**必须**带上所属库名（只给相对路径
   无法定位到磁盘文件），且某个库召回失败不能拖垮整次查询。

## 命令速查

| 命令 | 说明 |
| --- | --- |
| `nx-kn kb add <vault路径> [--model M]` | 把一个 vault 加进知识库列表（按绝对路径去重；可加多个）。`kb use` 是同义别名 |
| `nx-kn kb remove <vault路径>` | 从列表移除（只解除登记，不删索引；要删索引跑 `zg index <路径> --drop`） |
| `nx-kn kb list` | 列出各库的笔记数 / 索引状态 / 生效模型 |
| `nx-kn index [--rebuild] [--model M] [--types md,txt] [--root 路径]` | 对**全部库**建 / 增索引（默认只收 md）；不带 `--rebuild` 即**增量**；**换模型必须叠加 `--rebuild`** |
| `nx-kn query "<问句>" [--limit N] [--preview none\|short\|full] [--root 路径]` | 跨全部库混合检索，按融合分合并；输出 `[库名] 相对路径:行号` + 片段 |
| `nx-kn status` | zg 可用性 / 各库笔记数 / 索引覆盖度 / 生效模型 |
| `nx-kn serve [--port N] [--no-open]` | 启动 Web 面板 |
| `nx-kn routes` | CLI 命令 ↔ HTTP 路由对照表（agent 摸底从这里开始） |
| `nx-kn help [topic]` | 帮助；`help --json` 输出可解析命令表 |
| `nx-kn health` | 自检 |
| `nx-kn settings get` / `set k=v...` | 读写设置（白名单外的键被拒绝） |
| `nx-kn skill install [--force]` | 把用法装给本机 agent（~/.claude/skills） |
| 任何命令 + `--json` | 机器可读输出（agent 模式） |
| 任何命令 + `--store <path>` | 本次运行覆盖存储路径（测试防污染必用） |

`--root <路径>` 是「这次只看这一个目录」，用于探路；它不需要事先 `kb add`，
也不会改动库列表。

## 检索结果怎么读（agent 必读）

- 输出头 `[nx-kn 知识库召回]` 列出参与检索的**每个库的根目录**
- 多库时命中带 `[库名]` 前缀，**读全文必须拼那个库的根**：`<该库的根>/<相对路径>`，
  行号区间即 `:<起>-<止>`（拼错库根是最容易犯的错，所以库名和路径在同一行）
- `matchedBy` 说明命中来源：`fts`（关键词/倒排）、`vector`（语义相似）、`rg`（精确匹配）；
  同时出现即两路都命中，通常更可信
- `score` 是 zg 的融合分（RRF，由排名派生），**跨库可比**——它决定多库合并后的顺序
- 末尾 `results:` / `background_refresh:` 是运行时状态行，不是命中内容
- 结果是**一条融合后的排序列表**（内部固定加 `--fuse`）：长问句不会被拆成多组重复返回
- 某个库目录不存在或召回失败时，结果里会出现「跳过 […]」而**不是**整体报错
- `--json` 下的结构：`hits[]` 每项含 `path / start / end / heading / headingLevel /
  snippet / matchedBy / score / vault / vaultName`；另有 `searched[]` 与 `skipped[]`

## agent 典型会话

1. `nx-kn status --json` —— 确认 zg 可用、有哪些库、索引建了没
2. `nx-kn query "问题" --json` —— 取 `hits[]`（每条都带 `vault`，据此定位文件）
3. 需要原文时直接读 `<vault>/<path>` 的对应行区间
4. 新增笔记后 `nx-kn index`（增量，别加 `--rebuild`）；只有换模型才要 `--rebuild`
5. 出错时读 `error` 字段：带「用法:」前缀 = 参数问题；
   `EXTERNAL` = zg 调用失败（多半是没装：`npm install -g @zvec/zvec-grep`）

## 什么时候不用

- 需要多用户 / 远程部署（这是本机单用户工具）
- 需要 LLM 问答、摘要、改写（本工具只做召回）
- 需要 wikilink / backlink 关系图谱（不在范围内）
- 需要跨库**去重/合并同一篇笔记**：两个库若有目录嵌套，同一文件可能被两个索引各收一次

## 数据与存储

- 状态存 `~/.nx-kn/store.json`，原子写；环境变量 `NX_KN_STORE` 可覆盖路径
- 知识库列表在 `kb.vaults[]`，每项是 `{ path, name, model, addedAt }`——
  模型是**每库一个**（旧版的全局单值会在读取时自动迁移成列表）
- 环境变量 `NX_KN_VAULT` 可临时指定「只看这一个目录」（不落盘、不改列表）
- 索引落在各库自己的 `<vault>/.zvec-grep/`（zg 拥有；删掉它 = 那个库回到未索引状态）
- 删除数据 = 删 store.json（无隐藏状态）

## references

- `00-design.md` —— 架构与不变量的完整阐述（改动核心代码前必读）
- `10-knowledge-base.md` —— 知识库检索域：多库管理、收录范围、模型切换、结果格式与排障
