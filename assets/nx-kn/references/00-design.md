# 00 · 设计思想

> 本文档讲「为什么这样设计」。场景级操作（命令怎么调、参数怎么传）看 SKILL.md；
> 「加功能要碰哪几处」属于项目 README（开发者文档），不在这里。

## 驱动关系图

```
            ┌─────────────────────────────────────┐
            │           CLI (bin/<letters>.mjs)   │
            └──────────────┬──────────────────────┘
                           │ runCli()
   ┌───────────────┐   ┌───▼───────────────┐   ┌──────────────────┐
   │ Web 面板       │   │ runtime/cli.js    │   │ HTTP (serve)      │
   │ (React, vite) │──▶│ runtime/api.js    │◀──│ node:http 零依赖  │
   └───────────────┘   │ runtime/spec.js   │   └──────────────────┘
                       │ runtime/registry  │
                       └───┬───────────────┘
                           │ ACTIONS（一条声明，两端派生）
                 ┌─────────▼─────────┐
                 │  modules/<域>/     │  index.js 声明 + service.js 业务
                 └─────────┬─────────┘
                 ┌─────────▼─────────┐
                 │  core/             │  paths / errors / store（零业务）
                 └───────────────────┘
```

## 分层与依赖方向

- `core` 不得 import `modules/runtime/web`（eslint 拦截）
- `modules` 之间禁止互相依赖，共享逻辑下沉 `core`
- `runtime` 只做装配（argv/HTTP → action → service），不写业务
- 前端只能 import 各模块的 `view.jsx`——把 Node 侧代码拖进浏览器包，
  vite 会把 `node:` 内置模块一起打包，构建期报错或运行期炸掉

## 关键不变量

1. **一条 action 同时声明 cli 与 http**。registry 装载期自检：没 cli 报错、
   重复报错、声明了 http 却没有 cli 报错——「面板有按钮、CLI 没命令」在结构上不可能。
2. **失败 throw / 业务结果 `{status}`**。判定标准是「调用方要不要处理它」。
3. **存储路径可被环境变量覆盖**。所有测试用 `--store`/环境变量指向临时目录，
   绝不写脏用户真实数据。

## 失败 vs 业务结果

| 情形 | 表达 | 例子 |
| --- | --- | --- |
| 调用方无从处理 | `throw`（`NxError` 带 code） | 参数非法、目标不存在 |
| 调用方要做决策 | `return { status: 'ok'\|'skipped'\|'conflict'\|'blocked' }` | 冲突等用户选边、幂等跳过 |

## 错误案例

| 踩过的坑 | 后果 | 正确做法 |
| --- | --- | --- |
| CLI 与 Web 各写一份命令清单 | 必然分叉，没人发现 | action 一处声明两端派生 |
| 测试直接用默认存储路径 | 写脏用户数据 | 环境变量指向临时目录 |
| 新模块忘了补 lint 禁列 | 静默变成「谁都能依赖」 | 枚举式禁列 + 一致性测试（负模式对 `../` 实测失效，见 eslint.config.js） |
| 把 Node 模块 import 进 view | vite 打包把 `node:` 拖进浏览器 | lint 规则 + 只 import view.jsx |
| 声明了 `args:['id']` 但 http 路径没写 `:id` | 参数静默变 undefined | registry 自检（args 与路由占位符同名校验） |
| `new Error()` 后手动赋 `err.code` | 赋了也不生效（`toErrorPayload` 只认 `NxError`），一律变 `INTERNAL`、HTTP 返 500 | 抛 `badInput()` / `notFound()` 这类构造器 |
