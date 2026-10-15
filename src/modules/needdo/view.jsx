// needdo 视图：混乱输入收件箱面板。
//
// UIUX 铁律来自 docs/needdo/research-round1.md（Drafts/flomo/Raycast/Things 的
// 共性 + 本仓 paper 设计语言）：
//   1. 单框多类型：一个大输入框混收文字与链接，类型由系统识别（整行 URL → 链接），
//      不让用户先选类型——捕获优先，路由其次
//   2. 整个面板都是拖放区，拖入 PDF/DOCX 即入库；「选择文件」按钮做兜底
//   3. 列表与 crawl 视图同构（.row + .tag + Copyable），零图标体系
//   4. 归档而非删除：条目二态 inbox | done，默认只看收件箱
//   5. 键盘链路全通：进 tab 即聚焦、焦点在外时 Ctrl+V 也进输入框、Esc 清空、
//      提交后焦点不丢
// round2 增补：条目详情 Modal（全文 + 夹链接可点 + 原件下载）、混排文字的
// 「含链接」徽标、busy 守卫改 ref（修焦点在外粘贴的竞态）、checkbox 多选批量
// （选中非空时卡头切换为「已选 N · 归档/还原 · 整理 · 删除」，Gmail/Linear 惯例）。
// round3 增补：AI 建议一律以「建议」形态呈现（行内徽标 + 详情里的 AI 附注块 +
// 接受/拒绝按钮），绝不静默应用到主视图；整理级别在弹窗里显式可选（0 = 不调 AI）；
// 卡头露出 AI 队列与简报命令。
// round4 增补：检索框（一个词就是全文入口，命中用 <Highlight> 标黄）、编辑入口
// （只提交真正改动过的字段——无脑整份提交会让「只想改主题」也把正文算成改过）、
// 回收站（删除是软删除；Modal 里逐条/全部恢复、清空）。过滤与检索词进 localStorage
// 而不进 URL：App.jsx 的 hash 只承载 view。
// round5 增补：卡头的「待 AI / AI 建议」徽标可点，直接当过滤器用（徽标即入口）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { Copyable, Highlight, Modal, Spinner, useDialog, useToast } from '../../web/frontend/components/ui.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import { looksLikeLink } from './classify.js';

// 与 core/paths.js 的 NEEDDO_FILE_MAX_BYTES 同口径（HTTP body 4MB 上限的 base64 换算）。
// 前端先卡一道，错误在拖进去的那一刻就给出，而不是等请求回来。
const FILE_MAX = 3 * 1024 * 1024;
const FILE_EXTS = ['pdf', 'docx', 'txt', 'md'];

const KIND_LABEL = { text: '文字', link: '链接' };
function kindLabel(it) {
  return it.kind === 'file' ? (it.ext || '文件').toUpperCase() : KIND_LABEL[it.kind] || it.kind;
}

// AI 附注的四态（round3 协议）：pending 是排队等 agent，suggested 才是等**人**拍板。
const AI_STATUS = { pending: '待 agent 复核', suggested: '待你复核', accepted: '已采纳', rejected: '已拒绝' };

function fmtTime(iso) {
  if (!iso) return '';
  const s = String(iso).replace('T', ' ');
  return s.slice(5, 16); // MM-DD HH:mm —— 收件箱条目只关心「什么时候丢进来的」
}

// Arraybuffer → base64（分块拼接，避免 String.fromCharCode 一次吃下几 MB 参数爆栈）。
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// base64 → Blob 下载（「下载原件」）。与 service 的 base64 过境互为逆操作。
function downloadBase64(name, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'needdo-file';
  a.click();
  URL.revokeObjectURL(url);
}

export default function NeedDoView() {
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  // 过滤与检索词进 localStorage（store.jsx 的硬标准：刷新后不该丢的用户选择都要持久化）。
  // 刻意**不进 URL**：App.jsx 的 hash 只承载 view，且那段 hash 同步有个未复现的跳转 bug。
  const { ui, patchUi } = useStore();
  const filter = ui.needdo?.filter || 'inbox'; // inbox | done | all —— 默认只看收件箱（铁律 4）
  const q = ui.needdo?.q || '';
  const setFilter = (f) => patchUi({ needdo: { filter: f, q } });
  const setQ = (v) => patchUi({ needdo: { filter, q: v } });

  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const [detail, setDetail] = useState(null); // { item, text } —— 详情 Modal 的内容
  const [trash, setTrash] = useState(null); // 回收站弹层的内容（null = 关着）
  const [sel, setSel] = useState(() => new Set()); // 选中条目 id —— 非空时卡头切换批量条
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);
  // busy 的守卫用 ref 而不是 state：paste 监听是一次性注册的（闭包持有首帧函数），
  // 读 state 会拿到旧值；ref 永远是当前值。setBusy 只管按钮的禁用渲染。
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSt(await api('/api/needdo/list'));
    } catch (e) {
      toast(String(e.message || e));
    }
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  // 面板自刷新：收件箱的写入口不止这个面板——CLI / agent 在别的终端往里丢东西是
  // 常规用法。而本仓不给 kb 那套轮询（起子进程的代价），所以用「回到这个窗口就
  // 重取一次」的轻办法：可见性变化 + 窗口聚焦各触发一次，没有定时器零常驻开销。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  async function withBusy(fn) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // 铁律 5：焦点不在输入框时，粘贴（文字或文件）也直接进收件箱的输入路径。
  useEffect(() => {
    const onPaste = (e) => {
      const ta = inputRef.current;
      if (!ta || document.activeElement === ta) return;
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
      const s = e.clipboardData?.getData('text');
      if (s) {
        e.preventDefault();
        setText((cur) => (cur ? cur + '\n' + s : s));
        ta.focus();
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  // 首次使用的引导：往输入框里填一条**示例**（而不是往 store 里塞演示数据——
  // 那是往用户的收件箱里拉屎）。填完光标落在末尾，回车即收，一次就学会。
  function fillSample() {
    setText('明天下午3点开会 记得带Q4预算\n参考资料 https://example.com/q4-plan');
    inputRef.current?.focus();
  }

  async function submit() {
    const v = text.trim();
    if (!v || busyRef.current) return;
    // 铁律 1：类型系统识别——**整行**就是一个 URL 才算链接条目（判据在 classify.js，
    // 有单测）。混排文字走文字路径：后端把里面的 URL 抽进 links，原文一字不动。
    const isLink = looksLikeLink(v);
    await withBusy(async () => {
      await api('/api/needdo/add', {
        method: 'POST',
        body: isLink ? { link: v } : { text: v },
      });
      setText('');
      await refresh();
      inputRef.current?.focus(); // 提交后焦点归位，连续收集不打断
    });
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    await withBusy(async () => {
      let ok = 0;
      for (const f of files) {
        const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
        if (!FILE_EXTS.includes(ext)) {
          toast(`跳过 ${f.name}：目前收 ${FILE_EXTS.join(' / ')}`);
          continue;
        }
        if (f.size > FILE_MAX) {
          toast(`跳过 ${f.name}：超过 3MB 上限`);
          continue;
        }
        try {
          await api('/api/needdo/add', {
            method: 'POST',
            body: { data: toBase64(await f.arrayBuffer()), name: f.name },
          });
          ok++;
        } catch (e) {
          toast(`${f.name}：${e.message || e}`);
        }
      }
      if (ok) toast(`已收进 ${ok} 个文件`);
      await refresh();
    });
  }

  async function processInbox() {
    // 级别用下拉而不是固定 0：面板必须能表达「这次要不要让 AI 参与」——
    // 但它只负责**排队**（AI 干活的是外部 agent，走 CLI 的 brief/apply）。
    // 0 保持默认且语义清楚：离线、可复现、不调任何模型。
    const r = await dialog({
      title: '按主题整理',
      message:
        '先把收件箱按规则表归类并归档（待办事项 / 公告通知 / 文档资料 / 链接收藏 / 杂项收集），并写一份 markdown 报告。\n' +
        '级别 ≥1 会把条目**排进 AI 复核队列**：之后用 CLI 跑 nx-kn needdo brief 把简报交给 agent，' +
        '它给出的建议会先落成「待你复核」，你接受后才生效。',
      fields: [
        {
          key: 'level',
          label: 'AI 增强级别',
          options: [
            { value: '0', label: '0 · 纯规则（不调 AI，离线可跑）' },
            { value: '1', label: '1 · 排队等 AI 复核主题' },
            { value: '2', label: '2 · 再加一句话摘要' },
            { value: '3', label: '3 · 再加标签' },
          ],
          value: '0',
        },
        { key: 'agent', label: 'agent 名（级别 ≥1 时记录在案，可留空）', placeholder: 'claude', value: '' },
      ],
      okText: '开始整理',
    });
    if (!r) return;
    const level = Number(r.level) || 0;
    await withBusy(async () => {
      try {
        const out = await api('/api/needdo/process', {
          method: 'POST',
          body: { 'enhance-level': level, agent: r.agent || undefined },
        });
        toast(
          out.processed
            ? `已整理 ${out.processed} 条：${out.byTopic.map((x) => `${x.topic} ${x.count}`).join(' / ')}`
            : '收件箱已是空的'
        );
        if (out.pendingAi) {
          toast(`已排队等 AI 复核 ${out.pendingAi} 条 —— 见上方提示导出简报`);
        }
        await refresh();
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  async function archiveItem(it, undo) {
    await withBusy(async () => {
      await api('/api/needdo/archive', { method: 'POST', body: { id: it.id, undo } });
      await refresh();
    });
  }

  async function removeItem(it) {
    const ok = await dialog({
      title: '移到回收站',
      message:
        `把 [${it.title}] 移出收件箱？\n` +
        '条目与原件会进回收站（不再出现在列表里），**30 天内可以恢复**；清空回收站才真删。',
      okText: '移到回收站',
      danger: true,
    });
    if (!ok) return;
    await withBusy(async () => {
      await api('/api/needdo/remove', { method: 'POST', body: { id: it.id } });
      toast('已移入回收站');
      await refresh();
    });
  }

  // 回收站：列 + 恢复 + 清空。与 CLI 的 needdo trash 是同一 action 的三个方向。
  async function openTrash() {
    await withBusy(async () => {
      try {
        const r = await api('/api/needdo/trash', { method: 'POST', body: {} });
        setTrash(r);
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  async function restoreItem(it) {
    await withBusy(async () => {
      try {
        await api('/api/needdo/trash', { method: 'POST', body: { ids: [it.id], restore: true } });
        toast('已恢复');
        await refresh();
        setTrash(await api('/api/needdo/trash', { method: 'POST', body: {} }));
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  async function emptyTrash() {
    const ok = await dialog({
      title: '清空回收站',
      message: `彻底删除回收站里的 ${trash?.count || 0} 条？\n条目、原件与提取文本都会被真正删除，**不可恢复**。`,
      okText: '清空',
      danger: true,
    });
    if (!ok) return;
    await withBusy(async () => {
      try {
        const r = await api('/api/needdo/trash', { method: 'POST', body: { empty: true } });
        toast(`已清空回收站（${r.emptied} 条）`);
        setTrash(null);
        await refresh();
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  // 全部恢复：误删的常见形态是「一次删多了」，逐条点恢复不如一次捞回来。
  async function restoreAll() {
    const ids = (trash?.items || []).map((x) => x.id);
    if (!ids.length) return;
    await withBusy(async () => {
      try {
        const r = await api('/api/needdo/trash', { method: 'POST', body: { ids, restore: true } });
        toast(`已恢复 ${r.restored} 条`);
        setTrash(null);
        await refresh();
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  function toggleSel(id, on) {
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  // 批量动作共用一个出口：做完清空选择（条目已经不在当前视野里了）。
  const clearSel = () => setSel(new Set());

  // 全选：只选**当前视野里**的条目（过滤后的），不是全库——「全选」在收件箱过滤下
  // 就该是「全选待整理的」，把已归档的也悄悄选上会让人在批量删除时踩雷。
  const visibleIds = () => items.map((x) => x.id);
  const selectAll = () => setSel(new Set(visibleIds()));

  async function batchArchive() {
    await withBusy(async () => {
      await api('/api/needdo/archive', { method: 'POST', body: { ids: [...sel], undo: filter === 'done' } });
      clearSel();
      await refresh();
    });
  }

  async function batchProcess() {
    await withBusy(async () => {
      const r = await api('/api/needdo/process', { method: 'POST', body: { ids: [...sel] } });
      toast(r.processed ? `已整理 ${r.processed} 条：${r.byTopic.map((x) => `${x.topic} ${x.count}`).join(' / ')}` : '选中条目里没有待整理的');
      clearSel();
      await refresh();
    });
  }

  // 批量复核 AI 建议：选中里的 suggested 条目一次性接受/拒绝（其余的会被服务端跳过）
  async function batchReview(reject) {
    await withBusy(async () => {
      try {
        const r = await api('/api/needdo/review', { method: 'POST', body: { ids: [...sel], reject } });
        toast(reject ? `已拒绝 ${r.rejected} 条 AI 建议` : `已接受 ${r.accepted} 条 AI 建议`);
        clearSel();
        await refresh();
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  async function batchDelete() {
    const ok = await dialog({
      title: '批量移到回收站',
      message:
        `把选中的 ${sel.size} 条移出收件箱？\n条目与原件会进回收站（30 天内可恢复）；清空回收站才真删。`,
      okText: '移到回收站',
      danger: true,
    });
    if (!ok) return;
    await withBusy(async () => {
      const r = await api('/api/needdo/remove', { method: 'POST', body: { ids: [...sel] } });
      toast(`已移入回收站 ${r.removed} 条${r.missing && r.missing.length ? `（跳过 ${r.missing.length} 条已不存在的）` : ''}`);
      clearSel();
      await refresh();
    });
  }

  // 编辑：只发**真正改动过**的字段。弹窗会把当前值预填，若无脑整份提交，
  // 「只想改主题」也会算成改了正文——那会让 editedAt 被写上、旧 AI 建议被误作废。
  async function editItem(it) {
    const topicOptions = [...new Set([...(it.topic ? [it.topic] : []), ...(st?.topics || [])])];
    const fields = [
      { key: 'title', label: '标题', value: it.title },
      {
        key: 'topic',
        label: '主题（在这里选的值会记成「你定的」，规则表与 AI 之后都不覆盖）',
        options: ['(不改)', ...topicOptions],
        value: it.topic || '(不改)',
      },
    ];
    if (it.kind !== 'file') {
      fields.push({
        key: 'body',
        label: it.kind === 'link' ? '网址（须 http(s) 开头）' : '正文',
        value: it.content,
      });
    }
    const r = await dialog({
      title: `改条目 · ${it.title.slice(0, 40)}`,
      message:
        '改一条不等于重新收一条：入库时间与归档状态都保持。\n' +
        (it.kind === 'file' ? '文件条目的正文是提取出来的（原件在数据目录里），这里只能改标题与主题。' : ''),
      fields,
      okText: '保存',
    });
    if (!r) return;

    const patch = {};
    if (r.title !== it.title) patch.title = r.title;
    if (r.topic !== '(不改)' && r.topic !== (it.topic || '')) patch.topic = r.topic;
    if (it.kind !== 'file' && r.body !== it.content) patch.body = r.body;
    if (!Object.keys(patch).length) {
      toast('没有改动');
      return;
    }
    await withBusy(async () => {
      try {
        await api('/api/needdo/edit', { method: 'POST', body: { id: it.id, ...patch } });
        toast('已保存');
        await refresh();
        if (detail && detail.item.id === it.id) {
          setDetail(await api('/api/needdo/show?id=' + encodeURIComponent(it.id)));
        }
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  // 沉淀：导出成 markdown 目录并登记为知识库（同一 action 的 CLI 是 needdo export）。
  // 与 crawl 的产品同构——产物是普通 md 目录，索引仍由用户显式跑（不藏在副作用里）。
  async function exportItems() {
    await withBusy(async () => {
      try {
        const r = await api('/api/needdo/export', { method: 'POST', body: {} });
        const written = r.exported + r.updated;
        toast(
          written
            ? `已沉淀 ${written} 条（新增 ${r.exported} / 更新 ${r.updated}）→ ${r.dir}`
            : r.unchanged
              ? `没有要重写的（${r.unchanged} 条已是最新）`
              : '没有可沉淀的条目（先把收件箱按主题整理归档）'
        );
        await refresh();
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  // 详情：一条命令拿全上下文（show 的契约——文字给全文、文档给提取文本）。
  async function openDetail(it) {
    await withBusy(async () => {
      try {
        setDetail(await api('/api/needdo/show?id=' + encodeURIComponent(it.id)));
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  async function downloadOriginal(it) {
    try {
      const r = await api('/api/needdo/file?id=' + encodeURIComponent(it.id));
      downloadBase64(r.name, r.data);
    } catch (e) {
      toast(String(e.message || e));
    }
  }

  // 复核 AI 建议：接受 = 主题按建议更新并记来源；拒绝 = 只清状态。
  // 建议永远是「建议」——不静默应用（改了主视图结构的事必须有人拍板）。
  async function reviewItem(it, reject) {
    await withBusy(async () => {
      try {
        await api('/api/needdo/review', { method: 'POST', body: { id: it.id, reject } });
        toast(reject ? '已拒绝这条 AI 建议' : '已接受这条 AI 建议');
        await refresh();
        // 详情开着的话同步刷新，否则关掉弹层回列表看新状态
        if (detail && detail.item.id === it.id) {
          setDetail(await api('/api/needdo/show?id=' + encodeURIComponent(it.id)));
        }
      } catch (e) {
        toast(String(e.message || e));
      }
    });
  }

  // 拖入计数而非布尔开关：拖经子元素会连发 dragleave，深度计数才能稳住激活态。
  const onDragEnter = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDrag(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDrag(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) uploadFiles(files);
  };

  const items = useMemo(() => {
    if (!st) return [];
    const needle = q.trim().toLowerCase();
    return st.items
      .filter((x) => {
        if (filter === 'all') return true;
        if (filter === 'ai-pending') return x.ai && x.ai.status === 'pending';
        if (filter === 'ai-suggested') return x.ai && x.ai.status === 'suggested';
        return x.status === filter;
      })
      .filter(
        (x) =>
          !needle ||
          [x.title, x.excerpt, x.content, x.topic || '', ...(x.links || [])]
            .join('\n')
            .toLowerCase()
            .includes(needle)
      );
  }, [st, filter, q]);
  const selItems = items.filter((x) => sel.has(x.id));
  const anySuggestion = selItems.some((x) => x.ai && x.ai.status === 'suggested');
  const loading = st === null;
  const needle = q.trim();

  // AI 队列的可见性：条目标上的「待 AI」徽标只在列表里可见，卡头得能一眼看出
  // 「还有多少条等着 agent 过」。级别取队列里的最大值——那一级才是这次要跑的任务。
  const aiPending = st ? st.items.filter((x) => x.ai && x.ai.status === 'pending') : [];
  const aiSuggestedCount = st ? st.items.filter((x) => x.ai && x.ai.status === 'suggested').length : 0;
  const aiLevel = aiPending.length ? Math.max(...aiPending.map((x) => x.ai.level || 1)) : 1;
  const briefCmd = `nx-kn needdo brief --level ${aiLevel} --json > brief.json`;
  // 「可沉淀」= 已归档但还没导出过的条目数（导出过的已是最新，不必再数一遍）
  const exportable = st ? st.items.filter((x) => x.status === 'done' && !x.exportPath).length : 0;

  return (
    <div
      className="stack"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dialogNode}
      {trash && (
        <Modal title={`回收站（${trash.count} 条 · 30 天内可恢复）`} onClose={() => setTrash(null)}>
          <div className="needdo-detail">
            {!trash.count ? (
              <div className="empty">回收站是空的</div>
            ) : (
              trash.items.map((it) => (
                <div className="row wrap" key={it.id}>
                  <div className="name mono" title={it.title}>
                    [{kindLabel(it)}] {it.title}
                  </div>
                  <div className="acts">
                    <span className="muted">删于 {fmtTime(it.deletedAt)}</span>
                    <button className="btn small ghost" disabled={busy} onClick={() => restoreItem(it)}>
                      恢复
                    </button>
                  </div>
                </div>
              ))
            )}
            <div className="needdo-detail-acts">
              <button className="btn ghost" disabled={busy || !trash.count} onClick={restoreAll}>
                全部恢复
              </button>
              <button className="btn ghost" disabled={busy || !trash.count} onClick={emptyTrash}>
                清空回收站
              </button>
              <span className="muted needdo-tip">
                清空会把原件与提取文本一并真删；超 30 天或超 200 条也会自动淘汰
              </span>
            </div>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal title={detail.item.title || '(无标题)'} onClose={() => setDetail(null)}>
          <div className="needdo-detail">
            <div className="needdo-detail-meta">
              <span className="tag strong">{kindLabel(detail.item)}</span>
              {detail.item.topic ? <span className="tag strong">{detail.item.topic}</span> : <span className="tag">未整理</span>}
              {detail.item.topicSource === 'ai' ? <span className="tag">主题来自 AI</span> : null}
              <span className="tag">{detail.item.status === 'done' ? '已归档' : '收件箱'}</span>
              <span className="muted">{fmtTime(detail.item.addedAt)}</span>
            </div>
            {detail.item.exportPath ? (
              <div className="needdo-ai-line muted">
                已沉淀到知识库：
                <Copyable text={st?.exportDir ? `${st.exportDir}/${detail.item.exportPath}` : detail.item.exportPath}>
                  {st?.exportDir ? `${st.exportDir}/${detail.item.exportPath}` : detail.item.exportPath}
                </Copyable>
                {detail.item.exportedAt ? ` · ${new Date(detail.item.exportedAt).toLocaleString()}` : ''}
              </div>
            ) : null}
            {/* AI 附注：建议永远只在这里展示，接受之后才会写进 topic */}
            {detail.item.ai ? (
              <div className="needdo-ai">
                <div className="needdo-ai-head">
                  <span className="tag strong">
                    AI 建议{detail.item.ai.status === 'suggested' ? '（待复核）' : ''}
                  </span>
                  <span className="muted">
                    {detail.item.ai.agent || 'agent'} · 级别 {detail.item.ai.level}
                    {detail.item.ai.confidence != null ? ` · 置信 ${detail.item.ai.confidence}` : ''}
                    {` · ${AI_STATUS[detail.item.ai.status] || detail.item.ai.status}`}
                  </span>
                </div>
                {/* 溯源：这条建议是基于哪一版内容、什么时候、哪一批给的。
                    「建议过期」在协议里是个真实状态（rev 对不上），把 rev 摆出来，
                    它对得上对不上就都看得见了。 */}
                <div className="needdo-ai-line muted">
                  基于内容版本 {detail.item.ai.rev || '—'}
                  {detail.item.ai.at ? ` · ${new Date(detail.item.ai.at).toLocaleString()}` : ''}
                  {detail.item.ai.batchId ? ` · 批次 ${detail.item.ai.batchId}` : ''}
                </div>
                {detail.item.ai.topic ? (
                  <div className="needdo-ai-line">建议主题：<b>{detail.item.ai.topic}</b></div>
                ) : null}
                {detail.item.ai.summary ? <div className="needdo-ai-line">{detail.item.ai.summary}</div> : null}
                {!!(detail.item.ai.tags && detail.item.ai.tags.length) && (
                  <div className="needdo-ai-line">
                    {detail.item.ai.tags.map((t) => (
                      <span className="tag" key={t}>{t}</span>
                    ))}
                  </div>
                )}
                {detail.item.ai.status === 'suggested' && (
                  <div className="needdo-detail-acts">
                    <button className="btn small" disabled={busy} onClick={() => reviewItem(detail.item, false)}>
                      接受建议
                    </button>
                    <button className="btn small ghost" disabled={busy} onClick={() => reviewItem(detail.item, true)}>
                      拒绝
                    </button>
                  </div>
                )}
              </div>
            ) : null}
            {!!(detail.item.links && detail.item.links.length) && (
              <div className="needdo-detail-links">
                {detail.item.links.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>
                ))}
              </div>
            )}
            <pre className="needdo-text">
              {detail.text || detail.item.excerpt || '（没有可展示的文本——文件条目可下载原件查看）'}
            </pre>
            {detail.item.kind === 'file' && (
              <div className="needdo-detail-acts">
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => downloadOriginal(detail.item)}
                >
                  下载原件
                </button>
                <span className="muted needdo-tip">
                  {detail.item.textFile ? '展示的是提取文本；原件在数据目录 needdo/ 下' : '没能提取文本，请下载原件查看'}
                </span>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* 捕获卡：单框多类型（铁律 1）+ 拖放激活态（铁律 2） */}
      <div className={'card needdo-capture' + (drag ? ' drop' : '')}>
        <div className="colhead">
          <span>NeedDo 收件箱</span>
          <div className="acts">
            {loading ? (
              <Spinner />
            ) : (
              <>
                <button
                  className={'tag' + (filter === 'inbox' ? ' strong' : '')}
                  title="只看收件箱"
                  onClick={() => setFilter(filter === 'inbox' ? 'all' : 'inbox')}
                >
                  {st.inbox} 条待整理
                </button>
                {aiPending.length ? (
                  <button
                    className={'tag' + (filter === 'ai-pending' ? ' strong' : '')}
                    title="只看排队等 AI 复核的条目"
                    onClick={() => setFilter(filter === 'ai-pending' ? 'all' : 'ai-pending')}
                  >
                    待 AI {aiPending.length}
                  </button>
                ) : null}
                {aiSuggestedCount ? (
                  <button
                    className={'tag' + (filter === 'ai-suggested' ? ' strong' : '')}
                    title="只看有待复核 AI 建议的条目"
                    onClick={() => setFilter(filter === 'ai-suggested' ? 'all' : 'ai-suggested')}
                  >
                    AI 建议 {aiSuggestedCount}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="needdo-body">
          <textarea
            ref={inputRef}
            className="needdo-input"
            autoFocus
            spellCheck="false"
            value={text}
            placeholder="随手收：一句话、公告、链接（整行 URL 自动识别为链接）——或者把 PDF / DOCX / TXT / MD 拖到页面任意处"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                setText('');
              }
            }}
          />
          <div className="opt-actions">
            <button className="btn" disabled={busy || !text.trim()} onClick={submit}>
              收进收件箱
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
              选择文件…
            </button>
            <button className="btn ghost" disabled={busy || !st?.inbox} onClick={processInbox}>
              {busy ? '处理中…' : '按主题整理'}
            </button>
            <span className="needdo-tip muted">Enter 收进 · Shift+Enter 换行 · Esc 清空 · 文件可整屏拖入</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={FILE_EXTS.map((x) => '.' + x).join(',')}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              uploadFiles(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          {/* AI 队列的出口提示：排了队但没人知道下一步怎么走，队列就等于积压 */}
          {aiPending.length ? (
            <div className="needdo-queue muted">
              有 {aiPending.length} 条排队等 AI 复核 —— 导出简报交给 agent：
              <Copyable text={briefCmd}>{briefCmd}</Copyable>
            </div>
          ) : null}
        </div>
        <CliHints module="needdo" />
      </div>

      {/* 条目卡：与 crawl 视图同构的行式列表（铁律 3）。
          选中非空时卡头切换成批量条——过滤与批量不同时在场，视线只有一套操作。 */}
      <div className="card">
        <div className="colhead">
          <span>条目</span>
          <div className="acts">
            {sel.size ? (
              <>
                <span className="tag strong">已选 {sel.size}</span>
                <button
                  className="btn small ghost"
                  disabled={sel.size >= items.length}
                  onClick={selectAll}
                >
                  全选 {items.length}
                </button>
                <button className="btn small ghost" onClick={clearSel}>清除</button>
                <button className="btn small" disabled={busy} onClick={batchArchive}>
                  {filter === 'done' ? '还原' : '归档'}
                </button>
                {filter !== 'done' && (
                  <button className="btn small" disabled={busy} onClick={batchProcess}>
                    整理
                  </button>
                )}
                {anySuggestion && (
                  <>
                    <button className="btn small" disabled={busy} onClick={() => batchReview(false)}>
                      接受建议
                    </button>
                    <button className="btn small ghost" disabled={busy} onClick={() => batchReview(true)}>
                      拒绝建议
                    </button>
                  </>
                )}
                <button className="btn small ghost" disabled={busy} onClick={batchDelete}>
                  删除
                </button>
              </>
            ) : (
              <>
                <button
                  className={'btn small' + (filter === 'inbox' ? '' : ' ghost')}
                  onClick={() => setFilter('inbox')}
                >
                  收件箱 {st ? st.inbox : '…'}
                </button>
                <button
                  className={'btn small' + (filter === 'done' ? '' : ' ghost')}
                  onClick={() => setFilter('done')}
                >
                  已归档
                </button>
                <button
                  className={'btn small' + (filter === 'all' ? '' : ' ghost')}
                  onClick={() => setFilter('all')}
                >
                  全部 {st ? st.total : '…'}
                </button>
                <button
                  className="btn small ghost"
                  disabled={!items.length}
                  title="选中当前视野里的全部条目"
                  onClick={selectAll}
                >
                  全选
                </button>
                {st?.trash ? (
                  <button className="btn small ghost" onClick={openTrash} title="删除的条目在这里，可恢复">
                    回收站 {st.trash}
                  </button>
                ) : null}
                {exportable ? (
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    title="把已归档的条目导出成 markdown 目录，并登记为知识库（产物是普通 md，索引仍需显式跑 nx-kn index）"
                    onClick={exportItems}
                  >
                    沉淀到知识库{exportable ? ` ${exportable}` : ''}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* 检索行：一个输入框就是全文入口（标题/摘录/正文/主题/夹链接），
            匹配处用现成的 <Highlight> 标黄——与检索域同一个「为什么命中」的表达。 */}
        <div className="needdo-searchrow">
          <input
            className="needdo-search"
            type="search"
            spellCheck="false"
            placeholder="搜条目：标题 / 正文 / 主题 / 链接（文档全文用 CLI 的 needdo list --deep）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {filter === 'ai-pending' || filter === 'ai-suggested' ? (
            <button
              className="btn small ghost"
              title="清除 AI 筛选，回到列表过滤"
              onClick={() => setFilter('all')}
            >
              {filter === 'ai-pending' ? '只看：待 AI' : '只看：AI 建议'} ✕
            </button>
          ) : null}
          {needle ? (
            <>
              <span className="muted">匹配 {items.length} 条</span>
              <button className="btn small ghost" onClick={() => setQ('')}>
                清空
              </button>
            </>
          ) : null}
        </div>

        {!loading && !items.length && (
          <div className="empty">
            {needle ? (
              `没有匹配「${needle}」的条目`
            ) : filter === 'inbox' ? (
              <>
                收件箱是空的 —— 上面丢一句话进来，或拖个文档进来
                <div className="needdo-empty-acts">
                  <button className="btn small ghost" onClick={fillSample}>
                    填个示例试试
                  </button>
                  <span className="muted">
                    示例里夹了一个 URL——整行的才是链接条目，夹在文字里的会被抽出来附在条目上
                  </span>
                </div>
              </>
            ) : (
              '这个视图下没有条目'
            )}
          </div>
        )}

        {items.map((it) => {
          // 链接给 URL 可点；文字给摘录——摘录与标题同文时不再重复（短条目的标题
          // 就是全文）。都没有时只显示时间，不留孤零零的分隔点。
          const body =
            it.kind === 'link' ? (
              <Copyable text={it.content}>{it.content}</Copyable>
            ) : it.excerpt && it.excerpt !== it.title ? (
              it.excerpt
            ) : null;
          return (
            <div className="row wrap" key={it.id}>
              <input
                type="checkbox"
                className="needdo-check"
                title="选中以便批量操作"
                checked={sel.has(it.id)}
                onChange={(e) => toggleSel(it.id, e.target.checked)}
              />
              <div className="name mono" title={it.title}>
                [{kindLabel(it)}] <Highlight text={it.title} query={needle} />
              </div>
              <div className="acts">
                {!!(it.links && it.links.length) && <span className="tag">含链接 {it.links.length}</span>}
                {it.topic ? (
                  <span className="tag strong">{it.topic}</span>
                ) : (
                  <span className="tag">未整理</span>
                )}
                {it.topicSource === 'ai' ? <span className="tag">主题来自 AI</span> : null}
                {it.exportPath ? (
                  <span className="tag" title={`已沉淀: ${it.exportPath}`}>
                    已沉淀
                  </span>
                ) : null}
                {it.ai && it.ai.status === 'suggested' ? (
                  <span
                    className="tag strong"
                    title={`${it.ai.summary || '（无摘要）'}${it.ai.topic ? `\n建议主题 → ${it.ai.topic}` : '\n建议不改主题'}`}
                  >
                    AI 建议{it.ai.topic ? ` · ${it.ai.topic}` : ' · 不改主题'}
                  </span>
                ) : it.ai && it.ai.status === 'pending' ? (
                  <span className="tag" title="已排进 AI 复核队列（跑 needdo brief 导出简报）">待 AI</span>
                ) : null}
                {it.status === 'done' ? <span className="tag">已归档</span> : null}
                {it.kind === 'file' && !it.textFile ? <span className="tag">无文本</span> : null}
                <button className="btn small ghost" disabled={busy} onClick={() => openDetail(it)}>
                  查看
                </button>
                <button className="btn small ghost" disabled={busy} onClick={() => editItem(it)}>
                  改
                </button>
                <button
                  className="btn small ghost"
                  disabled={busy}
                  onClick={() => archiveItem(it, it.status === 'done')}
                >
                  {it.status === 'done' ? '还原' : '归档'}
                </button>
                <button className="btn small ghost" disabled={busy} onClick={() => removeItem(it)}>
                  删除
                </button>
              </div>
              <div className="desc">
                {typeof body === 'string' ? <Highlight text={body} query={needle} /> : body}
                <span className="muted">
                  {body ? ' · ' : ''}
                  {fmtTime(it.addedAt)}
                  {it.editedAt ? ' · 改过' : ''}
                  {it.topicSource === 'user' ? ' · 主题你定的' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
