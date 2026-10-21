---
name: kn-obsidian-repair-unresolved-links
description: Obsidian vault 中存在未解析的 `[[]]` 双链，需要补全为目标笔记（创建缺失笔记）。`[[xxx]]` 内容是问句 / 批注 / 反馈时也创建笔记——AI 把它当提问，写一篇针对性回答。`[[xxx]]` 内部格式问题（空格 / 标点 / 全角括号）需重写格式再走创建流程。当存在多个链接时自动并发创建。
---

# Obsidian 未解析双链补全

**触发：**
- 用户说 "[[某某]] 没创建" / "修复未解析链接" / "双链不存在"
- 用户说 "obsidian 还有未解析的 link" / "wiki-link 打不开"
- 批量补全 vault 里的 `[[]]` 红链
- 处理问句型双链（读者提问型 `[[xxx]]`）

**核心约束**：所有未解析双链都要创建笔记——问句也是。绝不删除、绝不改成引用块、绝不跳过。

---

## 步骤 0：解析规范文档与 vault（先于一切步骤）

本 skill **不自带**内容生成规范——四种内容模式与问卷模式规范由用户维护在 vault 里（默认 `<vault>/nx-kn/`），**用户随时可以改**。所以动手前先解析它们在哪：

```bash
nx-kn obsidian spec --json
```

从返回里取三样东西：

- `docs[]` 里 `key` = `content` 的 `path` → `{content_spec}`（内容生成规范）
- `docs[]` 里 `key` = `questionnaire` 的 `path` → `{questionnaire_spec}`（问卷模式规范）
- `vault` → `{vault_root}`（vault 根目录）

**兜底**（`nx-kn obsidian spec` 命令不存在、或返回 `configured:false` 时）：

1. 环境变量 `NX_OBSIDIAN_VAULT=<绝对路径>`；
2. 否则从 `{file}` 沿父目录走到第一个含 `.obsidian` 的目录 = `{vault_root}`，规范默认在 `<{vault_root}>/nx-kn/base-content.md` 与 `<{vault_root}>/nx-kn/questionnaire.md`。

> ⚠️ 两份规范文件任一缺失，就**停下来问用户**——不要凭记忆编规范内容。

---

## 流程（9 步）

```
1. 查看 → 2. 过滤 → 3. 定位 → 4. 生成 frontmatter（硬性）──┐
                                                          ↓
                                   5. 修文件名（sanitization）──┐
                                                              ↓
                                6. 生成内容（按内容规范文档）──┤
                                                              ↓
                            7. 创建到 source 同目录 ────────────┘
                                                              ↓
            8. 双链引用校验（snapshot diff）──┐
                                          ↓
                  9. 验证（head -3 + unresolved 退出）─┘
```

每一步的硬性约束见下文。

### 1. 查看

```bash
# 推荐：obsidian CLI（权威解析器，覆盖中文括号 / 全角空格 / NBSP）
obsidian unresolved format=json
# 兜底：本 skill 自带 scripts/scan_unresolved.py（无需 obsidian CLI）
python scripts/scan_unresolved.py --vault {vault_root}
```

**输出形态**（与 obsidian CLI 一致）：

```json
[{"link": "xxx", "sources": [{"file": "日常/foo.md", "line": 9}]}]
```

### 2. 过滤

排除：
- **图片 / 附件链接**（`.png` / `.jpg` / `.pdf` / `.zip` 等）——Obsidian 当附件处理
- **模板文件** `ctl/tmpl_*.md` 中的占位示例链接（用反引号转义，本身不该被算作未解析）

### 3. 定位

Grep 找到 source 文件和行号：

```bash
grep -rn "\[\[xxx\]\]" --include="*.md" 日常/  # 排除 ctl/、.claude/、.zvec-grep/
```

记下 `{file}`、`{line}`、前后 3 句上下文（用于步骤 6 理解链接含义）。

### 4. 生成 frontmatter（硬性步骤，不可跳过）

跑 `scripts/gen_frontmatter.py`：

```bash
python scripts/gen_frontmatter.py \
    --source 日常/foo.md --link "xxx" [--locate] --vault {vault_root}
```

脚本输出的 YAML 段（`---` 到下一个 `---` 之间）就是新文件的 frontmatter，**直接复制到 Write content 的开头**。

**为什么必须用脚本、不能自己手写 frontmatter：**
- 时间戳格式 `creatime: 2026-XX-XX HH:MM:SS` 一致
- `bklink` 自动指向 source 文件（避免反向链接断裂）
- `tags` 默认空数组（否则聚合报错）

脚本默认生成三段：`creatime` / `tags` / `bklink`，不依赖 vault 里的任何模板文件——拿过来就跑。

### 5. 修文件名（sanitization）

脚本自动处理 `*"\/<>:|?`；**主线程同时人工检查 link 内容是否含 `, . ?` 等 Obsidian 不支持的标点**——见下文「标题 sanitization 规则」。

### 6. 生成内容

按内容规范文档（`{content_spec}`，解析见步骤 0）的规范。读 `{file}` 上下文后生成**深入、不重复**的笔记。

**主题 → 模式** 的映射：

| xxx 形态 | 模式 |
| -- | -- |
| 名词短语 / 概念 | 模式 A 概念深潜 / 模式 D 概念拓扑 |
| 动词 / 操作 | 模式 B 实践拆解 / 模式 C 还原论拆解 |
| 问句 / 批注 / 反馈 | 模式 B 实践拆解（整篇写一篇针对性回答） |

锚点前置、量级感知、trade-off 讨论——见内容规范文档（`{content_spec}`）。

**生成前先在 vault 内搜相关笔记避免重复**：用 `mcp__zvec_grep__zvec_grep_search`（`query` = `{link}` 字面 + 源上下文一句话摘要，`limit` = 10）；MCP 不可用时回退 Grep，关键词从 `{link}` 字面和源上下文提炼 2-4 个组合 OR 检索。

### 7. 创建文件到 source 同目录

**强制规则**：新笔记必须创建在 source 文件所在目录下，绝不放 vault 根。

```
✅ 日常/如何成为一个动画制作工程师.md  (source)
   → 日常/动画工程师需要养成哪些直觉.md  (新文件)

❌ 根目录/动画工程师需要养成哪些直觉.md  (丢到根目录 = vault 混乱)
```

根目录只放 `base-root.md` 这类 vault 入口；具体笔记按 source 目录归属。

### 8. 双链引用校验

**不能只看 source 那边的链接是否消失**——新文件**内部**的双链也要逐个能解析。用 `scripts/postcheck.py`：

```bash
# 写笔记前：snapshot 当前 vault 的 unresolved 状态
python scripts/postcheck.py --snapshot snapshot.json --vault {vault_root}
# ... 写新笔记（步骤 6+7） ...
# 写完后：diff snapshot，识别新文件引入的失败双链
python scripts/postcheck.py \
    --snapshot-before snapshot.json \
    --new-file "日常/动画工程师需要养成哪些直觉.md" \
    --vault {vault_root}
# 退出码 0 = 通过；1 = 失败（stderr 打印明细 + 6 条根因诊断）
```

**绝不要自己写正则解析 `[[]]`**——交给 `obsidian unresolved` CLI（脚本内部调用），避免正则覆盖不全、中文括号、全角空格等坑。CLI 缺失时脚本自动 fallback 到同目录的 `scan_unresolved.py`（同一套解析规则），snapshot / diff 逻辑不变。

### 9. 验证

- `head -3 <新文件>` 第一行必须是 `---`（YAML 起始）
- `head -10 <新文件>` 必须能见到 `creatime:` / `tags:` / `bklink:` 三段
- 跑 `obsidian unresolved format=json`（或 `scan_unresolved.py`）确认链接消失

---

## ⚠️ frontmatter 强制约束（必读）

**这是本 skill 最重要的一条规则，违反会导致 vault 一致性破坏：**

> **Write 调用的 content 字符串的第一个字符必须是 `---`（YAML 起始），文件最开头 3 行必须是有效的 YAML frontmatter。**

### 漏 frontmatter 的实际危害

- Obsidian **双链反向链接**失效（`bklink` 缺失）
- **Dataview 查询**查不到（`creatime` / `tags` 缺失）
- **Tags 聚合**失败（`tags: []` 缺失）
- **Templater / QuickAdd** 等插件的"按 frontmatter 处理"功能全部失效

### 反例：错误的 Write 调用

```python
# ❌ 错误（bad_eg 1）：content 第一个字符是 '#'
content = """# 高级语言抽象层次与性能损失
> 关联笔记：...
"""

# ❌ 错误（bad_eg 2）：用 === 代替 --- 包裹 frontmatter
# gen_frontmatter.py 输出的是标准 YAML（--- 包裹），
# 但 AI 有时误把 prompt 模板中的 === 节分隔符当成 YAML 语法
content = """===
creatime: 2026-06-21 14:00:00
tags: []
bklink: []
===
# 标题
正文...
"""
```

> ⚠️ **`===` 的角色：** prompt 模板中的 `=== FRONTMATTER ===` / `=== 任务 ===` 是**模板节分隔符**，告诉 subagent 每段从哪里开始。里面的 YAML 内容（即 `{frontmatter_yaml}`）始终是 `---` 包裹的标准 YAML。subagent 写文件时**必须用 `---` 包裹 frontmatter**，不要照抄 `===`。

### 正例：正确的 Write 调用

```python
# ✅ 正确：先跑 gen_frontmatter.py，把输出放在 content 开头
content = """---
creatime: 2026-06-16 14:59:59
tags: []
bklink:
  - "[[base_日常]]"
---
# 高级语言抽象层次与性能损失
> 关联笔记：...
"""
Write(file_path, content)
```

---

## 相关性搜索（避免重复）

**触发：** 步骤 6、subagent prompt 步骤 3 的"链接 vault 内已有相关笔记，避免重复"——写新笔记前先确认主题在 vault 里没撞车。

### 工具路由（按此顺序选）

| 顺序 | 工具                                                                            | 何时用                                                       |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | `mcp__zvec_grep__zvec_grep_search`（**首选**）                                | MCP 工具列表中存在该工具时一律先用这个                       |
| 2    | **`Grep`**（**仅回退**）                                                    | `mcp__zvec_grep__zvec_grep_search` 在当前 host 不可用时回退 |

**1 用 zvec_grep_search 的原因**：
- vault 笔记主题分散、措辞漂移（"游标跨页方案" vs "keyset pagination"、"双链修复" vs "broken wiki-links"）——词法 grep 关键词随新笔记累积失效
- 语义检索按概念召回，不被关键词绑定；MCP 后台增量刷新索引，无需手动维护
- 不需要为每个新链接挑选关键词；query 直接用 `{link}` 字面 + 源上下文一句话摘要

**调用参数**：
- `root` = `{vault_root}`（主线程派发前从 `{file}` 沿父目录走到 `.obsidian` 求得，作为占位符注入）
- `query` = `{link}` 字面 + 源文件 {line} 行前后 1-3 句的一句话摘要
- `limit` = 10（够用即止，避免噪音）
- 不需要 `fuse` / 不需要 `queries` / 不需要 `vector`：单组语义检索足够

**2 Grep 回退**：
- 关键词：从 `{link}` 字面 + 源上下文提炼 2-4 个中英文关键词，OR 组合；目录限定为 vault 根（不要搜 `ctl/`、`__pycache__`、`.zvec-grep/`、`.claude/`）
- grep 命中后必须再过一遍语义判断——字面命中不代表主题真的相关

### 反模式

- ❌ 先 grep 几轮没结果就放弃，跳过"避免重复"直接写笔记——主题撞车比耗时更糟
- ❌ 用 zvec_grep 一搜 0 结果就断定"vault 没相关笔记"——可能是 query 太宽或太窄，重写 query 再搜一次
- ❌ 用 grep 时跨目录搜到 `ctl/`（模板占位链接）、`.zvec-grep/`（索引）、`.claude/`（skill 代码）——这些目录里的"命中"全是噪音

---

## 并发模式

当存在 **多个未解析链接** 时：

```
发现 → 定位 → 元数据（主线程跑 gen_frontmatter.py）  ← 步骤 4 硬性
              │
              ▼  把脚本输出（YAML 段）注入下面 prompt 的 {frontmatter_yaml} 占位符
              ├── subagent 1: 读上下文 → 生成内容（步骤 6） → 创建文件（步骤 7）
              ├── subagent 2: 读上下文 → 生成内容（步骤 6） → 创建文件（步骤 7）
              └── subagent 3: 读上下文 → 生成内容（步骤 6） → 创建文件（步骤 7）
              │
              ▼  所有 subagent 完成后，主线程跑 postcheck.py（步骤 8）
```

**关键约束：**
- 主线程必须在派发 subagent **之前** 跑完 `gen_frontmatter.py`（步骤 4），把脚本输出的 YAML 段（即 `---` 到下一个 `---` 之间的内容）复制到 subagent prompt 的 `{frontmatter_yaml}` 占位符位置。subagent **不要自己写** frontmatter——直接用主线程注入的 YAML。
- 所有 subagent 完成后，主线程**统一跑一次** `postcheck.py`（步骤 8），校验所有新文件内部的双链
- 每个 subagent 单独跑 prompt 内的 `head -3` 自检 frontmatter（步骤 9 子步骤）

### Prompt 模板（所有 `{xxx}` 都是占位符，必须由主线程替换）

派发前，主线程执行：

```bash
# 解析 {content_spec} / {questionnaire_spec} / {vault_root}（步骤 0）
nx-kn obsidian spec --json
# 取 docs[] 里 content / questionnaire 两项的 path，以及 vault 字段

python scripts/gen_frontmatter.py \
  --source {file} --link "{link}" --locate --vault {vault_root}
# 把输出里 --- 到 --- 之间的内容抓出来，替换 {frontmatter_yaml}

# 兜底（spec 不可用时）：从 {file} 沿父目录走到第一个含 .obsidian 的目录
# 例：{file} = "日常/foo.md" → vault_root = "D:\code\a_md\obsidian_init"
#     注入到 subagent prompt 的 {vault_root} 占位符（zvec_grep_search 的 root 参数需要绝对路径）
```

然后把替换后的整个 prompt 喂给 subagent：

```
=== 下方 YAML 是主线程已生成的 frontmatter，subagent 必须原样作为 Write content 开头（注意：用 --- 包裹，不是 ===）===
{frontmatter_yaml}
===

=== 任务（占位符在派发前已替换为具体值）===

1. 源文件 {file} 第 {line} 行引用了 [[{link}]]
2. 读源文件上下文，理解链接含义
3. 按 {content_spec}（内容规范文档的绝对路径，主线程已解析）的规范生成内容
   - 若 {content_spec} 仍是占位符：先跑 `nx-kn obsidian spec --json` 自行解析；再失败则从 {file} 沿父目录找 `.obsidian`，默认取 `<vault>/nx-kn/base-content.md`
   - 根据主题选择对应模式：概念深潜 / 实践拆解 / 还原论拆解 / 概念拓扑
   - 锚点前置：第一段先给具体问题或反直觉现象
   - 量级感知：用具体数字，不用"快"、"慢"、"大量"
   - trade-off 讨论：展示工程妥协而非列出"优点"
   - **找 vault 内相关笔记避免重复**：见上文「相关性搜索」——首选 `mcp__zvec_grep__zvec_grep_search`（`root` = `{vault_root}`，`query` = `{link}` 字面 + 源上下文一句话摘要，`limit` = 10）；MCP 不可用时回退 Grep，关键词从 `{link}` 字面和源上下文提炼 2-4 个组合 OR 检索

=== 输出要求 ===

- Write 的 content 字符串必须以 === 下方 YAML 块的内容开头（该内容是 --- 包裹的标准 YAML，subagent 直接复制）
- 注意：YAML 块用 `---` 包裹，不要因为看到 === 就照抄 ===
- 然后接 # 标题 和正文
- 文件名 {safe}.md，写入 source 文件同目录（如 source 在 `日常/` 下，则写 `日常/{safe}.md`）
- 写完后用 Read 工具读回前 3 行验证 frontmatter 存在
```

---

## 问卷模式（特殊需求时）

**触发条件：** 源文件是问卷模板（含问题 + 用户填写内容），且用户要求生成定制化响应。

**判断特征：**
- 源文件包含问题列表（段落 / 表格）和用户填写内容
- 末尾有触发双链，如 `[[我已经完成了问卷 帮我规划吧]]`

**处理方式：**

1. 读取源文件，解析用户的所有问卷回答
2. 分析关键数据：约束条件、偏好 / 厌恶、限制因素、基线能力
3. 读取问卷规范文档（`{questionnaire_spec}`，解析方式见步骤 0）获取问卷模式的写作规范
4. 生成与用户情况匹配的针对性响应
5. 写入位置：
   - 如果触发双链是"响应锚点"（如 `[[xxx规划]]`）→ 直接写入该文件（文件在 source 同目录）
   - 如果触发双链是"新建笔记名"（如 `[[张三的4周计划]]`）→ 在 source 同目录创建独立文件

> ⚠️ 无论是哪种情况，**文件必须放在 source 同目录**，不要丢到 vault 根目录。

---

## 问句 / 批注 / 反馈型双链处理（特殊场景）

**核心原则：所有未解析双链都要创建笔记。** 哪怕 `[[xxx]]` 看起来是问句 / 批注 / 反馈 / 吐槽，**也创建笔记**——AI 把 xxx 当作读者提问，写一篇针对性回答。

### 三种情况，统一动作 = 创建笔记

| # | `[[xxx]]` 形态                         | 处置                                                       |
| - | ---------------------------------------- | ---------------------------------------------------------- |
| 1 | xxx 像文件名 / 概念短语                  | 创建笔记（标准流程）                                       |
| 2 | **xxx 像问句 / 批注 / 反馈 / 吐槽** | **也创建笔记**——AI 把 xxx 当提问，写一篇针对性回答 |
| 3 | xxx 内部有格式问题（空格 / 标点 / 全角括号） | 重写 `[[xxx]]` 为合法双链（修正格式）→ 创建笔记          |

**唯一被允许的"重写格式"** = case 3 修正 `[[]]` 内部的格式问题，**重写完还是创建笔记**。

**绝对禁止：**
- ❌ 删除 `[[xxx]]`（丢弃读者意图）
- ❌ 改成 `> 读者提问：xxx`（这是丢弃，不是补全）
- ❌ 把问句理解成"伪双链"而跳过创建

### 标题 sanitization 规则（创建文件名前必过）

**Obsidian wiki-link 不支持**作为 link 一部分的字符：（半角空格）/ `　`（全角空格）/ `,` / `.` / `?` / `:` / `;` / `*` / `"` / `\` / `<` / `>` / `|` 等。

**新建文件名时：**

1. 如果 link `xxx` 含上述字符，**必须先重写**为合法形式（重命名标题），然后才能作为文件名
2. 重命名原则：
   - `,` → `，`（改用中文标点，保留语义）或直接删除
   - `.` → `。` 或删除
   - `?` → `？`（中文问号）或删除（保留主语）
   - 连续空格 → 单空格
3. **重写后的标题在 vault 里应该能找到对应文件**——别改名后 vault 里没有这个文件
4. **frontmatter `bklink` 和正文里的 `[[xxx]]` 都要同步改**——保持链路一致

**示例**：

| 原 link（不支持）            | 重写后 link + 文件名                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `[[foo, bar]]`             | `[[foo、bar]]`（文件名 `foo、bar.md`）                                    |
| `[[what is X?]]`           | `[[what is X]]` 或 `[[what is X？]]`                                      |
| `[[1.2.3 协议]]`           | `[[协议 1.2.3]]` 或 `[[协议 1-2-3]]`（避免 Obsidian 把 `1.2.3` 当数字） |
| `[[foo　bar]]`（全角空格） | `[[foo bar]]` 或 `[[foobar]]`（看哪个文件实际存在）                       |

### 案例 2 的执行 SOP（`xxx` 是问句 / 批注 / 反馈时）

1. `[[xxx]]` 是问句（如 `[[你这个文档在解释什么东西]]`）
2. **照样创建新文件**，文件名 = sanitized 后的 xxx
3. 文件首段以 `> 关联上下文：[源文件链接]` 开头，点明来源
4. **整篇笔记围绕 xxx 写一篇针对性回答**：
   - 模式 A 概念深潜：先答"是什么" + "为什么" + 边界
   - 模式 B 实践拆解：举具体场景 / 参数 / 翻车案例
   - 不要写"xxx 是什么的定义"——直接进入正文
5. frontmatter `bklink` 加 `[[源文件]]`
6. 跑步骤 8 `postcheck.py` 校验

### 案例 3 的格式修正 SOP（`[[xxx]]` 内部格式有问题时）

| 错误格式                       | 修正后                              | 备注                         |
| ------------------------------ | ----------------------------------- | ---------------------------- |
| `[[xxx　yyy]]`（全角空格）   | `[[xxx yyy]]` 或 `[[xxxyyy]]`   | 看目标文件名实际字符         |
| `[[xxx、]]`（尾随中文标点）  | `[[xxx]]`                         | 删除多余标点                 |
| `[[xxx,]]`（尾随英文标点）   | `[[xxx]]`                         | 删除多余标点                 |
| `【xxx】`（用了全角方括号）  | `[[xxx]]`                         | 替换为 `[[]]`               |
| `[[xxx] ]`（半个括号）       | `[[xxx]]`                         | 补全括号                     |
| `[[xxx, yyy]]`（含英文逗号） | `[[xxx、yyy]]` 或 `[[xxx yyy]]` | 见上"标题 sanitization 规则" |

**修正完后**，xxx 作为合法双链，**进入标准创建笔记流程**（步骤 4–9）。

### 判定流程图（覆盖主流程与特殊场景）

```
[[xxx]] 未解析（步骤 1-3 定位）
    │
    ├── 检查 [[xxx]] 内部格式（步骤 5：含 , . ? 空格/标点/全角括号）
    │       │
    │       ├── 有问题 → 重写格式（sanitization）→ 修改源文件 [[]]  → 进入创建流程
    │       └── 无问题 ──────────────────────────────────────────┐
    │                                                            │
    └── 进入创建笔记流程（步骤 4-9）  <───────────────────────────┘
            │
            ├── xxx 是名词短语 → 模式 A 概念深潜 / 模式 D 概念拓扑
            ├── xxx 是动词/操作 → 模式 B 实践拆解 / 模式 C 还原论拆解
            └── xxx 是问句/批注/反馈 → 整篇写一篇针对性回答（模式 B 实践拆解）
            │
            └── 步骤 7：文件名 sanitization（去 , . ? 等不支持字符）
            │
            └── 步骤 8：postcheck.py 校验新文件内部双链
```

### 一句话口诀

> **所有 `[[xxx]]` 未解析 = 创建笔记。** 问句创建回答笔记，批注创建反馈笔记，吐槽创建解释笔记。**绝对不能删、不能改成引用块、不能跳过。** 唯一允许的"重写"是修 `[[]]` 内部格式问题（含 `, . ?` 等 Obsidian 不支持的字符），重写后照样创建。

---

## 安装

```bash
# 默认 install（=本项目主 skill = nx-kn）—— 仅安装 nx-kn
nx-kn skill install

# 安装本 skill（位置参数形式）
nx-kn skill install kn-obsidian-repair-unresolved-links

# 装到指定路径
nx-kn skill install kn-obsidian-repair-unresolved-links --to /path/to/skills

# 已安装但要强制覆盖
nx-kn skill install kn-obsidian-repair-unresolved-links --force

# 看有哪些可装
nx-kn skill list
nx-kn skill groups
```

安装后落到 `~/.claude/skills/kn-obsidian-repair-unresolved-links/`，结构：SKILL.md + references/ + scripts/（脚本随 skill 一起分发，零外部依赖）。

也可以走 group 安装：`nx-kn skill install --group=kn-obsidian-repair-unresolved-links` 等价于上面显式指名安装。

---

## 脚本用法速查

| 脚本 | 用法 | 何时用 |
| --- | --- | --- |
| `scripts/gen_frontmatter.py` | `python scripts/gen_frontmatter.py --source <file> --link "<text>" [--locate] [--vault <绝对路径>]` | 步骤 4，自动生成合规 YAML |
| `scripts/scan_unresolved.py` | `python scripts/scan_unresolved.py [--vault <绝对路径>]` | 步骤 1 / 9 入口；obsidian CLI 不在 PATH 时回退 |
| `scripts/postcheck.py` | `python scripts/postcheck.py --snapshot <out>` / `--snapshot-before <json> --new-file <path>`（均可加 `--vault <绝对路径>`） | 步骤 8，校验新文件内部双链 |

vault 根的解析：**`cd` 到 vault 目录再跑脚本**（脚本沿父目录找 `.obsidian`）；不确定时加 `--vault <绝对路径>` 或环境变量 `NX_OBSIDIAN_VAULT=<绝对路径>`。也可以先跑 `nx-kn obsidian spec --json`，一次拿到 vault 根与两份规范文档的绝对路径。

---

## 验证清单（每篇笔记写完后必过）

- [ ] `head -3 <新文件>` 第一行是 `---`（YAML 起始）
- [ ] `head -10 <新文件>` 能看到 `creatime:`、`tags:`、`bklink:` 三段
- [ ] **新文件名不含 `, . ?` 等 Obsidian 不支持的字符**（如违反需重写标题，见上「标题 sanitization 规则」）
- [ ] `obsidian unresolved format=json` 列表里**没有**刚才的链接
- [ ] 跑步骤 8 `postcheck.py --snapshot-before ... --new-file ...`，退出码 0——确认新文件内部的双链也全部解析成功
- [ ] Obsidian 打开新文件后能看到 tags 列表、双链面板有反向链接

---

## 实际使用记录

> 这里只记 skill 在真实 vault 中调用时遇到过的案例，不记开发 / 移植 / 修复。每次调用前扫一眼，比新踩一遍坑强。

### 2026-06-16 — frontmatter 漏写

| 触发场景                                                       | 实际后果                                                            | 必须怎么做 |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| 生成"按理来说...JIT 都是一样的吗"笔记时，把步骤 4 和步骤 6 当并列步骤执行，跳过 `gen_frontmatter.py` 直接 Write 内容 | 笔记没有 `creatime` / `tags` / `bklink`，Obsidian 视为无元数据，**反向链接 / Dataview / Tags 聚合全部失效** | 步骤 4 是硬性步骤，不可跳过；写出第一行必须以 `---` 开头的 YAML |

### 2026-07-09 — 提问型双链被错误删除

| 触发场景                                                       | 实际后果                                                            | 必须怎么做 |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| `日常/游标方案 跨页如何解决.md` 第 9 行有 `[[你这个文档在解释什么东西]]`——这是读者提问 | 主线程按"伪双链"直接删除 → 读者提问丢失，用户当场拒绝（"这次执行居然不处理反而把双链取消"） | 问句也是有效双链；创建新文件 `你这个文档在解释什么东西.md`，正文围绕读者提问写一篇针对性回答（本文源主题 = 游标跨页方案的 L1→L4 还原论拆解，所以回答点明：本文用还原论拆解了 L1 API → L4 索引布局，解释为什么 keyset 会跳过并发写入的新数据） |

### 2026-07-09 — 新文件内部双链引用未校验

| 触发场景                                                       | 实际后果                                                            | 必须怎么做 |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| 写笔记后只校验 source 那边的 `obsidian unresolved` 链接消失 | 新文件里写的 `[[epoll 的内核实现　]]`（含全角空格）这种引用没被检测到；用户点开新笔记看到链接但跳到空白页 | 跑步骤 8 `postcheck.py`，做 snapshot diff；新文件**内部**的双链也要逐一确认能解析 |

---

## 参考文件

| 文件                                          | 用途                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `references/00-frontmatter-spec.md`         | 步骤 4 工具说明 + frontmatter 完整规范                                                          |
| `<vault>/nx-kn/base-content.md`（`{content_spec}`） | 步骤 6 规范：四种模式（概念深潜 / 实践拆解 / 还原论拆解 / 概念拓扑）+ 好坏例子——**在 vault 里，用户可随时改**（位置由步骤 0 解析） |
| `<vault>/nx-kn/questionnaire.md`（`{questionnaire_spec}`） | 问卷模式：针对性响应生成规范——同上，在 vault 里                              |
| `scripts/gen_frontmatter.py`                | 步骤 4：自动生成 frontmatter                                                                    |
| `scripts/scan_unresolved.py`                | 全 vault 扫描未解析链接（步骤 1 入口，obsidian CLI 不在 PATH 时回退）                          |
| `scripts/postcheck.py`                      | **步骤 8**：新文件写完后做"新文件内部双链引用校验"（基于 obsidian CLI diff，不用正则） |

---

## 注意

- `ctl/tmpl_*.md` 中的示例链接已用反引号转义，不会误判
- 元数据由脚本自动生成，AI 专注于内容
- **绝不要"为了节省时间"跳过 `gen_frontmatter.py` 步骤**——漏掉的 frontmatter 需要事后手动补全
- 单文件路径含中文 / 特殊字符时，`gen_frontmatter.py` 的 `--source` 参数必须用 UTF-8 编码的字符串
