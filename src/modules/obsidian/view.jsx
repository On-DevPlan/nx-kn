// obsidian 视图：vault 与规范文档位置的管理页。
//
// 形态照 settings 视图（表单 → mutation → 持久化 + dirty 判断），
// 但有两处刻意不同：
// 1. POST 发的是**裸键**（vault / specDir / contentDoc / questionnaireDoc），
//    不是 CLI 的 pairs —— index.js 的 patchOf 两侧都认，settings 那边只认 pairs
//    导致面板保存静默无效，这个坑不复制。
// 2. 表单下方多一张「解析结果」卡片：把「配的」与「实际解析到的」并排显示，
//    存在性一眼可见 —— 规范文档路径配错是这类配置最常见的失败方式。
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useToast } from '../../web/frontend/components/ui.jsx';

// 表单控件声明：新增配置键 = 加一行声明，不必新写控件逻辑。
const FORM = [
  { key: 'vault', label: 'vault 绝对路径', placeholder: 'D:\\code\\a_md\\obsidian_init' },
  { key: 'specDir', label: '规范目录（vault 内相对路径）', placeholder: 'nx-kn' },
  { key: 'contentDoc', label: '内容规范文档名', placeholder: 'base-content.md' },
  { key: 'questionnaireDoc', label: '问卷规范文档名', placeholder: 'questionnaire.md' },
];

function Mark({ ok, missingText }) {
  return <span style={{ color: ok ? 'var(--ok, #2a7)' : 'var(--bad, #c33)' }}>{ok ? '✓ 存在' : `✗ ${missingText}`}</span>;
}

export default function ObsidianView() {
  const toast = useToast();
  const [draft, setDraft] = useState({});
  const [saved, setSaved] = useState({});
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/api/obsidian')
      .then((r) => {
        setSaved(r.config || {});
        setDraft(r.config || {});
        setSt(r);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  if (err) return <div className="empty bad">接口调用失败：{err}</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    try {
      const r = await api('/api/obsidian', { method: 'POST', body: { ...draft } });
      setSaved(r.config || {});
      setDraft(r.config || {});
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
        {FORM.map((f) => (
          <div key={f.key} className="opt-row" style={{ padding: '0 12px' }}>
            <label className="opt-label" htmlFor={`obs-${f.key}`}>
              {f.label}
            </label>
            <input
              id={`obs-${f.key}`}
              type="text"
              placeholder={f.placeholder}
              value={draft[f.key] || ''}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </div>
        ))}
        <div className="opt-actions">
          <button className="btn" disabled={!dirty} onClick={save}>
            {dirty ? '保存' : '无改动'}
          </button>
        </div>
        <CliHints id="obsidian.set" note="CLI 写同一份数据（vault=/specDir=/contentDoc=/questionnaireDoc=）" />
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
            <div>
              规范目录：{st.specDir} <Mark ok={st.specDirExists} missingText="不存在" />
            </div>
            {(st.docs || []).map((d) => (
              <div key={d.key}>
                {d.key}：{d.path} <Mark ok={d.exists} missingText="缺失" />
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
        <CliHints id="obsidian.spec" note="skill 运行时用它找规范文档（content / questionnaire）" />
      </div>
    </div>
  );
}
