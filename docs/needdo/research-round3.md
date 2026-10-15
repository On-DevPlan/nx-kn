# NeedDo 调研 · 第三轮（AI / agent 怎么接进收件箱整理）

日期：2026-10-15。三问：AI 介入的时机与形态 / AI 输出怎么落盘 / CLI 形态的 agent 交接协议。
对齐基线是本仓既有惯例：crawl 的 `--engine` + `--enhance-level 0-3` + `--agent`（把 LLM 用量表达成级别）、
`assets/nx-kn/SKILL.md`（教外部 agent 用本仓 CLI）、round2 已确立的「原文不动 + 元数据附挂（`links[]`）」。

## 一、AI 介入收件箱的时机与形态

### 现状速记（本仓）
- `process` 是纯确定性：有序 `TOPIC_RULES` 规则表 → 写死 `topic` + `status=done` + 写 markdown 报告；
  `--agent` 只把名字落在 `it.agent` 上，**没有任何 AI 环节**（`service.js` 的 `classifyTopic` / `process`）。
- 捕获 `add` 全程零 LLM、零外部进程；「原文一字不动」是收件箱的第一承诺。

### 产品速记
- **捕获时静默标注**（只出现在「垃圾桶类」）：Apple Mail 自动四分类（通知角标只数 Primary）；Superhuman Auto Labels / Auto Archive 是设置里开一次、AI 全库扫一遍，之后自动贴标与自动归档。
- **整理时人复核**（有语义代价的）：Linear Triage Intelligence 在 triage 那一遍自动贴 label、提 assignee，
  但**最终路由由人（goalie）拍板**；Gmail/Gemini 把邮件里的行动项做成「suggested to-dos，可确认或忽略」。
- **手动触发而非实时**：Notion AI Autofill **明确不是实时触发器**——新建行不会自动填，要人点一下才跑；Readwise Ghostreader 默认只对「手动保存」的文档自动摘要。
- 共同点：**越靠近「改变主视图结构」的动作，越晚介入、越要人拍板**；只有「分类进垃圾桶」才允许静默。

### 结论
NeedDo 的整理动作（改主题 + 归档 + 报告按主题分组）改变主视图结构，属第二类：**AI 只在整理期出现，且默认产出「建议」而非「结论」**。
捕获期一个 LLM 也不调——第一承诺是「立刻收下」，且「不调 AI」那条路必须能离线、能在 CI 里跑通。

## 二、AI 输出怎么落盘才不破坏确定性规则

### 现状速记（本仓先例）
- crawl 把 LLM 用量表达成**显式级别**：`--enhance-level 0-3`，`0` = 纯抓取、不调任何 LLM（非交互 / CI / 可复现），
  `1-3` = 抓后调外部 agent（默认 claude，`--agent` 换）。**不藏、不静默降级**（起不来直接报错并给两条出路）。
  store 归一化把它钉死：`Number.isInteger(level) && 0<=level<=3 ? level : 0`（`store.js` 的 `normalizeSource`）。
- 「谁写进来的」本仓已有惯例：kb 的 `origin: 'user' | 'crawl'`——**用户显式要的永不被自动规则降级**。
- round2 的 `links[]`：原文一字不动，抽取结果**附挂**在条目上（Slack unfurl 形态）。

### 产品速记
- git notes 的存在理由就是「附加/读取注释而**不影响对象本身**」，另有 `append` 与 `merge` 策略——注解是独立一层、可追加、可合并。
- Notion AI Autofill 把 AI 值放进**它自己的属性**（"🪄Fill with AI" 新建一个属性），不覆盖人写的字段。
- LLM 标注研究（CHI 2024 human-LLM collaborative annotation、VLDB 的 verifiable provenance）一致：逐条记 provenance（谁产出、什么模型/级别、何时），人复核才有依据。
- 重跑成本：Palantir 的 LLM 节点有 "Skip recomputing rows"（按输入列 + 参数做缓存键，命中直接取旧输出）；Redis 的 LLM 幂等文同调——**给结果一个确定性 key，重跑不重复花钱**。

### 结论（三条硬规则）
1. **确定性字段与 AI 字段分列**：`topic` 永远由规则表产出，AI 只能写 `ai.topic`。
   「可解释、可回归测试」这条不能被稀释。
2. **AI 结果是附注（append），不是覆盖**：与 `links[]`、git notes 同形；
   `content` / `title` / `excerpt` / `topic` / `status` 一个都不许动。
3. **级别显式**：用与 crawl 同一把尺子的 `0-3`，`0` = 零 LLM，默认 0。谁也不许「偷偷调一下」。

## 三、CLI 形态的 agent 交接协议

### 现状速记
- 每个按钮都有等价命令：一条 action 声明同时派生 CLI 与 HTTP（`registry.js` 启动期自检「Web 操作必须有
  CLI 等价」）；`--json` 是全局开关；未知 flag 直接报错（`cli.js` 的 `assertKnownFlags`）；
  HTTP body 里**未声明的键原样透传**（`api.js` → `applySpec`）。
- 本生态已有成熟先例——nx-kv 的收单 SOP（`~/.claude/skills/nx-kv/references/agent-workflow.md`）：**一次拿全**该 topic 的待办（`todo list --status open --topic X --json`），
  明令禁止「拉全量再自己过滤」；加工完写回**注解字段**（`todo done --ref … --result …`，不覆盖任务本体）；并把「幂等」「状态冲突 → CONFLICT」「部分不存在不算失败」写成可依赖的稳定契约。

### 产品速记
- **一次性结构化简报 vs 逐条调用**：Linear / 内容审核这类批量分类都是「一批一次评估」；逐条调用在 CLI 形态下要 N 次进程启动 + N 次 store 读写，agent 还得串行等。
- **写回形状**：Taskwarrior 用 `task <filter> annotate`（加注解）而非改写描述；git notes 同上；Copilot 的 Apply / Discard 是「建议 → 人逐条或整批接受」，且**应用 ≠ 自动提交**。
- **幂等与冲突**：确定性 key、重复提交是 no-op、原子写（临时文件 + rename——本仓 crawl manifest 已是这个写法）、乐观并发用**内容哈希锚定**（Oh-My-Pi 的 hash-anchored edits 同路数）。

### 结论
协议定成 **brief →（agent 离线加工）→ apply** 三步、两个命令，中间是一份自足 JSON 文件：一次调用拿全上下文（省 token、省进程），
写回是一份**计划文件**（可 diff、可重放、可存档），条目侧只追加 `ai` 段（可回归测试的确定性字段毫发无损）。

## 【核心】agent 交接协议建议（5 条；cli + http 同源、零新依赖）

### 1. 时机与级别：AI 只在整理期，用级别表达 —— `needdo process --enhance-level 0-3 [--agent <名>]`
- 形状照抄 `crawl add`：`'enhance-level': { type:'number', default:0, hint:'0-3' }` + `agent: { type:'string' }`；
  service 侧非 0-3 整数直接 `badInput`（**不静默回落**）；store 归一化照 `normalizeSource` 抄（越界/NaN → 0）。
- `0`（默认）= 纯规则，与今天的 `process` 一字不差；`1-3` = 本次允许外部 agent 复核
  （1 = 主题修正 / 2 = +一句话摘要 / 3 = +标签）。`0` 必须保证离线、CI、可复现——crawl §四那条纪律。

### 2. 交接形态：一次拿全的结构化简报 —— `needdo brief [--ids a,b] [--level 0-3] [--redo]`
- `GET /api/needdo/brief`，stdout 一份自足 JSON（`--json` 同物）。**一份 brief = 一次 agent 会话**；
  禁止逐条调用（nx-kv 已明令「不要拉全量再自己过滤」——过滤在 CLI 里做完）。
- 顶层 `batchId`（`nb-<时间戳>-<短哈希>`）；每条带 `id / kind / title / excerpt / links / addedAt /
  ruleTopic`（规则表预判，给 agent 一个「要不要修正」的基线）+ `rev`（内容哈希，照 crawl
  `sha256(...).slice(0,8)` 的做法）。
- 默认只导出**还没有 AI 建议**的条目，`--redo` 才含已建议的——对应 Palantir 的 "Skip recomputing rows"
  与 Readwise「只自动处理手动保存的」：重跑不重复喂、不重复花钱。

### 3. 写回形态：一份计划文件单次提交 —— `needdo apply --plan <file.json>`
- `POST /api/needdo/apply`。CLI 侧 `--plan` 是 JSON **文件路径**（与 `needdo add --file` 同一种「从路径读」
  的通道）；面板侧 body 直接带 `plan`（未声明键原样透传，`api.js` 既有行为）。
- 计划形状与 brief 一一对应，**只追加 `ai` 段**，绝不覆盖 `content/title/excerpt/topic/status`；
  `topic` 缺失或 null = 「我不改」（与 `TOPIC_MISC` 不硬猜同调）：
```json
{ "batchId":"nb-20261015-1830-7f3a", "agent":"claude", "level":2,
  "results":[{ "id":"nd-xxx", "rev":"a1b2c3d4", "topic":"待办事项",
               "summary":"…", "tags":[], "confidence":0.82 }] }
```
- `apply` **不动 `status`**：条目仍在收件箱，等复核接受后再 `process` 归档并写报告。

### 4. 落盘格式与 provenance 字段（store 归一化一处加分支）
```
ai: { level:2, agent:'claude', at:'2026-10-15T18:31:02Z', rev:'a1b2c3d4',
      topic:'待办事项', summary:'…', tags:[], confidence:0.82,
      status:'suggested' }              // suggested | accepted | rejected
```
- **幂等键 `(batchId, id, rev)`**：同一份 plan 重复 apply = no-op，回报 `unchanged`。
- **冲突（人也在动）**：条目 `rev` 与 brief 时不一致（被改过 / 已 process / 已删）→ 计入 `stale`，
  **跳过不报错**——对齐 `archive` 的 `missing` 口径（部分失效不算失败，静默空操作比报错更难查）。
- 返回 `{ applied, unchanged, stale, missing }`，数字说话。

### 5. 人复核路径：默认建议态，接受才生效 —— 面板按钮 + `needdo review --ids a,b [--reject]`
- **不静默应用**：AI 建议不改主视图、不进报告的分组。首版一律 `suggested`——Superhuman/Apple 那套静默应用
  只适用于「垃圾桶类 + 可逆 + 误判代价低」，而「主题 + 归档」不是。
- 面板：行与详情里加 `.tag`「AI 建议 · 待办事项（claude 0.82）」，旁边两个 `.btn.small.ghost` 接受 / 拒绝
  （复用现有类，零新 css）；低 `confidence` 只加标注，不自动丢弃。
- CLI 对等：一条 action 两个方向（照 `archive --undo` 的写法）——`review --ids a,b` 接受、`--reject` 拒绝；
  接受 = 写 `topic` 并记 `topicSource:'ai'`，拒绝 = 只清 `ai.status`。
- `topicSource: 'rule' | 'ai' | 'user'` 是 kb `origin: 'user' | 'crawl'` 的直系同类：
  **人显式定的永不被 AI 覆盖**。报告里 AI 建议只作附注行，`accepted` 后才并进正题。
- 这套协议要写进 `assets/nx-kn/SKILL.md`（新增「NeedDo 收件箱」一节 + 命令速查三行：brief / apply / review），
  否则外部 agent 找不到它——本仓给 agent 的接入点从来就是那份 SKILL.md。

## 附：主要来源
- 产品：superhuman.com/ai · blog.superhuman.com/how-sales-teams-can-organize-their-inbox/ · support.apple.com/en-gb/104971 · support.apple.com/en-gb/guide/mail/welcome/mac · mindstudio.ai/blog/what-is-google-ai-inbox-smart-email-prioritization-2
- Notion AI Autofill（非实时触发、AI 值独立属性）：notion.com/help/guides/accomplish-more-with-connected-project-management · wisechecker.com/notion-ai-autofill-not-running-new-database-row-fix/
- Readwise Ghostreader：docs.readwise.io/reader/docs/faqs/ghostreader · …/guides/ghostreader/custom-prompts
- Linear Triage（AI 自动贴标 + goalie 拍板）：linear.app/now/cx-in-linear · linear.app/docs/linear-agent
- Copilot Apply/Discard 与整批接受：learn.microsoft.com/en-us/training/modules/implement-code-improvements-using-github-copilot-tools/7-examine-github-copilot-code-review-features · github.blog/changelog/2026-09-18-copilot-code-review-an-improved-review-experience/
- 置信度分档与 HITL：devblogs.microsoft.com/foundry/content-understanding-confidence-grounding-hitl/ · theneuralbase.com/building-ai-products/learn/intermediate/confidence-thresholds/
- 注解不改原对象 / 幂等 / provenance：git-scm.com/docs/git-notes · manpages.ubuntu.com/manpages/xenial/man1/task.1.html · palantir.com/docs/foundry/pipeline-builder/pipeline-builder-llm · redis.io/blog/what-is-idempotency-in-redis/ · openreview.net/forum?id=UDnZX86Krz · dl.acm.org/doi/10.14778/3836663.3836668
- 本仓/本生态：`src/modules/crawl/{index,service}.js` · `src/core/store.js` · `assets/nx-kn/SKILL.md` · `~/.claude/skills/nx-kv/references/agent-workflow.md`
