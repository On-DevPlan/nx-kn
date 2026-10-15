# NeedDo 调研 · 第五轮（出口：整理完之后怎么沉淀）

日期：2026-10-15。本轮问：条目整理完之后，怎么沉淀到可长期检索的地方（kb 域）？r1–r4 已覆盖捕获/拖放/归档二态、详情/多选/链接、AI 复核协议、找/改/撤，本文不重复。
对齐基线：本仓**唯一**成型的沉淀先例是 crawl（`sources/<源名>/**/*.md` → 自动登记为知识库），以及 needdo 自己的 `process` 报告。

## 一、成熟产品的沉淀路径

### 现状速记（本仓）
- NeedDo 今天的「沉淀」只有 `process` 报告（`needdo/processed/<stamp>.md`）：**一篇流水**——按主题分组的列表 + 摘录 + 链接 + 原件路径；文件名是时间戳、不是一条一篇、不进任何可检索的地方。唯一的「产物 → 知识库」模具是 crawl（见第二节）。
- 可复用资产：`revOf(item)`（8 位内容指纹）、`ai.batchId`（整批幂等痕迹）、`apply`/`archive` 的 `stale`/`missing`「数字说话」口径；条目字段是**白名单**归一化（新字段不写进 store.js 就被静默抹掉）。

### 产品速记
- **Readwise → Obsidian**：装进 vault 的官方插件，可设「有新划线就自动同步」；导出格式用 **Jinja2 模板**自定义（文件名、frontmatter、正文），原 URL/作者/章节/标签随导出写入。→ **自动同步 + 模板化**。
- **Obsidian Web Clipper**：模板四件套 = 笔记名（`{{title|safe_name}}`）、**路径**（`Clippings/{{date|date:"YYYY/MM"}}`）、
  **properties**（= YAML frontmatter）、正文；另有 behaviour（新建/追加/覆盖/追加到日记）与按 URL/schema.org 选模板的触发器。
  → **每次捕获即按模板落盘**，无中间库。
- **Notion Web Clipper**：保存时选目标库；**加进 database 时自动补一个 URL 属性**（原来没有也会补），标题/标签可当场加也可跳过。→ **一键导出，落到结构化库**。
- **Drafts（最近亲）**：入口永远空白草稿，出口是一排 action；**动作跑完后原稿去向可配**——默认归档/删除/保留，单个 action 还能覆盖默认（「发推后删除」）。→ **一键导出 + 原条目去向显式可选**。
- **Instapaper / Pocket / Apple Notes**：Instapaper 的归档只是移出未读列表，归档件留在库里且**标签保留**（9.0 说明：archived articles retain their tags）；Pocket 的出口是整库 CSV；Apple Notes「共享 → 添加到快速备忘录」直接成篇。→ **归档是状态、沉淀是目的地，是两件事**。
- **一键导出 vs 自动同步**的差别不在交互，在「谁承担冲突」：自动同步（Readwise / Obsidian Sync）都得配一套冲突解决（Sync 用 diff-match-patch 合并，或生成 `(Conflicted copy …)` 副本让人手修），一次性导出根本不用回答。
- **改名有实证代价**：Readwise Mirror 2.x 改了文件名生成规则 → **直接打断已有内部链接**；官方迁移办法是「升级前先在 frontmatter 补一个 `uri` 追踪属性」。文件名可变，**稳定键必须先落在文件里**。

### 结论
1. 走**手动、显式、批量**的一键导出，不做自动同步：本仓零后台进程、零账号、零网络（`--enhance-level 0` 那条纪律），而自动同步必然要双向冲突解决——本仓**没有任何双向先例**（crawl 写完就不读）。
2. **不做模板引擎**：Web Clipper 要一整套变量 + 过滤器（`safe_name`）+ Twig 语法，Readwise 用 Jinja2——引入它 = 引入依赖，还多一个「用户把模板写坏」的失败面。可改的点收敛到两个 flag：`--to`（目标根）与主题（来自条目本身，用 `needdo edit --topic` 改）。
3. 目录/文件名/frontmatter 由**服务端固定规则**定（谁决定=代码；能不能改=不能，只能换目标根）——与「paths.js 是参数化中心、不在别处拼字符串」同一条纪律。
4. 导出后**原条目留着**、归档状态不动（Drafts 那套「动作后归档」做成可选 flag），条目上记「已沉淀」——对齐 Readwise/Notion：源库不动，导出是镜像。

## 二、复用 crawl 这个模具（硬约束）

### 现状速记（三处必读）
- `crawl run`（`crawl/service.js` 852–902）：产物落**普通 markdown 目录** `<数据目录>/sources/<源名>/`（每页 frontmatter
  `source`/`title`/`fetchedAt` + `engine`），写完在 `mutateStore` 里 push `{path,name,model:null,addedAt,origin:'crawl'}`；
  **有内容才登记**（「空目录进列表只会让人困惑」）；**不自动建索引**（返回 `hint: 跑 nx-kn index --root …`）；
  陈旧产物靠源目录里的 `.nx-kn-crawl.json` 增量清单清理。
- frontmatter 工具：`yamlScalar()`（可疑值加引号转义）+ `withFrontmatter()`（已有 frontmatter 不叠加）；产物哈希只算正文，理由是 `fetchedAt` 每次都变（`service.js:520` 注释）；产物与源目录重叠时**只报告不排除**（排除在 `store.js` 的 `standbyVaults`）。
- 登记记录：`normalizeVault` 是白名单，`origin ∈ {'crawl','user',null}`；`kb add` 把已存在记录提成 `'user'` =「我确认要它」，
  `standbyVaults` 只收 `origin !== 'user'` 的；`kb remove` 的立场是「索引留在原 vault，nx-kn 不代删」。
  路径一律从 `paths.js` 取（跟 `NX_KN_STORE` 走 = 测试天然隔离）。

### 结论
1. 导出物 = **普通 markdown 目录 + 自动登记**，与 crawl 逐字同构：落 `<数据目录>/needdo/export/<主题>/`、写 frontmatter、`store.kb.vaults.push({origin:'user'})`、返回 `hint` 而非自动建索引（zg 子进程 + 可能 600MB 模型下载，不能藏在副作用里）。
2. 目标根**只能是 `needdo/export/`，绝不能是 `needdo/`**：后者装着原件二进制、提取 txt、`trash/` 和 `processed/` 报告——`VAULT_EXCLUDES` 只有 `.obsidian`/`.trash`，登记它等于把回收站与流水报告一起塞进索引。
3. `origin` 用**既有的 `'user'`**，不加第四个枚举值（r4 的原则：零新枚举值）。功能上等价（`standbyVaults` 只收 crawl 产物，export 目录不可能是任何源的产物路径），`kb list` 也不渲染 origin，不构成误导。
4. **不建第二份清单**（不做 `<export>/.nx-kn-needdo.json`）：crawl 需要 manifest 是因为「远端已删页面」推不出来，而 NeedDo 的源就是 store 自己——权威记录放条目侧（`exportPath`），第二份清单只会分叉。

## 三、单向还是双向

### 现状速记
- 本仓**没有任何双向同步**：crawl 写完即止（产物可重抓重建）；`kb watch` 监听的是用户自己的 vault，不写回；`crawlProductVaults` 明确「不做内容相似度去重」（哈希与路径都对不上，只剩标题可猜，猜错更糟）。
- 已有两类幂等判据：`ai.batchId`（整批痕迹——重放旧计划不许覆盖人的决定）与 `revOf(item)`（内容指纹 → `stale`）；
  已有产物处置语言：`apply` 的 `stale`、`archive` 的 `missing`（部分失效不算失败，但数字要说话）；
  坏文件用 rename 留档（`store.js` 的 quarantine）；`pruneStalePages` 只删「上一次 manifest 记录过的文件」。

### 产品速记
- 自动同步侧（Readwise / Obsidian Sync）都必须回答冲突；一次性导出侧（Notion 剪藏 / Web Clipper / Apple Notes 导入）根本不回答——**导出物是副本，改的是副本，源不动**。
- 「这是生成物」的通行写法：Elastic 文档生成器有 `{{ generatedHeader }}`（顶部插一条「自动生成，请勿手改」）；Obsidian 的 AUTO-INDEX 用 `<!-- AUTO-INDEX:START … do not edit by hand -->` 圈出生成区间。

### 结论
1. **严格单向**：导出物是产物（可重建，同 `sources/` 的定位）。人在 vault 里改了那份 md，**不回流**；要改就改收件箱条目再 `export --redo`——**覆盖那一刻以条目为准**。
2. **不移动已落盘的文件**：路径首次导出时定死并记进条目（`exportPath`），`--redo` 只刷新内容、不因主题变了搬家——移动文件会打断别的笔记对它的链接（Readwise Mirror 的实证）。
3. **不代删产物**：源条目进回收站/被删后，产物留在原处（`kb remove` 同款立场：产物归用户，nx-kn 不代删）。v1 不做 prune——`--to` 可能指向用户的真 vault，代删风险远大于收益。
4. **判据用条目指纹，不用产物文件哈希**：frontmatter 里的 `exportedAt` 每次都变，拿它算哈希会永远「变了」（正是 crawl 把 frontmatter 排除在哈希外的原因）。「已沉淀」= `exportRev === revOf(item)` 且产物文件仍在。

## 【核心】五条可落地建议

### 1. `needdo export`：一条 action 两个面，手动批量沉淀
- CLI `nx-kn needdo export [--ids a,b] [--topic T] [--redo] [--to <目录>] [--archive]`，HTTP `POST /api/needdo/export`（同一条 action 派生，`--json` 全局开关照旧）。
- 默认选区：`status==='done'` 且未沉淀过（`!exportedAt`）——与「整理 → 沉淀」的漏斗一致；`--ids a,b` 可指名**任意**条目（含 inbox）；`--topic` 是**过滤**（enum 取 `service.TOPICS`，与 `needdo list --topic` 同义，不发明第二个含义）。
- `--redo` = 连已沉淀的一起重写（crawl `run --rebuild` 的同位）；`--to <目录>` = 换目标根（给了就**不自动登记**，那是用户的库，用既有 `kb add` 管）；`--archive` = 导出后顺手归档（Drafts「动作后原稿去向」，显式可选、不默认）。
- 返回数字对齐 `apply`：`{exported, updated, unchanged, skipped, missing, dir, registered, hint}`；`skipped` 带原因。

### 2. 导出物约定：`<数据目录>/needdo/export/<主题>/<日期>-<slug>-<条目id>.md`
- 目录 = 主题（条目自己的 `topic`，与 `process` 报告分组同轴；主题名过一遍文件名清洗——`/` `\` `..` 一律替换，否则 `edit --topic` 能造出路径穿越）。
- 文件名 = 本地日期 + 标题 slug（保留中文，只替换 `\/:*?"<>|`、空白压 `-`、截 40 字）+ **完整条目 id**：唯一性不靠碰撞计数（同名标题各成一篇），且能从文件名 grep 回源条目。
- frontmatter（与 crawl 同位置同风格，`yamlScalar` 同款转义）：
```yaml
---
id: nd_m9x2k1a            # 稳定键 = 源条目 id（Readwise Mirror 的 uri 追踪属性同款）
source: needdo            # 产物来自哪个域（crawl 这里放源 URL）
title: 明天下午三点开会
topic: 待办事项
kind: text                # text | link | file
url: https://…            # 可选：link 条目、或正文里抽到的首个链接
addedAt: 2026-10-15T09:12:00.000Z
exportedAt: 2026-10-15T10:00:00.000Z
---
```
- 正文：`# <title>` + 内容本体（text 全文 / link 网址 / file 提取文本 + 一行原件路径）。**文件条目只写 md、不搬原件**；提取不出文本的 file 条目跳过并计 `skipped`（无文本的产物进库没有检索价值）。

### 3. 「已沉淀」记在条目上，三个字段（必须进 store.js 白名单）
- `exportedAt`（ISO）、`exportPath`（相对目标根，如 `待办事项/2026-10-15-…-nd_m9x2k1a.md`）、`exportRev`（导出时的 `revOf`）。
- **幂等判据**：`exportRev === revOf(item)` 且 `stat(exportPath)` 命中 → `unchanged` 跳过；否则写（首次 = `exported`，内容变过 = `updated`）。重跑 `export` 无副作用 = crawl run 的 added/updated/unchanged 语义。
- 产物 frontmatter 里的 `id` 是**文件侧锚点**（人/外部工具按文件反查条目）；清单侧不另建。

### 4. 面板：卡头一个按钮 + 行内一枚 `.tag`
- 条目卡 `colhead` 加 `.btn`「沉淀到知识库」（`POST /api/needdo/export`，空 body = 默认口径），busy/toast 沿用 `withBusy`；有可沉淀条目时 colhead 显示「N 条可沉淀」（与 r3 遗留的「N 条待 AI 复核」同款计数）。
- 行内与详情加 `.tag`「已沉淀」（灰），详情 Modal 给 `exportPath` + `Copyable`；成功 toast 带上目标目录与命令。
- 复用清单：`useToast` / `withBusy` / `.tag` / `Copyable` / `CliHints` / `.row`——零新依赖、零新 UI 原语。

### 5. 「会不会碰 kb 域」：**不碰 kb 域的代码，只写 kb 域的数据**
- 改动面：`src/core/paths.js`（加 `needdoExportDir()`——paths.js 自己的注释写明路径必须从这里取）、
  `src/core/store.js`（`normalizeNeeddoItem` 白名单补 3 个字段，**不补就每次写入被静默抹掉**，r4 已踩过一次）、
  `src/modules/needdo/{service,index,view}.jsx`、`assets/nx-kn/SKILL.md`、README/CHANGELOG、
  `tests/unit/needdo.test.mjs` + `tests/smoke.mjs`。
- `src/modules/kb/*` **一行不动**：登记后 kb 的 list/index/query/watch 原样消费它，与 crawl 产物完全同构——这就是「同一个模具」的全部含义。零新依赖：`yamlScalar` 是 crawl 的模块私有函数，needdo 抄 5 行 + 注释注明出处。

## 附：主要来源
- Readwise：docs.readwise.io/readwise/docs/exporting-highlights/obsidian · community.obsidian.md/plugins/readwise-official · community.kepano.dev/plugins/readwise-mirror（`uri` 追踪属性 / 改文件名断链）
- Web Clipper：obsidian.md/help/web-clipper/templates · help.obsidian.md/web-clipper/variables · deepwiki.com/obsidianmd/obsidian-help/8.1-web-clipper（noteNameFormat / path / properties / behaviour）
- Notion 剪藏：notion.com/help/web-clipper（进 database 自动补 URL 属性）· Drafts：applevis.com/apps/ios/productivity/drafts · jbguide.me/2013/drafts-preparation（动作后归档/删除/保留 + 单动作覆盖）
- Instapaper / Pocket / Apple Notes：apps.apple.com（archived articles retain their tags）· androidauthority.com/export-pocket-library · support.apple.com/zh-cn/102223
- 生成物标记与冲突：elastic.co/docs/extend/integrations/finishing-touches · dev.to/hideyukimori（AUTO-INDEX do not edit）· obsidian.md/help/sync/troubleshoot（冲突副本 / diff-match-patch）
- 本仓：`src/modules/crawl/service.js` · `src/modules/kb/service.js` · `src/core/store.js` · `src/core/paths.js` · `assets/nx-kn/SKILL.md` · `docs/needdo/progress.md`
