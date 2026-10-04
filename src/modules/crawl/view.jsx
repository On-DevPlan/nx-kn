// crawl 视图：资料采集面板。
//
// 只做两件事——让采集源可见（有哪些源、抓到多少页、上次什么时候抓的），
// 让采集可操作（添加源 / 抓取 / 移除）。所有操作都有一条同构 CLI 命令（CliHints）。
//
// 采集完成后抓下来的目录会**自动登记为知识库**，所以这个页面本身不做检索——
// 检索在「知识库」页。这里只负责把外部资料变成可被检索的 markdown。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useDialog, useToast } from '../../web/frontend/components/ui.jsx';

// 抓取是慢操作（串行 + 300ms 节流，几百页可能要几分钟）。给一个宽松的上限，
// 避免请求被前端提前掐断。
const CRAWL_TIMEOUT = 900_000;

function fmtTime(iso) {
  if (!iso) return '（未抓取）';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function CrawlView() {
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSt(await api('/api/crawl/list'));
      setErr('');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function addSource() {
    const r = await dialog({
      title: '添加采集源',
      message: '填入一个文档站地址。抓下来的页面会清洗成 markdown，并自动登记为知识库。',
      fields: [
        { key: 'url', label: '起始地址（http/https）', placeholder: 'https://vitepress.dev/guide/', value: '' },
        { key: 'name', label: '源名（留空自动推导）', placeholder: 'vitepress-dev', value: '' },
        { key: 'match', label: '路径过滤 glob（默认全部）', placeholder: '**', value: '**' },
        { key: 'max', label: '最多抓取页数', placeholder: '200', value: '200' },
      ],
      okText: '添加',
    });
    if (!r || !r.url) return;
    setBusy('add');
    try {
      const out = await api('/api/crawl/add', {
        method: 'POST',
        body: {
          url: r.url,
          name: r.name || undefined,
          match: r.match || '**',
          max: r.max ? Number(r.max) : undefined,
        },
      });
      toast(`已添加采集源 [${out.name}]`);
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  // 增量 = 主按钮：日常只该点它。内容没变的页面不重写，后续 zg 增量索引会如实报 unchanged。
  // 全量 = 次要按钮：换了 glob/max 想重抓、或想强制刷新时用。
  async function crawlAll(rebuild) {
    if (!st?.count) return;
    if (rebuild) {
      const ok = await dialog({
        title: '重新抓取全部采集源',
        message: '全量重抓会忽略已存内容哈希、把所有页面重新写一遍（多用于改了抓取范围后）。\n只是站点更新了的话，用「抓取更新」即可。',
        okText: '开始重抓',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy('run');
    try {
      const out = await api('/api/crawl/run', { method: 'POST', body: { rebuild }, timeoutMs: CRAWL_TIMEOUT });
      const t = out.totals || {};
      toast(
        `已${rebuild ? '全量重抓' : '抓取更新'} ${out.count} 个源：新增 ${t.added} / 更新 ${t.updated} / 未变 ${t.unchanged}` +
          (t.failed ? ` · 失败 ${t.failed} 页` : '')
      );
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  async function removeSource(name) {
    const ok = await dialog({
      title: '移除采集源',
      message: `把 [${name}] 从采集源列表移除？\n默认只解登记，抓下来的文件与索引保留（它仍是一个知识库）。`,
      okText: '移除',
      danger: true,
    });
    if (!ok) return;
    setBusy('remove');
    try {
      const out = await api('/api/crawl/remove', { method: 'POST', body: { name } });
      toast(`已移除 [${name}]`);
      await refresh();
      return out;
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy('');
    }
  }

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  const loading = st === null;
  const pending = '…';

  return (
    <div className="stack">
      {dialogNode}

      <div className="card">
        <div className="colhead">
          <span>资料采集</span>
          <span className="tag">{loading ? pending : `${st.count} 个源`}</span>
        </div>
        <dl className="kv">
          <div className="kv-row">
            <dt>流程</dt>
            <dd className="mono">抓取 → 清洗成 markdown → 自动登记为知识库 → 建索引 → 检索</dd>
          </div>
          <div className="kv-row">
            <dt>范围</dt>
            <dd className="mono">静态 HTML 文档站；优先 sitemap，回退同域 BFS；只抓同源</dd>
          </div>
        </dl>

        {!loading && !st.count && (
          <div className="empty">
            还没有采集源 —— 点「添加采集源」填入一个文档站地址
          </div>
        )}

        {!loading && st.sources.map((s) => (
          <div className="row wrap" key={s.name}>
            <div className="name mono" title={s.dir}>
              [{s.name}] {s.url}
            </div>
            <div className="acts">
              {s.registered ? <span className="tag strong">已入知识库</span> : <span className="tag">未入知识库</span>}
              {s.failed > 0 ? <span className="tag bad">失败 {s.failed}</span> : null}
              <button className="btn small ghost" disabled={!!busy} onClick={() => removeSource(s.name)}>
                移除
              </button>
            </div>
            <div className="desc">
              {`${s.pages} 页 · 方式 ${s.via || '—'} · 上次抓取 ${fmtTime(s.lastRunAt)}` +
                ` · 范围 ${s.include}（≤${s.max}）`}
            </div>
          </div>
        ))}

        <div className="opt-actions">
          <button className="btn ghost" disabled={!!busy} onClick={addSource}>
            {busy === 'add' ? '添加中…' : '添加采集源'}
          </button>
          <button
            className="btn"
            disabled={!!busy || !st?.count}
            onClick={() => crawlAll(false)}
            title="只重写内容变更过的页面，其余保留"
          >
            {busy === 'run' ? '抓取中…' : '抓取更新（增量）'}
          </button>
          <button
            className="btn ghost"
            disabled={!!busy || !st?.count}
            onClick={() => crawlAll(true)}
            title="忽略已存内容，把所有页面重新抓一遍"
          >
            {busy === 'run' ? '处理中…' : '重新抓取（全量）'}
          </button>
        </div>

        <CliHints module="crawl" />
      </div>
    </div>
  );
}
