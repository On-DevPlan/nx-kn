// 设置视图：通用偏好（主题 / 语言）+ 流水线子页。
//
// 子页是**刻意惰性**的：流水线要拉 crawl 列表与 kb 状态（后者要探 zg、逐库读
// 索引统计），是面板里最贵的一手数据——只有真的点开「流水线」才发起请求。
// 首页、知识库检索页与设置页的冷启动都不碰它（完全冷启动：不查看，不加载）。
//
// 「流水线」子页是**唯一的采集/索引管理入口**：
//   - CrawlView：采集源的管理（添加 / 抓取 / 移除）；
//   - KbManage：知识库管理（状态 / 库列表 / 增删 / 更新与重建索引 / 守护）+ 一键流水线。
// 两个组件都用 lazy(() => import(...)) 挂载——沿用 kb→crawl 时代的嵌入先例
// （动态 import 不经静态依赖，模块互依禁令与打包都安全）。
// 默认停在「通用」；切到「流水线」才挂载、才发请求；切走即卸载。
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Spinner, useToast } from '../../web/frontend/components/ui.jsx';

const CrawlView = lazy(() => import('../crawl/view.jsx'));
const KbManage = lazy(() => import('../kb/manage.jsx'));

// 示例键的控件声明：视图层自己的小事，不必进 schema。
const FORM = [
  { key: 'theme', label: '主题', type: 'select', options: ['', 'light', 'dark'] },
  { key: 'lang', label: '语言', type: 'text' },
];

function GeneralSettings() {
  const toast = useToast();
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
    <div className="card">
      <div className="colhead">通用</div>
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
      <CliHints id="settings.set" note="CLI 写同一份数据" />
      <CliHints id="settings.get" note="CLI 读同一份数据" />
    </div>
  );
}

function PipelineSettings() {
  return (
    <div className="stack">
      {/* 知识库管理（状态 / 库列表 / 增删 / 更新与重建索引 / 守护 / 一键流水线） */}
      <Suspense fallback={<div style={{ padding: 24 }}><Spinner label="加载知识库管理…" /></div>}>
        <KbManage />
      </Suspense>

      {/* 采集源管理（添加 / 抓取 / 移除）。抓完会广播 kb-changed，上面的管理卡即时刷新 */}
      <Suspense fallback={<div style={{ padding: 24 }}><Spinner label="加载采集面板…" /></div>}>
        <CrawlView />
      </Suspense>
    </div>
  );
}

export default function SettingsView() {
  const [tab, setTab] = useState('general'); // 冷启动只挂「通用」；「流水线」点开才挂载
  return (
    <div className="stack">
      <div className="toolbar">
        <button
          className={tab === 'general' ? 'btn' : 'btn ghost'}
          onClick={() => setTab('general')}
        >
          通用
        </button>
        <button
          className={tab === 'pipeline' ? 'btn' : 'btn ghost'}
          onClick={() => setTab('pipeline')}
        >
          流水线（采集源 · 索引 · 守护）
        </button>
      </div>
      {tab === 'general' ? <GeneralSettings /> : <PipelineSettings />}
    </div>
  );
}
