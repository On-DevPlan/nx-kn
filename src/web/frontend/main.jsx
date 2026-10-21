// 面板入口：Provider 组装（store → toast → dialog → App）。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { StoreProvider } from './store.jsx';
import { ToastProvider } from './components/ui.jsx';
// tokens.css 来自 tokens@<主题>/，生成时按 tokens 选项四选一落到这里，
// 必须先于 style.css——atomic/layout 层只消费 var()，不定义它。
// 在本仓库里它并不存在（只有 variant 目录里有），所以编辑器会标红——那是生成器的变体机制，不是缺文件。
import './tokens.css';
import './style.css';
// style/*.css 十件来自 style@<风格>/style/，生成时按 style 选项落到 style/ 目录——
// 每个文件是一个组件家族的策略，换风格 = 换这一层。
// 在本仓库里它们并不存在（只有 variant 目录里有），标红是变体机制的特性，不是缺文件。
import './style/btn.css';
import './style/tag.css';
import './style/card.css';
import './style/colhead.css';
import './style/row.css';
import './style/kv.css';
import './style/toast.css';
import './style/snippet-box.css';
import './style/cli-hint.css';
import './style/dlg.css';
// layout.css 来自 layout@<布局>/，生成时二选一。永远最后 import——版式壳压住组件策略。
import './layout.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StoreProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StoreProvider>
  </StrictMode>
);
