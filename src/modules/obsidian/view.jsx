// obsidian 视图：项目总览（表格 + 抽屉）。
//
// 形态选择的理由（改之前先读三句）：
// 1. 这一页的主体是「有哪些项目、各自什么状态」——用表格，不用卡片堆：
//    卡片要纵向滚动、没法按列比较、批量选择也没有落点。
// 2. 详情 / 导出 / 导入都进右侧抽屉：那是「对着某一项做事」，
//    抽屉能同时看见背后的表（用户刚点的是哪一行，不该被一块遮罩抹掉）。
// 3. vault 路径与规范文档登记表不是日常操作，收进抽屉的「设置」，不占首屏。
//
// 三条不能改的行为约定：
// - `list === null` 是「还不知道」，必须显示 Spinner。渲染成「0 个项目」是把
//   「还没读到」说成「一个都没有」——本项目反复出过这类失效（见 MEMORY 的 st === null 条目）。
// - 批量选择默认**空**：复选框是给「导出」用的破坏性入口，一进来就全选会让
//   「导出所选」看起来像「导出一个」那样无害。全选是一次显式点击。
// - 导出的两种去处是同一件事的两个目的地：给了路径 = 服务端落盘；没给 = 浏览器下载
//   （只有浏览器知道「下载」是哪个目录）。导入的拖拽只给得出字节，所以必须先上传。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiDownload, apiUpload, saveBlob } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Copyable, Drawer, Spinner, useToast } from '../../web/frontend/components/ui.jsx';

const EXPORT_TIMEOUT_MS = 120000;
const IMPORT_TIMEOUT_MS = 180000;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 路径的「最后一节」：页头用它当标题（完整路径留在下面一行，可点击复制）。
function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// 相对时间：扫「多久没动」比读绝对时间快；绝对时间留在 title 里。
function relTime(at) {
  if (!at) return '—';
  const t = new Date(String(at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) return at;
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.round(d / 30)} 个月前`;
}

// 「存在 / 缺失」标记：**只用 --bad 一个语义色**，成功态走 --mid。
// 曾经写成 var(--ok, #2a7)，而 --ok 这个 token 根本不存在 → 落到硬编码绿色，
// 在浅灰底上只有 2.74:1（CDP 实测）。语义色只许有一个。
function Mark({ ok, missingText }) {
  return <span className={ok ? 'muted' : 'bad'}>{ok ? '✓ 存在' : `✗ ${missingText}`}</span>;
}

function resultLines(title, lines, bad) {
  return { title, lines, bad: Boolean(bad) };
}

export default function ObsidianView() {
  const toast = useToast();

  // 两个数据源：配置/解析结果（cfg）与项目清单（list）。各自加载，互不阻塞。
  const [cfg, setCfg] = useState(null);
  const [list, setList] = useState(null); // null = 还没读到
  const [loadErr, setLoadErr] = useState('');

  const [sel, setSel] = useState([]); // 默认空，见文件头第 2 条
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortKey, setSortKey] = useState('un');
  const [sortDir, setSortDir] = useState(-1);

  const [stage, setStage] = useState(null); // null | project | export | import | settings
  const [cur, setCur] = useState(null); // 当前项目名
  const [backTo, setBackTo] = useState(null); // 从项目详情跳进导出时记住来源

  // 导出
  const [outPath, setOutPath] = useState('');
  const [expRes, setExpRes] = useState(null);

  // 导入
  const [drop, setDrop] = useState(null);
  const [inPath, setInPath] = useState('');
  const [over, setOver] = useState(false);
  const [bindPath, setBindPath] = useState('');
  const [force, setForce] = useState(false);
  const [dryNames, setDryNames] = useState([]); // 预演报出的同名冲突
  const [impRes, setImpRes] = useState(null);

  // 设置（vault + 规范文档登记表）
  const [vault, setVault] = useState('');
  const [docs, setDocs] = useState([]);
  const [saved, setSaved] = useState({ vault: '', docs: [] });
  const [newKey, setNewKey] = useState('');
  const [newPath, setNewPath] = useState('');

  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      // 并行：配置是本地读，项目清单要扫全库（慢），分开取也方便各自显示加载态
      const [c, l] = await Promise.all([api('/api/obsidian'), api('/api/obsidian/projects')]);
      setCfg(c);
      setList(l);
      const names = (l.projects || []).map((p) => p.name);
      // 刷新只保留仍然存在的选择；用户清空过就保持清空（不要把他取消的选择「补回来」）
      setSel((prev) => prev.filter((n) => names.includes(n)));
      const list2 = Object.entries(c.config?.docs || {}).map(([key, rel]) => ({ key, rel }));
      setSaved({ vault: c.config?.vault || '', docs: list2 });
      setVault(c.config?.vault || '');
      setDocs(list2);
      setLoadErr('');
    } catch (e) {
      setLoadErr(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const projects = list?.projects || [];
  const totalDocs = projects.reduce((s, p) => s + p.docs, 0);
  const totalUn = projects.reduce((s, p) => s + (p.unresolved || 0), 0);
  const noBase = projects.filter((p) => !p.base).length;

  // ---- 列表：筛选 + 搜索 + 排序 ----
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (kw && !p.name.toLowerCase().includes(kw)) return false;
      if (filter === 'un') return (p.unresolved || 0) > 0;
      if (filter === 'nobase') return !p.base;
      if (filter === 'picked') return sel.includes(p.name);
      return true;
    });
    const val = (p) => {
      if (sortKey === 'name') return p.name;
      if (sortKey === 'at') return String(p.updatedAt || '');
      return Number(p[sortKey] || 0);
    };
    return filtered.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      let r = 0;
      if (typeof x === 'string') r = x.localeCompare(y);
      else r = x - y;
      if (r !== 0) return r * sortDir;
      // 同值永远按名字升序：跟着 dir 一起翻会让「并列的两行」在切换升降序时莫名换位
      return a.name.localeCompare(b.name);
    });
  }, [projects, q, filter, sel, sortKey, sortDir]);

  const picked = projects.filter((p) => sel.includes(p.name));
  const pickedDocs = picked.reduce((s, p) => s + p.docs, 0);

  function setSort(k) {
    if (sortKey === k) setSortDir(-sortDir);
    else {
      setSortKey(k);
      setSortDir(k === 'name' ? 1 : -1);
    }
  }

  function toggleOne(name) {
    setSel((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  const allShownPicked = rows.length > 0 && rows.every((p) => sel.includes(p.name));

  function toggleAll(on) {
    setSel((prev) => {
      const shown = rows.map((p) => p.name);
      return on ? [...new Set([...prev, ...shown])] : prev.filter((n) => !shown.includes(n));
    });
  }

  // ---- 抽屉开合 ----
  function close() {
    setStage(null);
    setCur(null);
    setBackTo(null);
    setBusy('');
  }

  function openProject(name) {
    setCur(name);
    setBackTo(null);
    setStage('project');
  }

  function openExport(names, from) {
    setCur(names.length === 1 ? names[0] : null);
    setBackTo(from || null);
    setOutPath('');
    setExpRes(null);
    setStage('export');
  }

  function openImport(from) {
    setBackTo(from || null);
    setDrop(null);
    setInPath('');
    setForce(false);
    setBindPath('');
    setDryNames([]);
    setImpRes(null);
    setStage('import');
  }

  function openSettings() {
    setBackTo(null);
    setStage('settings');
  }

  // ---- 导出 ----
  async function doExport(names) {
    if (!names.length) {
      toast('先勾选要导出的项目', 'bad');
      return;
    }
    const target = outPath.trim();
    setBusy('export');
    setExpRes(null);
    try {
      if (target) {
        const r = await api('/api/obsidian/export', {
          method: 'POST',
          body: { name: names.join(','), out: target },
          timeoutMs: EXPORT_TIMEOUT_MS,
        });
        const lines = [
          { text: `导出 ${r.projects.length} 个项目 · ${r.fileCount} 个文件 · 原文 ${fmtBytes(r.fileBytes)} → 包 ${fmtBytes(r.bytes)}` },
          { text: `包体 ${r.out}` },
        ];
        for (const p of r.projects) {
          lines.push({ text: `  [${p.name}] ${p.files} 文件 · project: ${p.projectPath || '（未绑定）'}` });
        }
        for (const s of r.skipped || []) lines.push({ text: `  跳过 ${s.path}（${s.reason}）`, bad: true });
        if (r.next) lines.push({ text: `下一步 ${r.next}` });
        setExpRes(resultLines('导出完成', lines));
        toast('已导出');
      } else {
        const r = await apiDownload('/api/obsidian/export', { name: names.join(',') }, { timeoutMs: EXPORT_TIMEOUT_MS });
        saveBlob(r.blob, r.filename);
        setExpRes(
          resultLines('已交给浏览器下载', [
            { text: `包名 ${r.filename}` },
            { text: `大小 ${fmtBytes(r.bytes)} · ${names.length} 个项目` },
            { text: '没指定路径 = 走浏览器下载，保存位置由浏览器/系统的下载设置决定' },
          ])
        );
        toast('已下载');
      }
    } catch (e) {
      const msg = String(e.message || e);
      setExpRes(resultLines('导出失败', [{ text: msg, bad: true }], true));
      toast(msg, 'bad');
    } finally {
      setBusy('');
    }
  }

  // ---- 导入 ----
  function pickFile(f) {
    if (!f) return;
    if (!f.size) {
      toast(`${f.name} 是空文件`, 'bad');
      return;
    }
    setDrop(f);
    setInPath('');
    // 换了文件，上一次的冲突结论就作废——否则会带着旧结论去点「导入」
    setDryNames([]);
    setForce(false);
    setImpRes(null);
  }

  async function doImport(dry) {
    if (!drop && !inPath.trim()) {
      toast('拖入一个 zip，或填 zip 路径', 'bad');
      return;
    }
    setBusy(dry ? 'dry' : 'import');
    try {
      let r;
      if (drop) {
        // 每次操作都重新上传：服务端的临时文件在一次请求结束就删（不留状态），
        // 预演与导入因此是两次独立请求，代价只是再传一遍字节。
        r = await apiUpload(
          '/api/obsidian/import',
          drop,
          { force, 'dry-run': dry, 'project-path': bindPath.trim() },
          { timeoutMs: IMPORT_TIMEOUT_MS }
        );
      } else {
        const body = { file: inPath.trim() };
        if (dry) body['dry-run'] = true;
        if (force) body.force = true;
        if (bindPath.trim()) body['project-path'] = bindPath.trim();
        r = await api('/api/obsidian/import', { method: 'POST', body, timeoutMs: IMPORT_TIMEOUT_MS });
      }

      if (dry) {
        const lines = [{ text: `目标 vault ${r.vault}` }, { text: `包 ${r.file}` }];
        for (const p of r.wouldImport) {
          const bits = [`  [${p.name}] ${p.files} 文件 · ${fmtBytes(p.bytes)}`];
          bits.push(`project: ${p.projectPath || '（未绑定）'}${p.projectPathExists === false ? '（本机不存在）' : ''}`);
          if (p.conflict) bits.push('同名已存在 → 需勾选「覆盖同名」');
          lines.push({ text: bits.join(' · '), bad: Boolean(p.conflict) });
        }
        for (const x of r.ignored || []) lines.push({ text: `  忽略（manifest 未列）${x}` });
        lines.push({ text: r.note || '只做了校验与规划，没有写入任何文件' });
        // 「覆盖」开关只在预演**如实报出**冲突后才出现：提前摆一个能勾的开关等于诱导误操作
        setDryNames(r.wouldOverwrite || []);
        setImpRes(resultLines('预演（没有写入任何文件）', lines, (r.wouldOverwrite || []).length > 0));
        toast('预演完成');
      } else {
        const lines = [{ text: `已导入 ${r.imported.length} 个项目 → ${r.vault}` }];
        for (const p of r.imported) {
          lines.push({
            text:
              `  [${p.name}] ${p.dir}/ · ${p.files} 文件 · project: ` +
              `${p.projectPath || '（未绑定）'}${p.projectPathRewritten ? '（已改写）' : ''}`,
          });
        }
        if (r.backup) lines.push({ text: `被覆盖旧目录的备份 ${r.backup}` });
        for (const x of r.ignored || []) lines.push({ text: `  忽略（manifest 未列）${x}` });
        if (r.next) lines.push({ text: `下一步 ${r.next}` });
        setImpRes(resultLines('导入完成', lines));
        setDryNames([]);
        toast(`已导入 ${r.imported.length} 个项目`);
        // 导入会改磁盘上的项目树，列表必须重读——否则面板显示的是导入前的快照
        await load();
      }
    } catch (e) {
      const msg = String(e.message || e);
      setImpRes(resultLines(dry ? '预演失败' : '导入失败', [{ text: msg, bad: true }], true));
      toast(msg, 'bad');
    } finally {
      setBusy('');
    }
  }

  // ---- 设置：vault 与规范文档登记表 ----
  function sameDocs(a, b) {
    if (a.length !== b.length) return false;
    const ma = new Map(a.map((d) => [d.key, d.rel]));
    for (const d of b) if (ma.get(d.key) !== d.rel) return false;
    return true;
  }

  const dirty = vault !== saved.vault || !sameDocs(docs, saved.docs);

  async function saveSettings() {
    // 登记项用**扁平键** docs.<key> 发出去（service 的白名单只认这个形状）；
    // 被移除的登记项发空值 = 注销，否则删不掉。
    const body = { vault };
    for (const d of docs) body[`docs.${d.key}`] = d.rel;
    for (const d of saved.docs) if (!docs.some((x) => x.key === d.key)) body[`docs.${d.key}`] = '';
    try {
      await api('/api/obsidian', { method: 'POST', body });
      toast('已保存（store.json）');
      await load();
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
  }

  if (loadErr) return <div className="empty bad">接口调用失败：{loadErr}</div>;

  const vaultAbs = cfg?.vault || '';
  const configured = cfg?.configured !== false && Boolean(vaultAbs);

  // ---------------- 页头 ----------------
  const pagehead = (
    <div className="pagehead">
      <div className="pagehead-main">
        <h1>{configured ? baseName(vaultAbs) : 'Obsidian'}</h1>
        <div className="phmeta">
          {configured ? (
            <>
              <Copyable className="path" text={vaultAbs} title="点击复制 vault 路径">
                {vaultAbs}
              </Copyable>
              <span className="sep" />
              <span>
                {projects.length} 个项目 · {totalDocs} 篇文档
              </span>
              <span className="sep" />
              <span>来源 {cfg.source}</span>
            </>
          ) : (
            <span>vault 未设置——点右侧「设置」登记，或设环境变量 NX_OBSIDIAN_VAULT</span>
          )}
        </div>
      </div>
      <div className="phright">
        {list ? (
          <>
            <button
              className={'sig' + (totalUn ? ' bad' : '')}
              onClick={() => setFilter(totalUn ? 'un' : 'all')}
              title={totalUn ? '只看有未解析链接的项目' : '没有未解析链接'}
            >
              {totalUn ? (
                <>
                  <span className="n">{totalUn}</span> 处未解析
                </>
              ) : (
                '链接全部可解析'
              )}
            </button>
            <button
              className={'sig' + (noBase ? ' bad' : '')}
              onClick={() => setFilter(noBase ? 'nobase' : 'all')}
              title={noBase ? '只看缺根文档的项目' : '根文档齐全'}
            >
              {noBase ? (
                <>
                  <span className="n">{noBase}</span> 个项目缺根文档
                </>
              ) : (
                '根文档齐全'
              )}
            </button>
          </>
        ) : null}
        <button className="btn" onClick={openSettings}>
          设置
        </button>
      </div>
    </div>
  );

  // ---------------- 空态 ----------------
  let body;
  if (list === null) {
    body = (
      <div className="empty">
        <Spinner label="读取项目…" />
      </div>
    );
  } else if (list.configured === false || !configured) {
    body = (
      <div className="empty">
        vault 未设置。点右上「设置」填绝对路径，或设环境变量 NX_OBSIDIAN_VAULT，或先在「知识库」页添加目录作兜底。
      </div>
    );
  } else if (!projects.length) {
    body = (
      <div className="empty">
        还没有 <code>{list.root}/</code> 下的项目。
        {(list.hints || []).map((h) => (
          <div key={h} style={{ paddingTop: 6 }}>
            {h}
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <>
        <div className="toolbar bar">
          <div className="chips" style={{ display: 'flex', gap: 4 }}>
            {[
              ['all', '全部', projects.length],
              ['un', '有未解析', projects.filter((p) => (p.unresolved || 0) > 0).length],
              ['nobase', '缺根文档', noBase],
              ['picked', '已选', picked.length],
            ].map(([k, label, n]) => (
              <button key={k} className={'chip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
                {label}
                <span className="c">{n}</span>
              </button>
            ))}
          </div>
          <span className="grow" />
          <input
            className="search"
            type="search"
            placeholder="按项目名筛选"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" onClick={() => openImport(null)}>
            导入 zip…
          </button>
          <button
            className="btn primary"
            disabled={!picked.length}
            onClick={() => openExport(picked.map((p) => p.name), null)}
            title={picked.length ? '导出勾选的项目' : '先在左侧勾选项目'}
          >
            {picked.length ? `导出所选（${picked.length}）…` : '导出所选…'}
          </button>
        </div>

        <div className="ptable">
          <table>
            <thead>
              <tr>
                <th className="c-chk">
                  <input
                    type="checkbox"
                    aria-label="全选当前列表"
                    checked={allShownPicked}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className={'c-name sortable' + (sortKey === 'name' ? ' on' : '')} onClick={() => setSort('name')}>
                  项目<span className="ar">{sortDir < 0 ? '▼' : '▲'}</span>
                </th>
                <th className={'c-docs sortable num' + (sortKey === 'docs' ? ' on' : '')} onClick={() => setSort('docs')}>
                  文档<span className="ar">{sortDir < 0 ? '▼' : '▲'}</span>
                </th>
                <th className={'c-un sortable num' + (sortKey === 'un' ? ' on' : '')} onClick={() => setSort('un')}>
                  未解析<span className="ar">{sortDir < 0 ? '▼' : '▲'}</span>
                </th>
                <th className="c-base">根文档</th>
                <th className={'c-at sortable' + (sortKey === 'at' ? ' on' : '')} onClick={() => setSort('at')}>
                  最近更新<span className="ar">{sortDir < 0 ? '▼' : '▲'}</span>
                </th>
                <th className="c-act" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--mid)' }}>
                    没有匹配的项目
                    {q.trim() ? `（筛选词「${q.trim()}」）` : ''}
                  </td>
                </tr>
              ) : (
                rows.map((p) => {
                  const on = sel.includes(p.name);
                  return (
                    <tr
                      key={p.name}
                      className={on ? 'on' : undefined}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openProject(p.name);
                      }}
                      onClick={() => openProject(p.name)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${p.name}`}
                          checked={on}
                          onChange={() => toggleOne(p.name)}
                        />
                      </td>
                      <td>
                        <span className="pname">{p.name}</span>
                        <span className="pbind" title={p.projectPath || '（未绑定代码库）'}>
                          {p.projectPath || '（未绑定代码库）'}
                        </span>
                      </td>
                      <td className="num">{p.docs}</td>
                      <td className="num">{p.unresolved ? <span className="un">{p.unresolved}</span> : '—'}</td>
                      <td className="c-base">
                        {p.base ? <span className="muted">就位</span> : <span className="bad">缺失</span>}
                      </td>
                      <td className="c-at at muted" title={p.updatedAt || ''}>
                        {relTime(p.updatedAt)}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="ract">
                          <button className="iconb" title="导出此项目" onClick={() => openExport([p.name], null)}>
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                              <path d="M8 2v8M5 7l3 3 3-3M2.5 12.5h11" />
                            </svg>
                          </button>
                          <button className="iconb" title="打开详情" onClick={() => openProject(p.name)}>
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                              <path d="M6 3l5 5-5 5" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          <div className="ptable-foot">
            <span>
              显示 <b>{rows.length}</b> / {projects.length} 个项目 · <b>{rows.reduce((s, p) => s + p.docs, 0)}</b> 篇
            </span>
            <span className="grow" />
            <span>
              {picked.length ? (
                <>
                  已选 <b>{picked.length}</b> 个 · <b>{pickedDocs}</b> 篇
                </>
              ) : (
                '未选任何项目'
              )}
            </span>
          </div>
        </div>

        <p className="muted" style={{ fontSize: 11, margin: '10px 0 0' }}>
          点行打开详情；复选框只用于批量导出。索引不在迁移包里，导入后要 <code>kb index</code> 重建。
        </p>

        {(list.hints || []).map((h) => (
          <p key={h} className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
            {h}
          </p>
        ))}
      </>
    );
  }

  // ---------------- 抽屉内容 ----------------
  const project = cur ? projects.find((p) => p.name === cur) : null;

  let dTitle = '';
  let dSub = null;
  let dBody = null;
  let dFoot = null;
  let onBack = null;

  if (stage === 'project' && project) {
    dTitle = project.name;
    dSub = (
      <>
        {project.docs} 篇 · {project.base ? '根文档就位' : <span className="bad">缺根文档</span>} · 未解析{' '}
        {project.unresolved ? <span className="bad">{project.unresolved}</span> : '0'} · 更新于{' '}
        {relTime(project.updatedAt)}
      </>
    );
    dBody = (
      <>
        <div className="dsect">代码库绑定</div>
        <div className="kv">
          <div className="kv-row">
            <dt>路径</dt>
            <dd>
              {project.projectPath ? (
                <Copyable className="mono" text={project.projectPath}>
                  {project.projectPath}
                </Copyable>
              ) : (
                <span className="muted">（未绑定）</span>
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>根文档</dt>
            <dd>
              {project.base ? (
                <span className="mono">{project.base.split('/').pop()}</span>
              ) : (
                <span className="muted">（尚无，用 ask 建）</span>
              )}
            </dd>
          </div>
          <div className="kv-row">
            <dt>目录</dt>
            <dd>
              <span className="mono">{project.rel}/</span>
            </dd>
          </div>
        </div>

        <div className="dsect" style={{ marginTop: 16 }}>
          文档（{project.docs}）
        </div>
        <div>
          {(project.documents || []).map((d) => (
            <div key={d.file} className="kv-row">
              <dt className="mono" style={{ width: 'auto', flex: 1, paddingRight: 10, color: 'var(--ink)' }}>
                <span className="nowrap" title={d.file}>
                  {d.file}
                </span>
              </dt>
              <dd className="muted nowrap" style={{ padding: '6px 0', fontSize: 11 }}>
                {d.title}
              </dd>
            </div>
          ))}
        </div>

        {project.unresolved ? (
          <>
            <div className="dsect" style={{ marginTop: 16 }}>
              待修
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {project.unresolved} 处未解析链接。先跑 <code>obsidian scan</code> 看清楚，再逐条修。
            </div>
          </>
        ) : null}
      </>
    );
    dFoot = (
      <>
        <button className="btn" onClick={() => openImport(project.name)}>
          导入覆盖…
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={() => openExport([project.name], project.name)}>
          导出此项目…
        </button>
      </>
    );
  } else if (stage === 'export') {
    const names = backTo ? [cur] : picked.map((p) => p.name);
    const files = projects.filter((p) => names.includes(p.name)).reduce((s, p) => s + p.docs, 0);
    dTitle = '导出';
    dSub = `${names.length} 个项目 · ${files} 个文件`;
    onBack = backTo ? () => openProject(backTo) : null;
    dBody = (
      <>
        <div className="dsect">将导出</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {names.length === 0 ? (
            <span className="tag bad">没有勾选项目</span>
          ) : (
            names.map((n) => {
              const p = projects.find((x) => x.name === n);
              return (
                <span className="tag" key={n} title={p && !p.base ? '缺根文档：导出不受影响，但目标机器仍需 ask 建根' : ''}>
                  {n}
                  <span className="muted" style={{ marginLeft: 4 }}>
                    {p ? p.docs : 0}
                  </span>
                </span>
              );
            })
          )}
        </div>

        <div className="dsect" style={{ marginTop: 16 }}>
          写到哪儿
        </div>
        <div className="opt-row">
          <input
            type="text"
            placeholder="输出 zip 路径（留空 = 浏览器下载）"
            value={outPath}
            onChange={(e) => setOutPath(e.target.value)}
          />
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {outPath.trim()
            ? `包名 kn-<项目>-<时间戳>.zip，写到 ${outPath.trim()}`
            : '留空 = 交给浏览器，包名 kn-<项目>-<时间戳>.zip'}
        </div>

        {expRes ? (
          <div style={{ marginTop: 12 }}>
            <div className={'dsect' + (expRes.bad ? ' bad' : '')}>{expRes.title}</div>
            <div className="snippet-box">
              <pre>
                {expRes.lines.map((l, i) => (
                  <span key={i} className={l.bad ? 'bad' : undefined}>
                    {l.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <CliHints id="obsidian.export" note="CLI 打同一个包" />
        </div>
      </>
    );
    dFoot = (
      <>
        <span className="hint">不含 zg 索引，导入后需 kb index</span>
        <span className="grow" />
        <button className="btn primary" disabled={!names.length || busy === 'export'} onClick={() => doExport(names)}>
          {busy === 'export' ? '导出中…' : '开始导出'}
        </button>
      </>
    );
  } else if (stage === 'import') {
    dTitle = '导入 zip';
    dSub = '先预演看清楚会改什么，再落地';
    onBack = backTo ? () => openProject(backTo) : null;
    const hasInput = Boolean(drop) || Boolean(inPath.trim());
    dBody = (
      <>
        <div className="dsect">交付一个包</div>
        <label
          className={over ? 'dropzone over' : 'dropzone'}
          style={{ flexDirection: 'column', gap: 3, height: 96 }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            pickFile(e.dataTransfer.files && e.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              pickFile(e.target.files && e.target.files[0]);
              e.target.value = ''; // 允许连续选同一个文件（否则第二次不触发 change）
            }}
          />
          <div style={{ color: drop ? 'var(--ink)' : undefined }}>
            {drop ? `${drop.name}（${fmtBytes(drop.size)}）` : '把 zip 拖到这里，或点击选择'}
          </div>
          <div style={{ fontSize: 11 }}>{drop ? '已选 · 点「预演」检查' : '选好之后先点「预演」'}</div>
        </label>

        <div className="opt-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder={drop ? '（用上面拖入的文件）' : '或填 zip 绝对路径'}
            value={inPath}
            disabled={Boolean(drop)}
            onChange={(e) => {
              setInPath(e.target.value);
              setDryNames([]);
              setForce(false);
              setImpRes(null);
            }}
          />
          {drop ? (
            <button className="btn ghost" onClick={() => setDrop(null)}>
              换路径
            </button>
          ) : null}
        </div>

        <div className="dsect" style={{ marginTop: 16 }}>
          绑定改写（可选）
        </div>
        <div className="opt-row">
          <input
            type="text"
            placeholder="本机代码库绝对路径（留空 = 保留包里的旧 project 绑定）"
            value={bindPath}
            onChange={(e) => setBindPath(e.target.value)}
          />
        </div>

        {dryNames.length ? (
          <label className="opt-row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span className={force ? undefined : 'bad'} style={{ fontSize: 11, lineHeight: 1.5 }}>
              覆盖同名项目：{dryNames.join('、')}（先整目录备份，再替换而不是叠加）
            </span>
          </label>
        ) : null}

        {impRes ? (
          <div style={{ marginTop: 12 }}>
            <div className={'dsect' + (impRes.bad ? ' bad' : '')}>{impRes.title}</div>
            <div className="snippet-box">
              <pre>
                {impRes.lines.map((l, i) => (
                  <span key={i} className={l.bad ? 'bad' : undefined}>
                    {l.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <CliHints id="obsidian.import" note="CLI 导入同一个包" />
        </div>
      </>
    );
    dFoot = (
      <>
        <span className="hint">预演 = 零写入</span>
        <span className="grow" />
        <button className="btn" disabled={!hasInput || Boolean(busy)} onClick={() => doImport(true)}>
          {busy === 'dry' ? '预演中…' : '预演'}
        </button>
        <button
          className="btn primary"
          disabled={!hasInput || Boolean(busy) || (dryNames.length > 0 && !force)}
          onClick={() => doImport(false)}
          title={dryNames.length && !force ? '同名项目已存在：先勾选「覆盖同名项目」' : '写入磁盘'}
        >
          {busy === 'import' ? '导入中…' : '导入'}
        </button>
      </>
    );
  } else if (stage === 'settings') {
    dTitle = '设置';
    dSub = 'vault 定位与规范文档登记表（写进 store.json，CLI 读同一份）';
    dBody = (
      <>
        <div className="dsect">vault 绝对路径</div>
        <div className="opt-row">
          <input
            type="text"
            placeholder="D:\\code\\a_md\\obsidian_init"
            value={vault}
            onChange={(e) => setVault(e.target.value)}
          />
        </div>
        {cfg && cfg.configured ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            <Mark ok={cfg.vaultExists} missingText="目录不存在" /> · .obsidian{' '}
            <Mark ok={cfg.hasObsidianMarker} missingText="未发现" /> · 来源 {cfg.source}
          </div>
        ) : null}

        <div className="dsect" style={{ marginTop: 16 }}>
          规范文档登记表
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          登记项的 key 是 skill 取内容的名字（<code>obsidian spec --doc &lt;key&gt;</code> 输出全文）；路径相对 vault 根。
        </div>
        {(cfg?.docs || []).map((d) => {
          const edit = docs.find((x) => x.key === d.key);
          if (!edit) return null;
          return (
            <div className="opt-row" key={d.key}>
              <span className="opt-label">{d.key}</span>
              <input
                type="text"
                value={edit.rel}
                onChange={(e) => setDocs(docs.map((x) => (x.key === d.key ? { ...x, rel: e.target.value } : x)))}
              />
              <span className="nowrap" style={{ fontSize: 11 }}>
                <Mark ok={d.exists} missingText="缺失" />
              </span>
              <button className="btn ghost" title="注销这一项" onClick={() => setDocs(docs.filter((x) => x.key !== d.key))}>
                移除
              </button>
            </div>
          );
        })}
        <div className="opt-row">
          <span className="opt-label">新增</span>
          <input type="text" placeholder="key（如 style）" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
          <input
            type="text"
            placeholder="相对路径（如 nx-kn/我的写作风格.md）"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <button
            className="btn"
            onClick={() => {
              const key = newKey.trim();
              const rel = newPath.trim();
              if (!key || !rel) return;
              if (docs.some((d) => d.key === key)) {
                toast(`登记项 ${key} 已存在`, 'bad');
                return;
              }
              setDocs([...docs, { key, rel }]);
              setNewKey('');
              setNewPath('');
            }}
          >
            加入
          </button>
        </div>

        {(cfg?.hints || []).length ? (
          <>
            <div className="dsect" style={{ marginTop: 16 }}>
              提示
            </div>
            {(cfg.hints || []).map((h) => (
              <div key={h} className="bad" style={{ fontSize: 11, padding: '2px 0' }}>
                {h}
              </div>
            ))}
          </>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <CliHints id="obsidian.set" note="CLI 写同一份数据（vault= / docs.<key>=）" />
          <CliHints id="obsidian.get" note="CLI 读同一份数据" />
          <CliHints id="obsidian.scan" note="扫未解析双链" />
        </div>
      </>
    );
    dFoot = (
      <>
        <span className="hint">{dirty ? '有未保存的改动' : '没有改动'}</span>
        <span className="grow" />
        <button className="btn primary" disabled={!dirty} onClick={saveSettings}>
          保存
        </button>
      </>
    );
  }

  return (
    <div>
      {pagehead}
      {body}

      <Drawer open={stage !== null} title={dTitle} sub={dSub} onClose={close} onBack={onBack} footer={dFoot}>
        {dBody}
      </Drawer>
    </div>
  );
}
