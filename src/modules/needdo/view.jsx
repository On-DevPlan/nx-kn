// needdo 视图：混乱输入收件箱面板。
//
// 五条 UIUX 铁律来自 docs/needdo/research-round1.md（Drafts/flomo/Raycast/Things 的
// 共性 + 本仓 paper 设计语言）：
//   1. 单框多类型：一个大输入框混收文字与链接，类型由系统识别（整行 URL → 链接），
//      不让用户先选类型——捕获优先，路由其次
//   2. 整个面板都是拖放区，拖入 PDF/DOCX 即入库；「选择文件」按钮做兜底
//   3. 列表与 crawl 视图同构（.row + .tag + Copyable），零图标体系
//   4. 归档而非删除：条目二态 inbox | done，默认只看收件箱
//   5. 键盘链路全通：进 tab 即聚焦、焦点在外时 Ctrl+V 也进输入框、Esc 清空、
//      提交后焦点不丢
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Copyable, Spinner, useDialog, useToast } from '../../web/frontend/components/ui.jsx';

// 与 core/paths.js 的 NEEDDO_FILE_MAX_BYTES 同口径（HTTP body 4MB 上限的 base64 换算）。
// 前端先卡一道，错误在拖进去的那一刻就给出，而不是等请求回来。
const FILE_MAX = 3 * 1024 * 1024;
const FILE_EXTS = ['pdf', 'docx', 'txt', 'md'];

const KIND_LABEL = { text: '文字', link: '链接' };
function kindLabel(it) {
  return it.kind === 'file' ? (it.ext || '文件').toUpperCase() : KIND_LABEL[it.kind] || it.kind;
}

function fmtTime(iso) {
  if (!iso) return '';
  const s = String(iso).replace('T', ' ');
  return s.slice(5, 16); // MM-DD HH:mm —— 收件箱条目只关心「什么时候丢进来的」
}

// Arraybuffer → base64（分块拼接，避免 String.fromCharCode 一次吃下几 MB 参数爆栈）。
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export default function NeedDoView() {
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState('inbox'); // inbox | done | all —— 默认只看收件箱（铁律 4）
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setSt(await api('/api/needdo/list'));
    } catch (e) {
      toast(String(e.message || e));
    }
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  // 铁律 5：焦点不在输入框时，粘贴（文字或文件）也直接进收件箱的输入路径。
  useEffect(() => {
    const onPaste = (e) => {
      const ta = inputRef.current;
      if (!ta || document.activeElement === ta) return;
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
      const s = e.clipboardData?.getData('text');
      if (s) {
        e.preventDefault();
        setText((cur) => (cur ? cur + '\n' + s : s));
        ta.focus();
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  async function submit() {
    const v = text.trim();
    if (!v || busy) return;
    // 铁律 1：类型系统识别——不带空白且是合法 http(s) 形态的整行 → 链接，其余 → 文字
    const isLink = /^https?:\/\/\S+$/i.test(v.replace(/\s+/g, ''));
    setBusy(true);
    try {
      await api('/api/needdo/add', {
        method: 'POST',
        body: isLink ? { link: v } : { text: v },
      });
      setText('');
      await refresh();
      inputRef.current?.focus(); // 提交后焦点归位，连续收集不打断
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files) {
    if (!files.length || busy) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const f of files) {
        const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
        if (!FILE_EXTS.includes(ext)) {
          toast(`跳过 ${f.name}：目前收 ${FILE_EXTS.join(' / ')}`);
          continue;
        }
        if (f.size > FILE_MAX) {
          toast(`跳过 ${f.name}：超过 3MB 上限`);
          continue;
        }
        try {
          await api('/api/needdo/add', {
            method: 'POST',
            body: { data: toBase64(await f.arrayBuffer()), name: f.name },
          });
          ok++;
        } catch (e) {
          toast(`${f.name}：${e.message || e}`);
        }
      }
      if (ok) toast(`已收进 ${ok} 个文件`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function processInbox() {
    if (busy || !st?.inbox) return;
    setBusy(true);
    try {
      const r = await api('/api/needdo/process', { method: 'POST', body: {} });
      toast(
        r.processed
          ? `已整理 ${r.processed} 条：${r.byTopic.map((x) => `${x.topic} ${x.count}`).join(' / ')}`
          : '收件箱已是空的'
      );
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function archiveItem(it, undo) {
    setBusy(true);
    try {
      await api('/api/needdo/archive', { method: 'POST', body: { id: it.id, undo } });
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(it) {
    const ok = await dialog({
      title: '删除条目',
      message: `把 [${it.title}] 从收件箱删除？\n文件型条目的原件与提取文本会一起删掉，删除不可恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api('/api/needdo/remove', { method: 'POST', body: { id: it.id } });
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  // 拖入计数而非布尔开关：拖经子元素会连发 dragleave，深度计数才能稳住激活态。
  const onDragEnter = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDrag(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDrag(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) uploadFiles(files);
  };

  const items = st ? st.items.filter((x) => (filter === 'all' ? true : x.status === filter)) : [];
  const loading = st === null;

  return (
    <div
      className="stack"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dialogNode}

      {/* 捕获卡：单框多类型（铁律 1）+ 拖放激活态（铁律 2） */}
      <div className={'card needdo-capture' + (drag ? ' drop' : '')}>
        <div className="colhead">
          <span>NeedDo 收件箱</span>
          {loading ? <Spinner /> : <span className="tag">{st.inbox} 条待整理</span>}
        </div>
        <div className="needdo-body">
          <textarea
            ref={inputRef}
            className="needdo-input"
            autoFocus
            spellCheck="false"
            value={text}
            placeholder="随手收：一句话、公告、链接（整行 URL 自动识别为链接）——或者把 PDF / DOCX / TXT / MD 拖到页面任意处"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                setText('');
              }
            }}
          />
          <div className="opt-actions">
            <button className="btn" disabled={busy || !text.trim()} onClick={submit}>
              收进收件箱
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
              选择文件…
            </button>
            <button className="btn ghost" disabled={busy || !st?.inbox} onClick={processInbox}>
              {busy ? '处理中…' : '按主题整理'}
            </button>
            <span className="needdo-tip muted">Enter 收进 · Shift+Enter 换行 · Esc 清空 · 文件可整屏拖入</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={FILE_EXTS.map((x) => '.' + x).join(',')}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              uploadFiles(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
        </div>
        <CliHints module="needdo" />
      </div>

      {/* 条目卡：与 crawl 视图同构的行式列表（铁律 3） */}
      <div className="card">
        <div className="colhead">
          <span>条目</span>
          <div className="acts">
            <button
              className={'btn small' + (filter === 'inbox' ? '' : ' ghost')}
              onClick={() => setFilter('inbox')}
            >
              收件箱 {st ? st.inbox : '…'}
            </button>
            <button
              className={'btn small' + (filter === 'done' ? '' : ' ghost')}
              onClick={() => setFilter('done')}
            >
              已归档
            </button>
            <button
              className={'btn small' + (filter === 'all' ? '' : ' ghost')}
              onClick={() => setFilter('all')}
            >
              全部 {st ? st.total : '…'}
            </button>
          </div>
        </div>

        {!loading && !items.length && (
          <div className="empty">
            {filter === 'inbox'
              ? '收件箱是空的 —— 上面丢一句话进来，或拖个文档进来'
              : '这个视图下没有条目'}
          </div>
        )}

        {items.map((it) => (
          <div className="row wrap" key={it.id}>
            <div className="name mono" title={it.title}>
              [{kindLabel(it)}] {it.title}
            </div>
            <div className="acts">
              {it.topic ? (
                <span className="tag strong">{it.topic}</span>
              ) : (
                <span className="tag">未整理</span>
              )}
              {it.status === 'done' ? <span className="tag">已归档</span> : null}
              {it.textFile ? null : it.kind === 'file' ? <span className="tag">无文本</span> : null}
              <button
                className="btn small ghost"
                disabled={busy}
                onClick={() => archiveItem(it, it.status === 'done')}
              >
                {it.status === 'done' ? '还原' : '归档'}
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => removeItem(it)}>
                删除
              </button>
            </div>
            <div className="desc">
              {it.kind === 'link' ? <Copyable text={it.content}>{it.content}</Copyable> : it.excerpt || it.title}
              <span className="muted"> · {fmtTime(it.addedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
