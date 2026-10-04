// kb 视图：知识库检索面板。
//
// 只做三件事——让状态可见（zg 在不在、有哪些库、各自的索引到哪一步），
// 让库可管理（添加 / 移除），让检索可用（搜、看命中、点开片段）。
// 所有操作都有一条同构 CLI 命令（CliHints）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useDialog, useToast } from '../../web/frontend/components/ui.jsx';

const LIMIT = 7;
// 新建库时的默认 embedding：本机离线、免 key、中文可用（1024 维）。
// 面板给这个默认值，是为了让「添加目录 → 更新索引」这条路在没有任何配置的机器上也能走通。
const DEFAULT_MODEL = 'local/qwen3-embedding-0.6b';
// 建索引是慢操作（本地模型要逐个片段嵌入，大 vault 可能几分钟）。
// 多库是串行跑的，所以给一个宽松的上限，避免请求被前端提前掐断。
const INDEX_TIMEOUT = 900_000;

// 笔记数：与 CLI 同一口径。zg 建索引时会静默跳过克隆仓库、空文件、依赖目录，
// 只报一个比索引大的数字会让人以为漏索引了——把「少的那些去哪了」一并说出来。
function notesText(v) {
  const s = v.notesSkipped || {};
  const skipped = [];
  if (s.nestedRepos) skipped.push(`${s.nestedRepos} 个克隆仓库`);
  if (s.empty) skipped.push(`${s.empty} 篇空文件`);
  return (
    `${v.notes} 篇 md${v.obsidian ? ' · Obsidian' : ''}` +
    (skipped.length ? `（另有 ${skipped.join('、')}，zg 默认不收）` : '')
  );
}

export default function KbView() {
  const toast = useToast();
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

  async function addVault() {
    const r = await dialog({
      title: '添加知识库目录',
      message: '填入 Obsidian vault 的绝对路径。可以添加多个，检索时会把结果合并成一张列表。',
      fields: [
        { key: 'path', label: '目录', placeholder: 'D:\\Notes\\MyVault', value: '' },
        {
          key: 'model',
          label: 'embedding 模型（可留空）',
          placeholder: DEFAULT_MODEL,
          value: DEFAULT_MODEL,
        },
      ],
      okText: '添加',
    });
    if (!r || !r.path) return;
    setBusy('add');
    try {
      const out = await api('/api/kb/add', {
        method: 'POST',
        body: { path: r.path, model: r.model || undefined },
      });
      toast(out.added ? `已添加（共 ${out.count} 个库）` : '这个目录已在列表中');
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  async function removeVault(path, name) {
    const ok = await dialog({
      title: '移除知识库目录',
      message: `把 [${name}] 从列表移除？\n只解除登记，不删磁盘上的索引（要删索引跑 zg index "${path}" --drop）。`,
      okText: '移除',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    try {
      const out = await api('/api/kb/remove', { method: 'POST', body: { path } });
      toast(`已移除（剩 ${out.count} 个库）`);
      setRes(null);
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  // 增量与全量走同一条 action，只是 rebuild 不同。分开两个按钮，
  // 是为了让「只是补几篇新笔记」不必付出「整个库重新嵌入」的代价——
  // 之前面板只有一个「重建索引」按钮，把最便宜的操作藏在了最贵的操作后面。
  // 现在视觉主次也要跟着反过来：**增量是主按钮**（日常只该点它），
  // 重建降为次要按钮（换模型/索引损坏才用）。否则配色又把人往最贵的路上引。
  async function reindex(rebuild) {
    if (rebuild) {
      const ok = await dialog({
        title: '全量重建索引',
        message: '重建会对所有库重新计算全部片段向量（换模型、或索引疑似损坏时才需要）。\n只是新增/改了笔记的话，用「更新索引」即可。',
        okText: '开始重建',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy('index');
    try {
      const out = await api('/api/kb/index', {
        method: 'POST',
        body: { rebuild },
        timeoutMs: INDEX_TIMEOUT,
      });
      const failed = (out.results || []).filter((x) => x.changes && x.changes.failed > 0);
      toast(
        `${rebuild ? '已重建' : '已增量更新'} ${out.count} 个库的索引（${((out.elapsedMs || 0) / 1000).toFixed(1)}s）` +
          (failed.length ? ` · ${failed.length} 个库有失败片段` : '')
      );
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  // st === null = 状态还没回来。此时绝不能把「未添加 / zg 未安装 / 未建」渲染出去：
  // 那是把「还不知道」说成「就是没有」。多库时 status 要逐库起 zg 子进程
  // （已并发，但仍是秒级），冷启动更容易踩到。没回来就画省略号。
  const loading = st === null;
  const pending = '…';
  const totals = st?.totals;

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
            <dd className="mono">
              {loading
                ? pending
                : st.configured
                  ? `${totals.vaults} 个 · 索引 ${totals.indexed} 个 · 共 ${totals.notes} 篇可索引 md`
                  : '（未添加）'}
            </dd>
          </div>
          {!loading && totals?.stale > 0 && (
            <div className="kv-row">
              <dt>待更新</dt>
              <dd className="mono">{totals.stale} 个库有新增/改动 —— 点「更新索引（增量）」即可</dd>
            </div>
          )}
        </dl>
        {st?.hint && <div className="dlg-msg" style={{ padding: '0 12px 8px' }}>{st.hint}</div>}

        {/* 库列表：每一行是一个独立的索引，各自有模型与覆盖度 */}
        {!loading && st.configured && st.vaults.map((v) => (
          <div className="row wrap" key={v.path}>
            <div className="name mono" title={v.path}>
              [{v.name}] {v.path}
            </div>
            <div className="acts">
              {v.missing ? (
                <span className="tag bad">目录不存在</span>
              ) : v.indexed ? (
                v.index?.stale ? <span className="tag">待更新</span> : <span className="tag strong">已建</span>
              ) : (
                <span className="tag">未建</span>
              )}
              <button
                className="btn small ghost"
                disabled={!!busy}
                onClick={() => removeVault(v.path, v.name)}
              >
                移除
              </button>
            </div>
            <div className="desc">
              {v.missing
                ? '路径已失效：重新添加，或从列表移除'
                : `${notesText(v)}` +
                  ` · 索引 ${v.indexed ? `${v.index?.files ?? '?'}/${v.index?.filesTotal ?? '?'} 文件 · ${v.index?.entities ?? '?'} 片段` : '未建'}` +
                  ` · 模型 ${v.model || (v.plannedModel ? `（建时用 ${v.plannedModel}）` : '（未记录）')}`}
            </div>
          </div>
        ))}

        <div className="opt-actions">
          <button className="btn ghost" disabled={!!busy} onClick={addVault}>
            {busy === 'add' ? '添加中…' : '添加目录'}
          </button>
          {/* 增量 = 主按钮：新写了笔记只该点它，旧向量原样保留，只嵌入新增/改动的那几篇 */}
          <button
            className="btn"
            disabled={!!busy || !st?.configured}
            onClick={() => reindex(false)}
            title="只把新增/改动的笔记加进现有索引，其余向量保留"
          >
            {busy === 'index' ? '更新中…' : '更新索引（增量）'}
          </button>
          {/* 重建 = 次要按钮：换模型或索引疑似损坏才用，代价是整个库重新嵌入 */}
          <button
            className="btn ghost"
            disabled={!!busy || !st?.configured}
            onClick={() => reindex(true)}
            title="对所有库重新计算全部片段向量（换模型 / 索引损坏时用）"
          >
            {busy === 'index' ? '处理中…' : '重建索引'}
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
                命中 {res.hits.length}/{res.totalHits} 条 · {(res.elapsedMs / 1000).toFixed(1)}s
                {res.searched?.length > 1 ? ` · 检索了 ${res.searched.length} 个库` : ''}
                {res.skipped?.length ? ` · 跳过 ${res.skipped.length} 个` : ''}
              </div>
              {res.hits.map((h) => (
                // .row.wrap：命中带多行片段，用单行 28px 行会把片段裁到叠字。
                <div className="row wrap" key={`${h.vault}-${h.n}-${h.path}-${h.start}`}>
                  <div className="name mono">
                    {/* 多库时先说是哪个库，否则相对路径无法定位到磁盘文件 */}
                    {res.searched.length > 1 ? <span className="muted">[{h.vaultName}] </span> : null}
                    {h.path}:{h.start}-{h.end}
                    {h.heading ? <span className="muted"> · {h.heading}</span> : null}
                  </div>
                  <div className="acts">
                    {h.matchedBy.map((m) => <span className="tag" key={m}>{m}</span>)}
                    {h.score != null ? <span className="tag">{h.score.toFixed(3)}</span> : null}
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
