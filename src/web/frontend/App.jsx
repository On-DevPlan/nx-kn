// 面板壳：tab 导航 + 当前视图。**这个文件几乎不需要改**——
// 新增面板 = 在 registry.js 登记一行 + 写一个 view.jsx。
import { Suspense, useEffect, useRef } from 'react';
import { VIEWS } from './registry.js';
import { useStore } from './store.jsx';
import { ErrorBoundary, Spinner } from './components/ui.jsx';

function viewFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || '';
}

export default function App() {
  const { ui, patchUi, boot, refreshBoot } = useStore();
  // 只有 tab: false 之外的视图才出现在导航与 hash 路由里；
  // 嵌入视图（如 crawl）由宿主视图（kb）整块渲染，不单独可达。
  const views = VIEWS.filter((v) => v.tab !== false);

  // 窗口聚焦时刷新 bootstrap：别的终端改了状态，这里能看到。
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshBoot().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshBoot]);

  // 启动时把 hash 同步进 store；后续切换时也回写 hash（可分享、可后退）
  //
  // ⚠️ 两个 effect 是**有先后约定**的，别把它们看成各自独立：
  // 下面这个（[] 只跑一次）负责「深链优先」，紧接着那个（[ui.view]）负责「回写」。
  // 历史 bug：两者在首帧同时开火——回写那个拿的是**尚未被深链改写**的 ui.view，
  // 于是 `location.hash = '#/' + 旧view` 把刚打开的深链覆盖掉，还顺带触发
  // hashchange 把 view 又改回去。症状是「深链永远失效」+「地址栏闪一下首页」——
  // 即便清空 localStorage，#/kb 也会被拽回 #/home。
  // 修法：回写那个 effect 在**第一次运行时只认领、不写**，把首帧让给深链。
  const hydrating = useRef(true);
  useEffect(() => {
    const id = viewFromHash();
    // 只认注册过的独立 tab：`#/crawl`（嵌入视图）或任何垃圾 hash 都回落到持久化的 view
    const valid = VIEWS.some((v) => v.tab !== false && v.id === id);
    if (valid) patchUi({ view: id });
    else if (!location.hash && ui.view) location.hash = '#/' + ui.view;
  }, []);

  useEffect(() => {
    if (hydrating.current) {
      hydrating.current = false; // 启动那一帧不抢：深链说了算
      return;
    }
    if (ui.view) location.hash = '#/' + ui.view;
  }, [ui.view]);

  useEffect(() => {
    const onHash = () => {
      const id = viewFromHash();
      // 只认注册过的独立 tab：手改地址栏写了个垃圾 hash 时，让它渲染回落即可，
      // 别把垃圾值写进持久化的 ui.view（下一次刷新会「记住」它）。
      if (VIEWS.some((v) => v.tab !== false && v.id === id)) patchUi({ view: id });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [patchUi]);

  const current = views.find((v) => v.id === ui.view) || views[0];
  const appName = boot?.app?.name || 'nx-kn';

  return (
    <>
      <header>
        <div className="brand">
          <img src="/logo-rounded.png" alt="" />
          {appName}
          <span className="sub">Obsidian 知识库检索（zg 引擎）</span>
        </div>
        {/* 导航与品牌同排（原先它在 header 下面单独一行）：一行头部省掉约 35px，
            而 tab 只有三个。CSS 见 layout.css 的 header / .tabbar。 */}
        {views.length > 0 && (
          <div className="tabbar">
            <nav>
              {views.map((v) => (
                <button
                  key={v.id}
                  className={'tab' + (current && current.id === v.id ? ' active' : '')}
                  onClick={() => patchUi({ view: v.id })}
                >
                  {v.title}
                </button>
              ))}
            </nav>
          </div>
        )}
        <div className="meta">{boot ? `v${boot.app.version}` : ''}</div>
      </header>
      <main>
        {!current ? (
          <div className="empty">
            <p>
              还没有注册任何视图。在 <code>src/modules/&lt;域&gt;/view.jsx</code> 写一个，
              再在 <code>src/web/frontend/registry.js</code> 登记一行。
            </p>
            <p>
              CLI 已就绪：<code>{appName} help</code> / <code>{appName} routes</code>。
            </p>
          </div>
        ) : (
          <ErrorBoundary key={current.id}>
            <Suspense fallback={<div style={{ padding: 24 }}><Spinner label="加载中…" /></div>}>
              <section className="panel active">
                <current.component />
              </section>
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}
