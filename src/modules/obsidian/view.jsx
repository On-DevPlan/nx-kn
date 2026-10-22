// obsidian 视图：vault 定位 + 规范文档登记表的管理页。
//
// 形态照 settings 视图（表单 → mutation → 持久化 + dirty 判断），
// 但有两处刻意不同：
// 1. POST 发的是**裸键**（vault / docs.<key>），不是 CLI 的 pairs ——
//    index.js 的 patchOf 两侧都认，settings 那边只认 pairs 导致面板保存静默无效，
//    这个坑不复制。
// 2. 登记表是**可增删的键值对**（不是几个固定输入框）——内容规范会越加越多，
//    固定字段就得改代码。登记项的 key 决定 skill 取哪一份：
//    `nx-kn obsidian spec --doc <key>` 直接输出该文档全文。
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useToast } from '../../web/frontend/components/ui.jsx';

function Mark({ ok, missingText }) {
  return <span style={{ color: ok ? 'var(--ok, #2a7)' : 'var(--bad, #c33)' }}>{ok ? '✓ 存在' : `✗ ${missingText}`}</span>;
}

// 登记项在两份状态之间的比较：只看 key 与相对路径。
function sameDocs(a, b) {
  if (a.length !== b.length) return false;
  const ma = new Map(a.map((d) => [d.key, d.rel]));
  for (const d of b) {
    if (ma.get(d.key) !== d.rel) return false;
  }
  return true;
}

export default function ObsidianView() {
  const toast = useToast();
  const [vault, setVault] = useState('');
  const [docs, setDocs] = useState([]);
  const [saved, setSaved] = useState({ vault: '', docs: [] });
  const [newKey, setNewKey] = useState('');
  const [newPath, setNewPath] = useState('');
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/obsidian')
      .then((r) => {
        const list = Object.entries(r.config?.docs || {}).map(([key, rel]) => ({ key, rel }));
        setSaved({ vault: r.config?.vault || '', docs: list });
        setVault(r.config?.vault || '');
        setDocs(list);
        setSt(r);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  const dirty = vault !== saved.vault || !sameDocs(docs, saved.docs);

  function addDoc() {
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
  }

  function removeDoc(key) {
    setDocs(docs.filter((d) => d.key !== key));
  }

  function setDocPath(key, rel) {
    setDocs(docs.map((d) => (d.key === key ? { ...d, rel } : d)));
  }

  async function save() {
    // 登记项用**扁平键** docs.<key> 发出去（service 的白名单只认这个形状）；
    // 被移除的登记项发空值 = 注销，否则删不掉。
    const body = { vault };
    for (const d of docs) body[`docs.${d.key}`] = d.rel;
    for (const d of saved.docs) {
      if (!docs.some((x) => x.key === d.key)) body[`docs.${d.key}`] = '';
    }
    try {
      const r = await api('/api/obsidian', { method: 'POST', body });
      const list = Object.entries(r.config?.docs || {}).map(([key, rel]) => ({ key, rel }));
      setSaved({ vault: r.config?.vault || '', docs: list });
      setVault(r.config?.vault || '');
      setDocs(list);
      setSt(r);
      toast('已保存（store.json）');
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="colhead">Obsidian</div>
        {st && !st.configured && (
          <div className="empty">
            vault 未设置——填下面的表单，或设环境变量 NX_OBSIDIAN_VAULT，或先在「知识库」页添加目录作兜底。
          </div>
        )}
        <div className="opt-row" style={{ padding: '0 12px' }}>
          <label className="opt-label" htmlFor="obs-vault">
            vault 绝对路径
          </label>
          <input
            id="obs-vault"
            type="text"
            placeholder="D:\\code\\a_md\\obsidian_init"
            value={vault}
            onChange={(e) => setVault(e.target.value)}
          />
        </div>

        <div className="colhead" style={{ paddingTop: '12px' }}>
          规范文档登记表
        </div>
        <div className="empty" style={{ padding: '4px 12px' }}>
          登记项的 key 是 skill 取内容的名字（<code>nx-kn obsidian spec --doc &lt;key&gt;</code> 输出该文档全文）；路径相对 vault 根。
        </div>
        {docs.map((d) => (
          <div key={d.key} className="opt-row" style={{ padding: '0 12px' }}>
            <label className="opt-label" htmlFor={`obs-doc-${d.key}`}>
              {d.key}
            </label>
            <input
              id={`obs-doc-${d.key}`}
              type="text"
              value={d.rel}
              onChange={(e) => setDocPath(d.key, e.target.value)}
            />
            <button className="btn" onClick={() => removeDoc(d.key)} title="注销这一项">
              移除
            </button>
          </div>
        ))}
        <div className="opt-row" style={{ padding: '0 12px' }}>
          <label className="opt-label" htmlFor="obs-newkey">
            新增
          </label>
          <input
            id="obs-newkey"
            type="text"
            placeholder="key（如 style）"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            type="text"
            placeholder="相对路径（如 nx-kn/我的写作风格.md）"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <button className="btn" onClick={addDoc}>
            加入
          </button>
        </div>

        <div className="opt-actions">
          <button className="btn" disabled={!dirty} onClick={save}>
            {dirty ? '保存' : '无改动'}
          </button>
        </div>
        <CliHints id="obsidian.set" note="CLI 写同一份数据（vault= / docs.<key>=）" />
        <CliHints id="obsidian.get" note="CLI 读同一份数据" />
      </div>

      {st && st.configured && (
        <div className="card">
          <div className="colhead">解析结果</div>
          <div style={{ padding: '0 12px' }}>
            <div>
              vault：{st.vault}（来源 {st.source}） <Mark ok={st.vaultExists} missingText="目录不存在" />
            </div>
            <div>
              .obsidian：<Mark ok={st.hasObsidianMarker} missingText="未发现" />
            </div>
            {(st.docs || []).map((d) => (
              <div key={d.key}>
                {d.key}：{d.rel} <Mark ok={d.exists} missingText="缺失" />
              </div>
            ))}
            {(st.hints || []).map((h) => (
              <div key={h} className="bad" style={{ padding: '2px 0' }}>
                {h}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <CliHints id="obsidian.spec" note="取规范文档全文（skill 靠它拿「内容要求」）" />
        <CliHints id="obsidian.scan" note="扫未解析双链" />
        <CliHints id="obsidian.frontmatter" note="生成新笔记的 frontmatter" />
        <CliHints id="obsidian.check" note="校验新笔记有没有引入新红链" />
      </div>
    </div>
  );
}
