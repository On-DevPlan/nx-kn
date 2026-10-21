// 视图注册表：新增面板 = 在模块里写 view.jsx + 在这里登记一行。
// App 的 tab 导航、hash 路由、懒加载全部由这张表驱动，改面板不用动壳。
//
// 与后端 src/runtime/registry.js 的模块表一一对应；
// tests/unit/registry.test.mjs 会断言两侧对齐——漏登记（或登记了不存在的视图）都会直接测试失败。
//
// tab: false = 嵌入视图：模块有完整 view.jsx（测试要求登记），但不占独立 tab，
// 而是整块嵌进宿主视图（见 kb/view.jsx）。采集是知识库的**上游阶段**，不是并列功能——
// 抓取 → 索引 → 检索是一条流水线，放同一个 tab 里用户才能看见「前后关系」。
import { lazy } from 'react';

export const VIEWS = [
  { id: 'home', title: '首页', component: lazy(() => import('../../modules/home/view.jsx')) },
  { id: 'settings', title: '设置', component: lazy(() => import('../../modules/settings/view.jsx')) },
  { id: 'kb', title: '知识库', component: lazy(() => import('../../modules/kb/view.jsx')) },
  { id: 'crawl', title: '资料采集', tab: false, component: lazy(() => import('../../modules/crawl/view.jsx')) },
];
