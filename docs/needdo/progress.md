# NeedDo 模块进度（rp-loop 10 轮迭代）— 已结项

> 任务：nx-kn 新增 NeedDo 模块——混乱输入收件箱（文字/公告/链接/PDF/DOCX → 用户目录存储 → CLI/agent 按主题整理）。
> 本文件每轮更新：本轮完成 / 遗留问题 / 下轮建议。

## 结项说明（2026-10-18）

needdo 模块整体从 nx-kn 移除，迁到 nx-sk 的 skill 形态（**sk-needdo**）：
- 命令面板（`needdo add / list / show / edit / process / brief / apply / review / archive / export / trash / remove / file`）已全部退场
- 数据目录 `<store>/needdo/` 不再被本工具读写；曾用过的用户可视为遗留数据，自行归档后删除
- 收件箱的核心场景由 sk-needdo 接管：丢入混乱输入 → agent 发现/建立对应栏目 → 自动
  设计字段字典 → 把每条填进对应条目 → md 字段的 `- [ ]` 任务清单在 nx-sk 面板里
  **点击即勾选、写回**

为什么从 nx-kn 迁出：needdo 的「条目没有强 schema」与 nx-sk 的「一个栏目一种形状」
互补；做完这一步之后，AI 不再单独维护「条目 / 主题 / AI 附注」一套数据模型，而是直接
产出符合栏目结构的条目。需要结构化记录的混乱输入，直接走 nx-sk 的栏目；需要被检索
但本身没形状的素材，原本就属于知识库的采集域（crawl），与 needdo 无关。

下面的研究日志（round1～round5 + 进度）作为历史档案保留，不再更新。

---

## Round 1 · 2026-10-15