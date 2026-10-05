// 首页视图：流水线总览 + 项目信息 + 命令表。
//
// 流水线总览把「资料采集 → 知识库」两个 tab 串起来看：
// 抓取和索引是前后关系不是选择关系，这里给出阶段状态 + 一键跑完整条链。
// 每个数字都来自 /api（不是硬编码），每个操作都有等价 CLI（CliHints）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import { useToast } from '../../web/frontend/components/ui.jsx';

// 抓取（外部引擎可能要拉依赖）+ 索引（全库嵌入）都是慢操作，给 30 分钟上限。
const PIPELINE_TIMEOUT = 1_800_000;

function fmtTime(iso) {
  if (!iso) return '未抓取';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ①② 阶段行：左边阶段名，右边状态与数字，底部一行说明
function Stage({ num, title, status, children, desc }) {
  return (
    <div className="row wrap">
      <div className="name">
        <span className="tag">{num}</span> {title}
      </div>
      <div className="acts">{status}</div>
      {children}
      {desc ? <div className="desc">{desc}</div> : null}
    </div>
  );
}

function PipelineOverview() {
  const toast = useToast();
  const { patchUi } = useStore();
  const [crawl, setCrawl] = useState(null);
  const [kb, setKb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [c, k] = await Promise.all([api('/api/crawl/list'), api('/api/kb/status')]);
      setCrawl(c);
      setKb(k);
      setErr('');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 一键流水线：抓取 → 索引。两步在服务端串联，前端只等最终汇总。
  async function runPipeline() {
    setBusy(true);
    try {
      const out = await api('/api/pipeline/run', { method: 'POST', body: {}, timeoutMs: PIPELINE_TIMEOUT });
      const parts = [];
      for (const s of out.steps) {
        if (s.id === 'crawl') {
          if (s.status === 'ok') {
            const t = s.result.totals || {};
            parts.push(`抓取 ${s.result.count} 源（新增 ${t.added}/更新 ${t.updated}/未变 ${t.unchanged}${t.failed ? `/失败 ${t.failed}` : ''}）`);
          } else if (s.status === 'failed') parts.push(`抓取失败：${s.error}`);
          else parts.push('抓取跳过（无源）');
        } else if (s.id === 'index') {
          if (s.status === 'ok') {
            const rs = s.result.results || [];
            const files = rs.reduce((a, v) => a + (v.index?.files ?? 0), 0);
            const entities = rs.reduce((a, v) => a + (v.index?.entities ?? 0), 0);
            parts.push(`索引 ${s.result.count} 库（${files} 文件 · ${entities} 片段）`);
          } else if (s.status === 'failed') parts.push(`索引失败：${s.error}`);
          else parts.push('索引跳过（无库）');
        }
      }
      toast(`流水线完成（${((out.elapsedMs || 0) / 1000).toFixed(0)}s）：${parts.join(' · ')}`);
      await refresh();
    } catch (e) {
      toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  const loading = crawl === null || kb === null;
  const sources = crawl?.sources || [];
  const vaults = (kb?.vaults || []).filter((v) => !v.missing);
  const totals = kb?.totals;

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  return (
    <div className="card">
      <div className="colhead">
        <span>流水线总览</span>
        <span className="tag">抓取 → 索引 → 检索</span>
      </div>
      <dl className="kv">
        <div className="kv-row">
          <dt>链路</dt>
          <dd className="mono">采集源 →（crawl 抓取）→ sources/ 产物 →（自动登记）→ 知识库 →（index）→ zg 索引 →（query）→ 命中</dd>
        </div>
      </dl>

      <Stage
        num="①"
        title="抓取采集源"
        status={
          <>
            <span className="tag">{loading ? '…' : `${crawl.count} 个源`}</span>
            <a
              className="tag"
              href="#/crawl"
              onClick={() => patchUi({ view: 'crawl' })}
              title="去资料采集页管理源"
            >
              管理 →
            </a>
          </>
        }
        desc={loading ? '' : `产物落 ~/.nx-kn/sources/ · 自动登记为知识库`}
      >
        {!loading && sources.map((s) => (
          <div className="desc" key={s.name} title={s.dir}>
            [{s.name}] {s.kind === 'local' ? '本地目录' : s.url} · {s.pages ?? 0} 页 · 上次 {fmtTime(s.lastRunAt)}
          </div>
        ))}
        {!loading && !sources.length && <div className="desc muted">还没有采集源 —— 去「资料采集」添加</div>}
      </Stage>

      <Stage
        num="②"
        title="更新索引"
        status={
          <>
            <span className="tag">
              {loading ? '…' : totals ? `${totals.vaults} 个库${totals.stale ? ` · 待更新 ${totals.stale}` : ''}` : ''}
            </span>
            <a
              className="tag"
              href="#/kb"
              onClick={() => patchUi({ view: 'kb' })}
              title="去知识库页检索"
            >
              检索 →
            </a>
          </>
        }
        desc={loading ? '' : '索引就绪后即可被 query 检索（fts + vector 双路）'}
      >
        {!loading && vaults.map((v) => (
          <div className="desc" key={v.path} title={v.path}>
            [{v.name}] 索引{' '}
            {v.indexed
              ? `${v.index?.coveragePercent ?? '?'}% · ${v.index?.files ?? '?'}/${v.index?.filesTotal ?? '?'} 文件 · ${v.index?.entities ?? '?'} 片段`
              : '未建'}
            {v.index?.stale ? ' · 待更新' : ''}
          </div>
        ))}
        {!loading && !vaults.length && <div className="desc muted">还没有知识库</div>}
      </Stage>

      <div className="opt-actions">
        {/* 一键 = 主按钮：抓取 + 索引在服务端串联，谁有变化跑谁（增量） */}
        <button className="btn" disabled={busy || loading || (!crawl?.count && !totals?.vaults)} onClick={runPipeline}>
          {busy ? '流水线运行中…' : '一键跑流水线（抓取 → 索引）'}
        </button>
      </div>
      <CliHints command="nx-kn pipeline" note="两步串联、各自增量；没有源/库的步骤自动跳过" />
    </div>
  );
}

export default function HomeView() {
  const { boot } = useStore();
  const [routes, setRoutes] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/routes')
      .then((r) => setRoutes(r))
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  return (
    <div className="stack">
      <PipelineOverview />

      <div className="card">
        <div className="colhead">项目信息</div>
        <dl className="kv">
          <div className="kv-row">
            <dt>名称</dt>
            <dd className="mono">{boot?.app?.name || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>版本</dt>
            <dd className="mono">{boot?.app?.version || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>存储</dt>
            <dd className="mono nowrap">{boot?.storePath || '—'}</dd>
          </div>
          <div className="kv-row">
            <dt>默认路径</dt>
            <dd className="mono nowrap">{boot?.storeDefault || '—'}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <div className="colhead">
          <span>CLI 命令与 HTTP 路由（同源）</span>
          <span className="tag">{routes ? routes.count : '…'} 条</span>
        </div>
        {(routes?.routes || []).map((r) => (
          <div key={r.id} className="row">
            <div className="name mono">{r.cli}</div>
            <div className="desc mono muted">{r.http || '(仅 CLI)'}</div>
            <div className="acts">
              <span className="tag">{r.module}</span>
            </div>
          </div>
        ))}
        {routes && !routes.routes.length && <div className="empty">暂无命令</div>}
        <CliHints command="nx-kn routes" note="这两张表由同一份 action 声明派生" />
      </div>
    </div>
  );
}
