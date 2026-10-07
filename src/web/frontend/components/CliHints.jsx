// CLI 等价提示：两种形态，**都来自 bootstrap 下发的同一份命令表**。
//
//   <CliHints module="kb" />                         列出该模块的全部同构命令
//   <CliHints id="home.pipeline" note="…" />         只贴这一条，附一句说明
//
// 为什么由数据派生而不是手写：这行提示是用户核对「面板上这个按钮到底有没有 CLI 等价」
// 的唯一依据。写死的字符串会随命令改名悄悄过期——提示说「有」，实际没有，比没有提示更糟。
// 单命令形态也走 action id 查表（而不是传命令字符串），就是为了让「命令改名」
// 自动反映到提示上。
//
// ⚠️ 历史故障：此前只实现了 `module` 一种形态，而四处调用传的是 `command`——
// 那是未声明的 prop，于是 `moduleId === undefined`、filter 恒空、直接 `return null`：
// 提示整块不渲染，控制台零告警。所以这里对「id 查不到」显式告警，
// 不让同一个坑以另一种形式复发（README 把这类问题列为「漏了不会报错，只会静默失效」）。
import { Fragment } from 'react';
import { useStore } from '../store.jsx';
import { Copyable } from './ui.jsx';

export function CliHints({ module: moduleId, id, command, note }) {
  const { boot } = useStore();
  const commands = boot?.commands || [];

  // 单命令形态：按 action id 查表拿命令原文，配一句自由说明。
  if (id) {
    const entry = commands.find((c) => c.id === id);
    if (!entry) {
      if (boot) console.warn(`[nx-kn] CliHints: 命令表里没有 id=${id}（命令改名了？）`);
      return null;
    }
    return <CliHintRow command={entry.command} usage={entry.usage} note={note} />;
  }

  // 兜底形态：直接给命令字符串（命令表里没有的临时说明用）。
  if (command) return <CliHintRow command={command} note={note} />;

  const cmds = commands.filter((c) => c.module === moduleId);
  if (!cmds.length) return null;

  return (
    <div className="cli-hint">
      <span className="cli-hint-label">这个页面上的每个按钮都有一条同构的 CLI 命令</span>
      {cmds.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span className="cli-hint-sep"> · </span>}
          <Copyable className="cli-cmd" text={c.command} title={`点击复制：${c.usage}`}>
            {c.command}
          </Copyable>
        </Fragment>
      ))}
      <span className="cli-hint-tail">。加 <code className="cli-hint-flag">--json</code> 得机器可读输出。</span>
    </div>
  );
}

function CliHintRow({ command, usage, note }) {
  return (
    <div className="cli-hint">
      <span className="cli-hint-label">等价 CLI</span>
      <Copyable className="cli-cmd" text={command} title={`点击复制：${usage || command}`}>
        {command}
      </Copyable>
      {note ? <span className="cli-hint-tail"> —— {note}</span> : null}
    </div>
  );
}
