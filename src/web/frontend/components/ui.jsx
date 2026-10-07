// 通用 UI 件：toast、对话框、弹窗、错误边界、diff 渲染。
// 约定延续自 vanilla 版：无 emoji、不用浏览器原生弹窗（alert/confirm/prompt 一律页内实现）。
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { splitHighlight } from '../highlight.js';

// ---- toast：页内轻提示（自动消失） ----

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [msgs, setMsgs] = useState([]);
  const idRef = useRef(0);

  const toast = useCallback((msg) => {
    const id = ++idRef.current;
    setMsgs((m) => [...m, { id, msg }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 2800);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {msgs.map((m) => <div key={m.id} className="toast show">{m.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastCtx) || ((m) => console.log(m));
  // 这个 hook 返回的是**函数本身**（正确用法：const toast = useToast()）。
  // 但 `const { toast } = useToast()` 是极容易写错的一种——而且写错后**不报错、不白屏**：
  // toast 变 undefined，提示静默消失，紧跟其后的代码还会被 TypeError 打断
  // （典型后果：写操作成功了，但 refresh() 没跑，界面看起来「没反应」）。
  // 模板自带的 settings 视图就踩了这个坑，所以这里补一层自引用把该写法兜住。
  toast.toast = toast;
  return toast;
}

// 操作守卫：包一层，失败自动 toast 错误信息（对应 vanilla 版的 guard()）
export function useGuard() {
  const toast = useToast();
  return useCallback(async (fn) => {
    try { return await fn(); } catch (e) { toast(String((e && e.message) || e)); }
  }, [toast]);
}

// ---- 转圈：数据还没到时的占位 ----
// 「还不知道」不等于「就是没有」。知识库状态要逐库起一次 `zg status` 子进程（秒级），
// 冷启动时拿 `…` 顶着，用户会以为「它本来就长这样」；一个转圈明确表达「正在取」。
// 样式在 style.css 的 base 层（跨风格共享，换风格也不该换掉「转动 = 正在加载」）。
export function Spinner({ label }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

// ---- 检索命中高亮 ----
// 把问句里能字面匹配的词在文本中标黄——检索结果里最需要一眼看到的信息是
// 「这段为什么被召回」，而这个理由就是「它含你问的那几个词」。
// 切词与匹配是纯函数（web/frontend/highlight.js，有单测），这里只管渲染。
//
// 注意：语义（vector）召回本就可能一个字都不重合，那种片段不会有黄块——这是对的，
// 不是坏了。面板在结果计数行里写明了「黄底 = 字面命中」。
export function Highlight({ text, query }) {
  const segs = splitHighlight(text, query);
  return segs.map((s, i) =>
    s.hit
      ? <mark className="hl" key={i}>{s.text}</mark>
      : <span key={i}>{s.text}</span>
  );
}

// ---- 点击即复制：所有路径/长标识的展示标准 ----
// 点一下复制全文；hover 显示「点击复制」提示；复制成功 toast 确认。
export function Copyable({ text, className = '', title, children }) {
  const toast = useToast();
  const copy = async () => {
    const v = String(text ?? '');
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
    } catch {
      // 剪贴板 API 不可用（非安全上下文等）：退回 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = v;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
      } catch {
        toast('复制失败（剪贴板不可用）');
      }
    }
  };
  return (
    <span
      className={'copyable' + (className ? ' ' + className : '')}
      title={title || '点击复制'}
      onClick={copy}
    >{children !== undefined ? children : text}</span>
  );
}

// ---- 对话框：确认 / 输入（Promise 风格，对应 vanilla 版 dialog()） ----
//
// 三种形态，都返回 Promise，取消一律 resolve(null)：
//   确认   dialog({ title, message, okText })            → true | null
//   单输入 dialog({ input: true, value, placeholder })   → string | null
//   多输入 dialog({ fields: [{key,label,value,placeholder}] }) → { key: string } | null
//          字段带 options（字符串数组或 {value,label}）时渲染成下拉 —— 枚举值用它，别让用户手打
//
// 为什么补多输入：加知识库要同时给「目录」和「embedding 模型」两个值，
// 分两次弹窗会让中途取消留下半配置（目录加了、模型没给）。
export function useDialog() {
  const [state, setState] = useState(null); // {resolve, ...opts}
  // 用 ref 读输入框，而不是 document.querySelector('.dlg-input')——
  // 后者绕开 React 直接摸 DOM，页面上有第二个同名类名时就会读错。
  const inputRef = useRef(null);
  const fieldRefs = useRef([]);

  const close = useCallback((val) => {
    setState((s) => { if (s && s.resolve) s.resolve(val); return null; });
  }, []);

  const dialog = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const node = state
    ? (() => {
        const submit = () => {
          if (Array.isArray(state.fields)) {
            const out = {};
            state.fields.forEach((f, i) => {
              out[f.key] = (fieldRefs.current[i]?.value ?? '').trim();
            });
            close(out);
          } else {
            close(state.input ? (inputRef.current?.value.trim() ?? null) : true);
          }
        };
        const onKey = (e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') close(null);
        };
        return (
          <div className="dlg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
            <div className="dlg-box">
              {state.title ? <div className="dlg-title">{state.title}</div> : null}
              {state.message ? <div className="dlg-msg">{state.message}</div> : null}
              {Array.isArray(state.fields) ? (
                <div className="dlg-fields">
                  {state.fields.map((f, i) => (
                    <label className="dlg-field" key={f.key}>
                      {f.label ? <span className="dlg-field-label">{f.label}</span> : null}
                      {Array.isArray(f.options) ? (
                        // 枚举值一律用下拉：让用户手打 `skill-seekers` 这种值，
                        // 打错一个字母就换来一条看不懂的「参数非法」，而选项本来是可枚举的。
                        // 提交逻辑统一读 `el.value`，select 与 input 同构，故共用同一个 ref。
                        <select
                          className="dlg-input"
                          autoFocus={i === 0}
                          defaultValue={f.value ?? (f.options[0] && (f.options[0].value ?? f.options[0]))}
                          onKeyDown={onKey}
                          ref={(el) => { fieldRefs.current[i] = el; }}
                        >
                          {f.options.map((o) => {
                            const v = o && typeof o === 'object' ? o.value : o;
                            const label = o && typeof o === 'object' ? o.label : o;
                            return (
                              <option key={v} value={v}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      ) : (
                        <input
                          className="dlg-input"
                          autoFocus={i === 0}
                          spellCheck="false"
                          placeholder={f.placeholder || ''}
                          defaultValue={f.value || ''}
                          onKeyDown={onKey}
                          ref={(el) => { fieldRefs.current[i] = el; }}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ) : state.input ? (
                <input
                  ref={inputRef}
                  className="dlg-input"
                  autoFocus
                  spellCheck="false"
                  placeholder={state.placeholder || ''}
                  defaultValue={state.value || ''}
                  onKeyDown={onKey}
                />
              ) : null}
              <div className="dlg-acts">
                <button className="btn ghost" onClick={() => close(null)}>取消</button>
                <button className={'btn' + (state.danger ? ' danger' : '')} onClick={submit}>
                  {state.okText || '确定'}
                </button>
              </div>
            </div>
          </div>
        );
      })()
    : null;

  return { dialog, node };
}

// ---- 错误边界：把崩溃限制在单个视图内 ----
// 视图都是 lazy() 加载的，没有这层兜底时，任何一个视图抛错（或 chunk 加载失败）
// 都会让整个面板白屏，用户连切到别的 tab 自救都做不到。

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[nx-kn] 视图渲染失败:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="colhead"><h3>这个面板出错了</h3></div>
        <div className="dlg-msg">{String(this.state.error?.message || this.state.error)}</div>
        <div className="muted" style={{ marginBottom: 10 }}>
          其他面板不受影响，可以切到别的 tab 继续操作；控制台有完整堆栈。
        </div>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
      </div>
    );
  }
}

// ---- 弹窗：大块内容（diff / 冲突详情 / 命令输出） ----

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-title">
          <span>{title}</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---- diff 文本渲染（+/- 行着色） ----

export function DiffPre({ text }) {
  const lines = String(text ?? '').split('\n');
  return (
    <pre>
      {lines.map((line, i) => (
        <span key={i} className={
          line.startsWith('+') && !line.startsWith('+++') ? 'd-add'
            : line.startsWith('-') && !line.startsWith('---') ? 'd-del' : ''
        }>
          {line}{i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}
