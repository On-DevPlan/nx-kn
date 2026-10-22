// 首页视图：项目信息 + 命令表。**完全冷启动**。
//
// 原先这里还挂着「流水线总览」（拉 crawl 列表 + kb 状态——后者要探 zg、逐库读
// 索引统计），首页成了面板里最慢的一页。现已整体移入「设置 → 流水线」子页，
// 且子页点开才加载（不查看，不加载）——首页只剩 bootstrap（启动时已拉）与
// /api/routes（内存里的命令表）两个轻请求。
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import { Spinner } from '../../web/frontend/components/ui.jsx';

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
          {routes ? <span className="tag">{routes.count} 条</span> : <Spinner />}
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
        <CliHints id="home.routes" note="这两张表由同一份 action 声明派生" />
      </div>
    </div>
  );
}
