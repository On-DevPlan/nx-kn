# Frontmatter 生成规范（步骤 4 硬性步骤）

> 主文档：[SKILL.md](../SKILL.md) §「步骤 4：生成 frontmatter（硬性步骤，不可跳过）」

---

## 为什么必须有这一步

Obsidian 插件生态几乎全部依赖 frontmatter：

| 字段          | 被谁用                                                      |
| ------------- | ----------------------------------------------------------- |
| `creatime`  | Dataview 时间轴、Templater 时间戳、QuickAdd 排序           |
| `tags`       | Dataview 标签聚合、Obsidian 原生 Tags 面板、搜索过滤        |
| `bklink`   | Dataview 反向链接查询、`[[]]` 跳转补全                       |

AI 自己手写 frontmatter 时**几乎必然漏**——本质是「passing context to AI writer is fragile; explicit script is deterministic」。`gen_frontmatter.py` 是这个问题的硬约束。

---

## 工具：`scripts/gen_frontmatter.py`

### 用法

```bash
# 最简：从 cwd 自动推断 vault
cd /path/to/vault
python scripts/gen_frontmatter.py --link "memory具体是如何动态申请"

# 推荐：显式给 source，更快、更准
python scripts/gen_frontmatter.py --source 日常/foo.md --link "memory具体是如何动态申请"

# 加 --locate 找出 vault 内所有引用了 [[link]] 的文件，bklink 自动列出全部
python scripts/gen_frontmatter.py --source 日常/foo.md --link "memory具体是如何动态申请" --locate

# vault 根用 --vault 指定（cwd 没有 .obsidian 时用）
python scripts/gen_frontmatter.py --vault /path/to/vault --source 日常/foo.md --link "xxx"
# 或环境变量：
NX_OBSIDIAN_VAULT=/path/to/vault python scripts/gen_frontmatter.py --source 日常/foo.md --link "xxx"
```

脚本会自动从 `cwd` 沿父目录找 `.obsidian`；找不到时按 `--vault` → `NX_OBSIDIAN_VAULT` 顺序兜底。

### 输出形态

```
. vault: D:\code\a_md\obsidian_init
. frontmatter keys: ['creatime', 'tags', 'bklink']
. filename: memory具体是如何动态申请.md
. source: 日常/base_日常.md:103
---
creatime: 2026-06-21 14:00:00
tags: []
bklink:
  - "[[base_日常]]"
---
```

主线程只取 `---` 到下一个 `---` 之间的内容，注入 subagent prompt 的 `{frontmatter_yaml}` 占位符。

---

## 默认生成的三段

`gen_frontmatter.py` **硬编码**生成这三个字段（不读 vault 里的任何模板文件——客户零依赖）：

| 字段 | 值 | 用途 |
| -- | -- | -- |
| `creatime` | `YYYY-MM-DD HH:MM:SS`（脚本运行时间） | Dataview 时间轴、QuickAdd 排序 |
| `tags` | `[]` | Dataview 标签聚合（默认空数组而非 null） |
| `bklink` | `["[[source 文件 stem]]"]`（含 `--locate` 时列出全部） | 反向链接、Dataview 反链查询 |

新笔记作者可以在创作后手动改 `tags`、`bklink`——脚本只是起步。

---

## bklink 反向链接

`bklink` 默认回填 source 文件 stem（即去掉路径与扩展名的部分）：

| source                            | bklink 值 |
| --------------------------------- | --------- |
| `日常/foo.md`                  | `[[foo]]` |
| `kafka的Log.scala文件是干嘛的.md` | `[[kafka的Log.scala文件是干嘛的]]`（取 basename，不再 splitext） |

加了 `--locate` 后，bklink 会**额外**包含 vault 内所有引用了 `[[link]]` 的源文件——也是用 basename，只去扩展名一次。

---

## 文件名 sanitization

脚本的 `sanitize()` 函数自动处理 `*"\/<>:|?`。**但 `, . ?` 不在自动处理里**——这是有意的：因为它们在标题里**可能**是合法字符（例如「Alpha, Beta 设计模式」「Redis 3.0 协议」），AI 应当根据 vault 现状判断是否重写。

判断流程见 SKILL.md §「标题 sanitization 规则」。

---

## 编码与兼容性

- Py2.7 / Py3 双兼容
- Windows 中文 cmdline 默认 GBK，sys.argv 是 GBK bytes；脚本自动 utf-8 → cp936 → gbk fallback 解码
- stdout 强制 reconfigure utf-8（避免 Py3.6 之前的乱码）
- 写文件统一 utf-8（避免 Windows cp936 默认）
