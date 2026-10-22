// 知识库管理面：zg/索引状态、库列表、增删、增量/重建索引、守护，以及一键流水线。
//
// 这块 UI 原先长在知识库 tab 里，mount 即拉 /api/kb/status（要逐库起 zg 子进程，
// 秒级）——检索页为此付出了不该有的冷启动代价。现在它是「设置 → 流水线」子页的
// 唯一管理面：**点开才挂载、才发请求**，知识库检索页彻底冷启动。
//
// 一键流水线（原首页的 PipelineOverview）也合并在这一张卡里：它的数据就是
// kb/status + crawl/list，与管理面同源——分两个组件会把同两个接口拉两遍。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Spinner, useDialog, useToast } from '../../web/frontend/components/ui.jsx';
import { onKbChanged } from '../../web/frontend/events.js';

// 一键流水线：抓取（外部引擎可能要拉依赖）+ 索引（全库嵌入）都是慢操作，给 30 分钟上限。
const PIPELINE_TIMEOUT = 1_800_000;

// 新建库时的默认 embedding 兜底：本机离线、免 key、中文可用（1024 维）。
// 正常应从 status 响应里的 defaultModel 取（那样设了 NX_KN_EMBEDDING 的机器能同步），
// 这里只是 status 还没回来时的兜底，避免对话框落到空串。
const FALLBACK_MODEL = 'local/qwen3-embedding-0.6b';

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

// 守护一行字。刻意把「最近一次刷新」放在最前——用户打开面板最想知道的是
// 「它刚才有没有帮我更新」，而不是「它监听了几个目录」。
function watchText(w) {
  if (!w || !w.running) {
    return '未运行 —— 笔记改动不会自动进索引，需手动点「更新索引（增量）」。（serve 启动时默认开启）';
  }
  const last = (w.events || []).find((e) => e.type === 'indexed');
  const lastTxt = last
    ? `最近刷新 ${new Date(last.at).toLocaleTimeString('zh-CN', { hour12: false })}` +
      (last.changes ? `（新增 ${last.changes.added ?? 0} / 改动 ${last.changes.modified ?? 0}）` : '')
    : '还没刷新过';
  return (
    `${lastTxt} · 监听 ${w.vaults.length} 个库 · 防抖 ${w.debounceMs}ms` +
    ` · 累计 ${w.runs} 次${w.errors ? ` · 错误 ${w.errors} 次` : ''}`
  );
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

export default function KbManage() {
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const [crawl, setCrawl] = useState(null);
  const [st, setSt] = useState(null);
  const [w, setW] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api('/api/crawl/list'), api('/api/kb/status')]);
      setCrawl(c);
      setSt(s);
      setErr('');
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  // 守护状态走轻量接口（只读内存，不碰 zg），与昂贵的 status 分开拉。
  const refreshWatch = useCallback(async () => {
    try {
      setW(await api('/api/kb/watch'));
    } catch {
      setW(null); // 守护状态拿不到不该影响管理面其余部分
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshWatch();
  }, [refresh, refreshWatch]);

  // 采集动作（抓取/整理/流水线）完成时广播 kb-changed，这里跟着刷新库列表——
  // 否则「刚抓完的源已自动登记为知识库」要等手动刷新才可见。
  useEffect(() => onKbChanged(() => { refresh(); refreshWatch(); }), [refresh, refreshWatch]);

  // 守护跑着才轮询：没跑时它不会自己变，白轮询只是浪费。
  useEffect(() => {
    if (!w?.running) return undefined;
    const id = setInterval(refreshWatch, 3000);
    return () => clearInterval(id);
  }, [w?.running, refreshWatch]);

  // 一键流水线：抓取 → 索引。两步在服务端串联，前端只等最终汇总。
  async function runPipeline() {
    setBusy('pipeline');
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
      setBusy('');
    }
  }

  async function addVault() {
    // 默认模型以服务端为准（它知道 NX_KN_EMBEDDING）：面板写死一个值的话，
    // 在内网/CI 这类默认被改过的机器上，预填的会是个拉不下来的模型。
    const defaultModel = st?.defaultModel || FALLBACK_MODEL;
    const r = await dialog({
      title: '添加知识库目录',
      message: '填入 Obsidian vault 的绝对路径。可以添加多个，检索时会把结果合并成一张列表。',
      fields: [
        { key: 'path', label: '目录', placeholder: 'D:\\Notes\\MyVault', value: '' },
        { key: 'model', label: 'embedding 模型（可留空）', placeholder: defaultModel, value: defaultModel },
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
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  // 让一个「默认未参与检索」的库（抓取产物，与其源库内容重叠）重新参与。
  // 实现就是拿同一个路径再 kb add 一次——服务端会把它记成「用户显式要的」。
  async function enableVault(path, name) {
    setBusy('add');
    try {
      const out = await api('/api/kb/add', { method: 'POST', body: { path } });
      toast(`[${name}] 已启用检索（共 ${out.count} 个库）`);
      await refresh();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  // 增量与全量走同一条 action，只是 rebuild 不同。增量是主按钮：新写了笔记只该点它。
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
      const out = await api('/api/kb/index', { method: 'POST', body: { rebuild }, timeoutMs: PIPELINE_TIMEOUT });
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

  async function toggleWatch(on) {
    setBusy('watch');
    try {
      const out = await api('/api/kb/watch', { method: 'POST', body: { on } });
      toast(out.running ? '守护已启动（笔记一变就自动更新索引）' : '守护已停止（需手动更新索引）');
      await refreshWatch();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    } finally {
      setBusy('');
    }
  }

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  const loading = crawl === null || st === null;
  const totals = st?.totals;
  const vaults = (st?.vaults || []).filter((v) => !v.missing);
  const sources = crawl?.sources || [];

  return (
    <div className="card">
      {dialogNode}
      <div className="colhead">
        <span>流水线总览</span>
        {loading ? <Spinner /> : (
          <span className="tag">
            {st?.zg?.installed ? `zg ${st.zg.version || ''}` : 'zg 未找到'}
            {totals ? ` · ${totals.vaults} 个库` : ''}
          </span>
        )}
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
        status={!loading && <span className="tag">{crawl.count} 个源</span>}
        desc={loading ? '' : '产物落 ~/.nx-kn/sources/ · 自动登记为知识库（采集源管理见下方「资料采集」卡）'}
      >
        {!loading && sources.map((s) => (
          <div className="desc" key={s.name} title={s.dir}>
            [{s.name}] {s.kind === 'local' ? '本地目录' : s.url} · {s.pages ?? 0} 页 · 上次 {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '未抓取'}
          </div>
        ))}
        {!loading && !sources.length && <div className="desc muted">还没有采集源 —— 在下方「资料采集」卡里添加</div>}
      </Stage>

      <Stage
        num="②"
        title="更新索引"
        status={
          !loading && (
            <span className="tag">
              {totals ? `${totals.vaults} 个库${totals.stale ? ` · 待更新 ${totals.stale}` : ''}` : ''}
            </span>
          )
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
        <button className="btn" disabled={busy === 'pipeline' || loading || (!crawl?.count && !totals?.vaults)} onClick={runPipeline}>
          {busy === 'pipeline' ? '流水线运行中…' : '一键跑流水线（抓取 → 索引）'}
        </button>
      </div>
      <CliHints id="home.pipeline" note="两步串联、各自增量；没有源/库的步骤自动跳过" />

      {/* ---- 知识库管理（原知识库 tab 的管理卡整体搬到这里）---- */}
      <dl className="kv" style={{ borderTop: '1px solid var(--soft-2)' }}>
        <div className="kv-row">
          <dt>目录</dt>
          <dd className="mono">
            {loading ? (
              <Spinner label="正在读各库的索引状态…" />
            ) : st?.configured ? (
              `${totals.vaults} 个 · 索引 ${totals.indexed} 个 · 共 ${totals.notes} 篇可索引 md` +
                (totals.standby ? ` · 未参与检索 ${totals.standby} 个` : '')
            ) : (
              '（未添加）'
            )}
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

      {!loading && st?.configured && st.vaults.map((v) => (
        <div className="row wrap" key={v.path}>
          <div className="name mono" title={v.path}>
            [{v.name}] {v.path}
          </div>
          <div className="acts">
            {v.standby ? <span className="tag">未参与检索</span> : null}
            {v.missing ? (
              <span className="tag bad">目录不存在</span>
            ) : v.indexed ? (
              v.index?.stale ? <span className="tag">待更新</span> : <span className="tag strong">已建</span>
            ) : (
              <span className="tag">未建</span>
            )}
            {v.standby ? (
              <button className="btn small ghost" disabled={!!busy} onClick={() => enableVault(v.path, v.name)}
                title="让它参与检索。内容与源库重叠，同时参与会让同一篇笔记出两条命中">
                启用检索
              </button>
            ) : null}
            <button className="btn small ghost" disabled={!!busy} onClick={() => removeVault(v.path, v.name)}>
              移除
            </button>
          </div>
          <div className="desc">
            {v.missing
              ? '路径已失效：重新添加，或从列表移除'
              : `${notesText(v)}` +
                ` · 索引 ${v.indexed ? `${v.index?.files ?? '?'}/${v.index?.filesTotal ?? '?'} 文件 · ${v.index?.entities ?? '?'} 片段` : '未建'}` +
                ` · 模型 ${v.model || (v.plannedModel ? `（建时用 ${v.plannedModel}）` : '（未记录）')}`}
            {v.standby && v.hint ? <span className="muted">　{v.hint}</span> : null}
          </div>
        </div>
      ))}

      <div className="opt-actions">
        <button className="btn ghost" disabled={!!busy} onClick={addVault}>
          {busy === 'add' ? '添加中…' : '添加目录'}
        </button>
        <button className="btn" disabled={!!busy || !st?.configured} onClick={() => reindex(false)}
          title="只把新增/改动的笔记加进现有索引，其余向量保留">
          {busy === 'index' ? '更新中…' : '更新索引（增量）'}
        </button>
        <button className="btn ghost" disabled={!!busy || !st?.configured} onClick={() => reindex(true)}
          title="对所有库重新计算全部片段向量（换模型 / 索引损坏时用）">
          {busy === 'index' ? '处理中…' : '重建索引'}
        </button>
      </div>

      {/* ---- 守护 ---- */}
      {!loading && st?.configured && (
        <div className="row wrap" style={{ borderTop: '1px solid var(--soft-2)' }}>
          <div className="name">守护</div>
          <div className="acts">
            <span className="tag">{w?.running ? '运行中' : '已停止'}</span>
            <button className="btn small ghost" disabled={!!busy} onClick={() => toggleWatch(!w?.running)}
              title="监听已登记目录，笔记一变就自动跑增量索引">
              {busy === 'watch' ? '…' : w?.running ? '停止' : '启动'}
            </button>
          </div>
          <div className="desc">{watchText(w)}</div>
        </div>
      )}
      <CliHints id="kb.watch" note="CLI 同源：常驻守护 / 面板开关" />
      <CliHints id="kb.status" note="CLI 同源：刷新上面的状态" />
    </div>
  );
}
