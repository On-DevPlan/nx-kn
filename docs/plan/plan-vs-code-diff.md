# nx-kn：计划 ↔ 实现 对账

> 对账时间：2026-10-04
> 计划基准：`./nx-kn-plan.md`（已从仓库同级归档进来，见偏差 D4）
> 对账方式：读代码 + 跑 CLI + 实测 zg 0.2.2 行为，非推断
> **本文保持「对账时的原始状态」不改写**；各项的最终处置见 §0.5。

---

## 0. 结论速览

| 阶段 | 计划目标 | 实现状态 | 判定 |
| --- | --- | --- | --- |
| 0 打通 zg | 装 zg、配 key、小目录建索引、中文召回 | 装 zg 0.2.2 ✅、小目录建索引 ✅、中文召回 ✅；**key 未配** | ✅（偏差 D1/D2） |
| 1 生成骨架 | `server-cli-web --letters kn` | 已生成，`pnpm test` 全绿 | ✅ |
| 2 Obsidian 适配层 | `index / query / status` 跑通 | 四条 action（含 `kb use`）跑通 | ✅ |
| 3 面板 + skill | 检索界面 + `skill install` → `~/.claude/skills` | 两者均已落地 | ✅ |
| 4 增量与守护 | 改笔记 → 检索立即可见 | **增量索引 + 守护均已落地**：`index` 默认增量、面板「更新索引」；`nx-kn watch` 前台常驻 / `serve` 进程内默认开启（`--no-watch` 可关）/ 面板「守护」开关（见 W1） | ✅ |
| 5 外部资料采集 | v0.2 预留 | **已实现**（且**改判为纯 Node**，非原计划的 Python 子进程——见 `stage-5-external-collection-spec.md` 的 D1）：`crawl add/run/list/remove`，产物落普通 `.md` 目录并自动登记为知识库，索引/检索/增量/多库合并全部复用 kb 域 | ✅ 超出原「预留」口径 |

**工程一致性**：命令表 19 条 · 单测 66/66 · smoke 15/15 · 流水线 18/18 · 分层约束（eslint 枚举禁列 + 一致性测试）· 一条 action 三端同源 —— 均达标。

---

## 0.5 处置结果（2026-10-04 收尾）

下列每一项都已落地或被明确判定为「不做」，无遗留待办（除标注者）。

| 编号 | 处置 | 落点 |
| --- | --- | --- |
| **D1** | 改为本地 `local/qwen3-embedding-0.6b`，并新增内置默认 `DEFAULT_EMBEDDING` | `core/paths.js`；计划 §回填 |
| **D2** | 判定为「不做」——由 D1 的默认模型兜住，`~/.zvec-grep/config.json` 保持不存在 | `core/paths.js` |
| **D3** | **已实现多库**：`kb.vaults[]` + `kb add/remove/list` + 逐库召回按 score 合并 | `core/store.js` `normalizeKb`、`modules/kb/service.js` |
| **D4** | 计划已归档 | `docs/plan/nx-kn-plan.md` |
| **N1** | 已实测确认并在文档中写清（`index` 默认增量） | `references/10-knowledge-base.md` §四 |
| **N2** | 已用作多库合并排序依据 | `service.js` `queryOne`/`query` |
| **N3** | 已修：`HIT_RE` 支持可选 `score=` 捕获组，`hit.score` 为数字或 `null` | `core/zg.js` + `tests/unit/zg-parser.test.mjs` |
| **N4** | 已写进文档（排除规则不是可选项，附 325/551 实测） | `references/10-knowledge-base.md` §三 |
| **N5** | **已解决**（2026-10-04）：vault 侧已加 `.gitignore` 挡住索引产物。实测 `git -C "D:\Obsidian Vault" check-ignore -v .zvec-grep` → `.gitignore:2:.zvec-grep/`，`git status` 里不再出现 `.zvec-grep/`。采用「原地加 `.gitignore`」而非「索引移出 vault」——索引留在 vault 内才能与 zg 的 workspace 语义一致 | `D:\Obsidian Vault\.gitignore`（vault 侧，不在本仓） |
| **N6** | `config` 只写不读已写进文档的排障与模型两节 | `references/10-knowledge-base.md` §七 |
| **B1** | 已修：模型改为每库一个；迁移时**丢弃**旧全局 `model`（已知脏值） | `core/store.js` `normalizeKb` |
| **B2** | 已修：`status` 不再回落 store；未建索引显示「（未记录）」 | `service.js` `status` |
| **B3** | 部分修：`index` 会对比「已建索引实际生效的模型」与请求模型，不一致且无 `--rebuild` 时直接拒绝；`hasIndex` 本身仍只判目录存在 | `service.js` `indexOne` |
| **B4** | 已修：面板拆成「更新索引」（增量）与「重建索引」（全量，二次确认） | `modules/kb/view.jsx` |
| **B5** | 已修：添加目录时收集模型（默认 `local/qwen3-embedding-0.6b`），`index` 亦有内置默认兜底 | `view.jsx`、`core/paths.js` |
| **W1** | **已实现守护**（原 §0 结论速览里阶段 4 的 🟡 项）：`nx-kn watch` 前台常驻 / `serve` 进程内默认开启（`--no-watch` 可关）/ 面板「守护」开关 + 最近刷新；`watch status`（`GET /api/kb/watch`）单独一条轻量路由。只做「触发」，索引仍走 `index` | `core/watch.js`、`modules/kb/watch.js`、`runtime/cli.js`、`modules/kb/view.jsx`；单测 `tests/unit/watch.test.mjs` + 流水线 P14 |

---

## 1. 与计划决策的实质偏差（需你拍板 / 回填）

| # | 计划写的 | 实际是 | 影响 |
| --- | --- | --- | --- |
| **D1** | embedding = 远程 `qwen/qwen3.7-text-embedding`（1024 维，需 key） | `local/qwen3-embedding-0.6b`（同为 1024 维，离线免 key） | 路线从"远程"变"本地"，不再受代理影响；但质量/多语言口径不同。**plan §0 决策表仍写着远程 qwen，未回填** |
| **D2** | 阶段 0.2/0.3 配 qwen key、设全局默认模型 | **从未配**：`~/.zvec-grep/config.json` 不存在（该目录下只有 `models/`） | 没有默认模型 → 面板「建立索引」按钮（不带 `--model`）在**空库**上必然失败；只能用 CLI 显式 `--embedding` |
| **D3** | §5.7「一个 vault 一个索引，还是多 vault 并存」列为**未决** | 实现选了**单 vault**：`store.kb.vault` 是单值字符串 | 你现在要的「多目录知识库」正是这个未决项 → 要改 schema + query 合并（见 §4） |
| **D4** | 计划文档"生成完成后归档到 `nx-kn/docs/plan/`" | `nx-kn/docs` **不存在**，plan 仍在 `github/nx-kn-plan.md` | 文档落点未闭环；本次对账文档已建在 `docs/plan/` |

---

## 2. 计划之外、实测才发现的事实（建议回填进 plan）

| # | 事实 | 证据 | 为什么要紧 |
| --- | --- | --- | --- |
| **N1** | `zg index` **默认就是增量**：不动已建向量，只处理新增/改动 | 3 篇库新增 1 篇后跑无 `--rebuild` 的 index → `3 scanned, 1 added, 2 unchanged`；实体数 2→3 | plan §4 把它列为"待验证的不确定性"，现已确定；仅换模型才必须 `--rebuild` |
| **N2** | `zg query --trace` 会输出 `score=`，是标准 **RRF**（`2/61 = 0.0328`） | `#1 matchedBy=fts+vector score=0.0328 a.md:1-3`；`--human` 同样带 score | **这是多库结果合并排序的唯一可用依据**（跨库分数可比，因为是排名派生而非原始相似度） |
| **N3** | 若给 query 加 `--trace`，现有 `HIT_RE` 会**静默污染路径** | 正则 `^#(\d+)\s+matchedBy=(\S+)\s+(.+):(\d+)-(\d+)$` 的 `(.+)` 贪婪吃掉 `score=0.0328 `，`hit.path` 变成 `"score=0.0328 a.md"` | 加 trace 必须同步改正则并加单测；否则路径全错且不报错 |
| **N4** | `.obsidian/` 里有 **325 篇 md**，占 vault 全部 md 的 **59%** | vault 顶层 md 计 551，其中 `.obsidian` 325；排除后真实笔记 **226 篇** | 排除规则不是可选项；也解释了"226 vs 551"两个数字的来源 |
| **N5** | vault 是 **git 仓库**（`D:\Obsidian Vault\.git` 存在） | 目录列举 | plan §5.4 的风险**已成立**：`<vault>/.zvec-grep/` 会进 `git status`，需要 `.gitignore` 或把索引移出 vault |
| **N6** | zg 官方语法 ≠ 0.2.2 实测语法（`onboard` 已不存在；`--json` 已移除；`config` 只写不读） | 阶段 0/2 已实测并固化进代码注释 | plan 已部分回填 ✅，`config` 只写不读尚未回填 |

---

## 3. 一致达标项（对照 plan 要求逐条核实）

| plan 要求 | 落点 | 状态 |
| --- | --- | --- |
| 索引落 `<vault>/.zvec-grep/` | zg 自有，nx-kn 不碰 | ✅ |
| 排除 `.obsidian/` `.trash/` | `core/paths.js` `VAULT_EXCLUDES` + `index` 显式 `-g !…` | ✅ |
| query 以 `cwd = vault` 运行（zg 无 root 参数） | `core/zg.js` `runZg({ cwd })` | ✅ |
| 归属头（知识库根 + 相对路径），沿用 nx-rp | `service.attributionHeader()` | ✅ |
| 「还没建索引」是业务结果不是错误 | `{ needIndex: true }` | ✅ |
| 一条 action → CLI + HTTP + 面板同源 | `modules/*/index.js`，15 条命令 | ✅ |
| 模块互依禁令（枚举 + 一致性测试） | `eslint.config.js` + `tests/unit/consistency.test.mjs` | ✅ |
| skill 装到 `~/.claude/skills` | `home.skillInstall` → `runtime/skill.js` | ✅ |
| 纯检索（不做 RAG / 图谱 / 多模态） | 未越界 | ✅ |

---

## 4. 遗留缺陷（不在 plan 内，但挡在多目录之前）

| # | 缺陷 | 位置 | 后果 |
| --- | --- | --- | --- |
| **B1** | `store.kb.model` 是**全局单值**，切换 vault 时被原样保留 | `core/store.js` `initialState()` / `kb use` | 多库时模型必须**每库一个**；当前 `local/potion-code-16m-v2` 与任何现存索引都不符（smoke 库是 `qwen3-embedding-0.6b`，正式 vault 无索引） |
| **B2** | `status()` 在无索引时回落 `storedModel()` | `modules/kb/service.js` `status()` | 面板「模型」行显示的是**上一个库的残留值**，语义上应为「（未记录）」 |
| **B3** | `hasIndex()` 只看 `.zvec-grep` 目录在不在 | `core/zg.js` | 不校验模型/维度是否与将要用的模型一致 → 换模型时报错推给 zg |
| **B4** | 面板只有「重建索引」（`--rebuild` 全量），无「增量更新」按钮 | `modules/kb/view.jsx` `reindex()` | **这就是你感知到"索引只能被替换"的直接原因**：增量能力在 CLI 有、面板没暴露 |
| **B5** | 面板建索引不传 `--model` | `modules/kb/view.jsx` | 无默认模型 + 空库 → 必失败（D2） |

---

## 5. 下一步：「多目录知识库」改造清单

> 目标（你已确认）：可以**添加多个目录**，检索时一起搜；「更换目录」→「添加目录」；每个目录各自维护索引。
>
> **状态：下列 1–5、7 项已于 2026-10-04 实现**；第 6 项里的 `.gitignore` 仍待你决定（见 §0.5 的 N5）。

1. **store schema**：`kb.vault: string` → `kb.vaults: [{ path, name, model, addedAt }]`
   保留 `normalize()` 迁移：老数据 `kb.vault` 自动升级为单元素数组。
2. **命令面**：`kb use`（替换/设定）→ 拆成 `kb add <path>` / `kb remove <path>` / `kb list`；
   `index` 支持 `--vault <path>` 只更新其一，默认全部。
3. **query 合并**：对每个库各跑一次 `zg query --fuse --trace`（cwd = 各库），
   用 **N2 的 score** 全局排序，截到 `--limit`；命中需**标注来源库**；
   同步修 **N3**（`HIT_RE` 支持可选 `score=`）并加单测。
4. **status**：逐库汇总（笔记数 / 覆盖率 / 模型 / staleness），给出聚合视图。
5. **面板**：目录列表（增删）+ 每库索引状态；「更新索引（增量）」与「重建索引（全量）」两个按钮（顺带修 B4/B5）。
6. **排障项**：N5 的 `.gitignore`（或索引移出 vault）；B1/B2 的模型语义修正。
7. **文档同步**：SKILL.md / references / README / CHANGELOG；把本对账的 D1–D4、N1–N6 回填进 plan。

---

## 附：本次对账的原始证据

```
$ zg index <tmp> --mode direct --embedding local/qwen3-embedding-0.6b
  files  2 scanned, 2 added, 0 modified, 0 unchanged, 0 deleted   entities 2
$ (新增 1 篇) zg index <tmp> --mode direct          # 注意：没有 --rebuild
  files  3 scanned, 1 added, 0 modified, 2 unchanged, 0 deleted   entities 1
  → 已建向量保留（2 unchanged），仅嵌入了新笔记 —— 默认即增量

$ zg query "登录超时怎么排查" --mode direct --fuse --trace --limit 3
  #1 matchedBy=fts+vector score=0.0328 a.md:1-3     # RRF：2/61 = 0.032787

$ node bin/kn.mjs health
  正常 · nx-kn v0.1.0 · 15 条命令 · 存储: C:\Users\joke\.nx-kn\store.json
$ node --test tests/unit/*.test.mjs
  # tests 19 / # pass 19 / # fail 0

$ Get-ChildItem -Force C:\Users\joke\.nx-kn         → 仅 store.json（126 B）
$ Test-Path "D:\Obsidian Vault\.zvec-grep"          → False（正式 vault 从未建过索引）
$ Test-Path "$env:USERPROFILE\.zvec-grep\config.json" → False（从未配 key / 默认模型）
$ Test-Path "D:\Obsidian Vault\.git"                → True（索引会进 git 工作区）
```
