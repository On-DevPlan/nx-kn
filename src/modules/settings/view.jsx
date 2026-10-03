// settings 视图：「写路径」的面板示例。home 视图示范了只读拉取，
// 这里示范表单 → mutation → 持久化的完整往返（含 dirty 判断与失败 toast）。
// 表单控件按 FORM 声明渲染，新增设置键 = 加一行声明，不必新写控件逻辑。
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useToast } from '../../web/frontend/components/ui.jsx';
import { useStore } from '../../web/frontend/store.jsx';

// 示例键的控件声明：视图层自己的小事，不必进 schema。
const FORM = [
  { key: 'theme', label: '主题', type: 'select', options: ['', 'light', 'dark'] },
  { key: 'lang', label: '语言', type: 'text' },
];

export default function SettingsView() {
  const { toast } = useToast();
  const { boot } = useStore();
  const appName = boot?.app?.name || 'app';
  const [draft, setDraft] = useState({});
  const [saved, setSaved] = useState({});
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/settings')
      .then((r) => {
        setSaved(r.settings || {});
        setDraft(r.settings || {});
      })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    const patch = {};
    for (const f of FORM) if (draft[f.key]) patch[f.key] = draft[f.key];
    try {
      const r = await api('/api/settings', { method: 'POST', body: patch });
      setSaved(r.settings || {});
      setDraft(r.settings || {});
      toast('已保存（store.json）');
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="colhead">设置</div>
        {FORM.map((f) => (
          <div key={f.key} className="opt-row" style={{ padding: '0 12px' }}>
            <label className="opt-label" htmlFor={`set-${f.key}`}>{f.label}</label>
            {f.type === 'select' ? (
              <select
                id={`set-${f.key}`}
                value={draft[f.key] || ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              >
                {f.options.map((o) => (
                  <option key={o} value={o}>{o || '（未设置）'}</option>
                ))}
              </select>
            ) : (
              <input
                id={`set-${f.key}`}
                type="text"
                value={draft[f.key] || ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            )}
          </div>
        ))}
        <div className="opt-actions">
          <button className="btn" disabled={!dirty} onClick={save}>
            {dirty ? '保存' : '无改动'}
          </button>
        </div>
        <CliHints command={`${appName} settings set theme=dark   # CLI 写同一份数据`} />
        <CliHints command={`${appName} settings get            # CLI 读同一份数据`} />
      </div>
    </div>
  );
}
