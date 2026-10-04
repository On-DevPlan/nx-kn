# nx-kn

Obsidian 知识库检索（zg 引擎）

```bash
pnpm install
pnpm start    # 构建并启动面板
```

## 它是什么

把本机的若干 Obsidian vault 当成知识库，用 [zvec-grep](https://github.com/zvec-ai/zvec-grep)（CLI 名 `zg`）
做「精确 + 关键词 + 语义」混合检索。可以加多个目录，检索时逐库召回、
按融合分（RRF）合并成一张列表，每条标出所属库。本机工具：CLI 与 Web 面板共享同一份
action 声明（`src/modules/*/index.js`），一条命令三端同源——CLI、HTTP API、面板按钮不会分叉。

| | |
| --- | --- |
| CLI 命令表 | `nx-kn help`（或 `routes` 看命令 ↔ 路由对照） |
| Web 面板 | `pnpm start` 后打开 `http://127.0.0.1:7881` |
| 数据 | `~/.nx-kn/store.json`（原子写；环境变量 `NX_KN_STORE` 覆盖） |
| 索引 | 每个库各自的 `<vault>/.zvec-grep/`（由 zg 拥有） |
| 自检 | `nx-kn health` |

### 上手

```bash
npm install -g @zvec/zvec-grep        # 召回引擎（需 Node ≥ 22）
nx-kn kb add D:\Obsidian Vault        # 加一个知识库（可加多个，写进 store.json）
nx-kn kb list                         # 看有哪些库
nx-kn index                           # 建索引（默认增量、只收 md；每个库一份）
nx-kn query "登录页为什么提示超时"      # 跨全部库检索
nx-kn status                          # 各库的索引状态 / 生效模型 / 覆盖度
```

`query` 的输出带一段归属头（每个库的根 + 库名）；多库时命中带 `[库名]` 前缀，
agent 拿到后可以拼出绝对路径去读全文。`--json` 给结构化 `hits[]`
（`path / start / end / heading / snippet / matchedBy / score / vault / vaultName`）。

`index` 不带 `--rebuild` 就是**增量**（zg 默认行为：只嵌入新增/改动的文件）；
只有换 embedding 模型才需要 `--rebuild`。面板上也分成「更新索引」与「重建索引」两个按钮。

## 结构

```
src/
├─ core/      基础设施：paths（参数化中心）/ errors / store（JSON 持久化）/ zg（召回引擎驱动）/ open
├─ modules/   功能域，各含 index.js（action 声明）+ service.js（业务）+ view.jsx（面板）
│   ├─ home/       示例域（读路径）
│   ├─ settings/   示例域（写路径：面板表单 → POST → mutateStore → CLI 同源可读）
│   └─ kb/         知识库域：kb add / kb remove / kb list + index / query / status
├─ runtime/   装配：registry（action 汇合）/ cli / api / server / spec
└─ web/       React 面板壳（vite 构建，产物被零依赖 node:http 服务）
docs/
└─ plan/      计划文档与「计划 ↔ 实现」对账记录
```

模块之间禁止互相依赖（eslint 枚举式禁列 + 一致性测试强制），共享逻辑下沉 `core/`。

## 加一个功能域要碰哪几处

以 `kb` 域为例（A07 闭环清单），漏掉带 ❗ 的几处**不会报错**，只会静默失效：

| # | 落点 | 漏了会怎样 |
| --- | --- | --- |
| 1 | `src/modules/<域>/{service,index,view}` | 功能不存在 |
| 2 | `src/runtime/registry.js` 的 `MODULES` | 模块整个不生效（一致性测试会红） |
| 3 | `src/web/frontend/registry.js` 的 `VIEWS` | 面板少一个 tab（一致性测试会红） |
| 4 | `src/index.js` 的 `export * as <域>` | 库用方拿不到 service ❗**无断言** |
| 5 | `eslint.config.js` 的 files + group 禁列 | 模块互依规则对它失效 ❗**无断言** |
| 6 | `tests/unit/*`（纯逻辑）与 `tests/smoke.mjs`（只读路径） | 端到端坏了没人知道 |
| 7 | `assets/nx-kn/`（SKILL.md + references） | agent 永远不知道这条命令存在 ❗**单向断言** |
| 8 | `README.md` / `CHANGELOG.md` | 文档与实际脱节 |

纯逻辑（如 zg 输出解析）必须下沉到 `core/` 并配单测，否则 CI 上跑不到。


## 开发

```bash
pnpm dev          # vite + serve 双进程，一个 ctrl-c 一起退
pnpm test         # lint + build + smoke + unit
pnpm logo         # 手动重出 logo（svg + png + ico 全套）
```

## 发版

tag 幂等 + npm provenance 见 `.github/workflows/npm-publish.yml`：推 tag 到 main，
CI 自动构建、测试、`npm publish --provenance`（需要 `NPM_TOKEN` secret）。
