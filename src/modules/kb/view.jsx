// kb 视图：知识库检索面板。
//
// 只做两件事——让状态可见（zg 在不在、vault 是哪个、索引建没建），
// 让检索可用（搜、看命中、点开片段）。所有操作都有一条同构 CLI 命令（CliHints）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useDialog, useToast } from '../../web/frontend/components/ui.jsx';

const LIMIT = 7;

export default function KbView() {
  const { toast } = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const [st, setSt] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSt(await api('/api/kb/status'));
      setErr('');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function search(e) {
    e?.preventDefault();
    const text = q.trim();
    if (!text) return;
    setBusy('query');
    try {
      setRes(await api(`/api/kb/query?q=${encodeURIComponent(text)}&limit=${LIMIT}`));
    } catch (e2) {
      toast(String(e2.message || e2), 'bad');
    } finally {
      setBusy('');
    }
  }

  async function reindex() {
    const ok = await dialog({
      title: '重建索引',
      message: '对 vault 重新建索引（--rebuild）。笔记多时可能要一会儿。',
      okText: '开始',
    });
    if (!ok) return;
    setBusy('index');
    try {
      const r = await api('/api/kb/index', { method: 'POST', body: { rebuild: true }, timeoutMs: 660000 });
      toast(`索引已更新（${(r.elapsedMs / 1000).toFixed(1)}s）`);
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  async function pickVault() {
    const path = await dialog({
      title: '设定知识库目录',
      message: '填入 Obsidian vault 的绝对路径（写入 store.json，之后 index / query 都用它）',
      input: true,
      placeholder: 'D:\\Notes\\MyVault',
      value: st?.vault || '',
      okText: '保存',
    });
    if (!path) return;
    setBusy('use');
    try {
      const r = await api('/api/kb/use', { method: 'POST', body: { path } });
      toast(`知识库已设定（${r.notes} 篇 md）`);
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  // st === null = 状态还没回来。此时绝不能把「未设定 / zg 未安装 / 未建」渲染出去：
  // 那是把「还不知道」说成「就是没有」。实测冷启动 /api/kb/status 要 6.5s
  // （zg status 子进程），面板会先指着用户说 zg 没装。没回来就画省略号。
  const loading = st === null;
  const pending = '…';

  return (
    <div className="stack">
      {dialogNode}

      <div className="card">
        <div className="colhead">
          <span>知识库</span>
          <span className="tag">
            {loading ? pending : st.zg?.installed ? `zg ${st.zg.version || ''}` : 'zg 未找到'}
          </span>
        </div>
        <dl className="kv">
          <div className="kv-row">
            <dt>目录</dt>
            <dd className="mono nowrap">{loading ? pending : st.vault || '（未设定）'}</dd>
          </div>
          <div className="kv-row">
            <dt>笔记</dt>
            <dd className="mono">
              {loading
                ? pending
                : st.configured
                  ? `${st.notes} 篇 md${st.obsidian ? ' · Obsidian' : ''}`
                  : '—'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>索引</dt>
            <dd className="mono">
              {loading
                ? pending
                : st.indexed
                  ? `已建 · ${st.index?.files ?? '?'}/${st.index?.filesTotal ?? '?'} 文件 · ${st.index?.entities ?? '?'} 片段`
                  : '未建'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>模型</dt>
            <dd className="mono">{loading ? pending : st.model || '（未记录）'}</dd>
          </div>
        </dl>
        {st?.hint && <div className="dlg-msg" style={{ padding: '0 12px 8px' }}>{st.hint}</div>}
        <div className="opt-actions">
          <button className="btn ghost" disabled={!!busy} onClick={pickVault}>
            {st?.configured ? '更换目录' : '设定目录'}
          </button>
          <button className="btn" disabled={!!busy || !st?.configured} onClick={reindex}>
            {busy === 'index' ? '建索引中…' : st?.indexed ? '重建索引' : '建立索引'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="colhead">
          <span>检索</span>
          <span className="tag">混合：精确 + 关键词 + 语义</span>
        </div>
        <form className="opt-row" style={{ padding: '0 12px' }} onSubmit={search}>
          <input
            type="text"
            value={q}
            placeholder="用自然语言问，例如：登录页为什么提示超时"
            onChange={(e) => setQ(e.target.value)}
            disabled={!st?.configured}
          />
          <button className="btn" type="submit" disabled={busy === 'query' || !q.trim()}>
            {busy === 'query' ? '检索中…' : '检索'}
          </button>
        </form>

        {res?.needIndex && <div className="empty">{res.hint}</div>}

        {res && !res.needIndex && (
          res.hits.length ? (
            <div>
              <div className="muted" style={{ padding: '4px 12px' }}>
                命中 {res.hits.length} 条 · {(res.elapsedMs / 1000).toFixed(1)}s
                {res.notes.length ? ` · ${res.notes.join(' · ')}` : ''}
              </div>
              {res.hits.map((h) => (
                // .row.wrap：命中带多行片段，用单行 28px 行会把片段裁到叠字。
                <div className="row wrap" key={`${h.n}-${h.path}-${h.start}`}>
                  <div className="name mono">
                    {h.path}:{h.start}-{h.end}
                    {h.heading ? <span className="muted"> · {h.heading}</span> : null}
                  </div>
                  <div className="acts">
                    {h.matchedBy.map((m) => <span className="tag" key={m}>{m}</span>)}
                  </div>
                  <div className="desc">
                    <div className="snippet-box">
                      <pre>{h.snippet || '（无片段：preview=none）'}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">没有命中——换个说法再试，或先确认索引里的内容是最新的</div>
          )
        )}

        <CliHints module="kb" />
      </div>
    </div>
  );
}
