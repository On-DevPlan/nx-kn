// kb 视图：知识库检索。**彻底冷启动**——本页不请求任何管理状态。
//
// 库状态、采集源、添加/移除、更新/重建索引、守护，全部在「设置 → 流水线」子页
// （src/modules/kb/manage.jsx + settings/view.jsx）：那些操作要逐库起 zg 子进程，
// 是面板里最贵的一手数据，检索页不该为它们买单。
//
// 查询是用户主动触发的（表单提交才发 /api/kb/query）；没有配置库时，query 返回
// 业务结果 needIndex + 可照做的提示，不需要先拉一遍 status 来判断。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Highlight, useToast } from '../../web/frontend/components/ui.jsx';

const LIMIT = 7;

export default function KbView() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);

  async function search(e) {
    e?.preventDefault();
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    try {
      setRes(await api(`/api/kb/query?q=${encodeURIComponent(text)}&limit=${LIMIT}`));
    } catch (e2) {
      toast(String(e2.message || e2), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
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
          />
          <button className="btn" type="submit" disabled={busy || !q.trim()}>
            {busy ? '检索中…' : '检索'}
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
                {/* 黄底只标「问句里的词在片段里字面出现」的位置。语义召回本就可能
                    一个字都不重合（同义改写、换语言），那种片段没有黄块——先说明，
                    免得被当成「高亮坏了」。 */}
                <span> · <mark className="hl">黄底</mark> = 字面命中</span>
              </div>
              {res.hits.map((h) => (
                // .row.wrap：命中带多行片段，用单行 28px 行会把片段裁到叠字。
                <div className="row wrap" key={`${h.vault}-${h.n}-${h.path}-${h.start}`}>
                  <div className="name mono">
                    {/* 多库时先说是哪个库，否则相对路径无法定位到磁盘文件 */}
                    {res.searched.length > 1 ? <span className="muted">[{h.vaultName}] </span> : null}
                    {h.path}:{h.start}-{h.end}
                    {h.heading ? (
                      <span className="muted"> · <Highlight text={h.heading} query={res.query} /></span>
                    ) : null}
                  </div>
                  <div className="acts">
                    {h.matchedBy.map((m) => <span className="tag" key={m}>{m}</span>)}
                    {h.score != null ? <span className="tag">{h.score.toFixed(3)}</span> : null}
                  </div>
                  <div className="desc">
                    <div className="snippet-box">
                      <pre>
                        {h.snippet
                          ? <Highlight text={h.snippet} query={res.query} />
                          : '（无片段：preview=none）'}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">没有命中——换个说法再试，或先确认索引里的内容是最新的（设置 → 流水线）</div>
          )
        )}

        <CliHints id="kb.query" note="检索走这条命令；库与索引管理在「设置 → 流水线」" />
      </div>
    </div>
  );
}
