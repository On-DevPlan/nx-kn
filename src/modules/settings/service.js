// settings 域：骨架自带的「写路径」示例——home 只示范了怎么读，
// 这里示范一条带状态的 action 全链路：面板表单 → HTTP → service → 持久化 → CLI 同源可读。
//
// 存储直接用 core/store.js 的 mutateStore 事务；settings 就是 store.json 里的
// 顶层 settings 键（见 store.js 的 initialState），不另起文件。
import { badInput } from '../../core/errors/index.js';
import { mutateStore, loadStore } from '../../core/store.js';

// 白名单声明：生成项目按需改。故意留两个常见示例键，让首次读写有东西可试。
export const SETTING_KEYS = ['lang', 'theme'];

export async function get() {
  const store = await loadStore();
  return { status: 'ok', settings: store.settings || {} };
}

// upsert：白名单内的键更新，白名单外的键拒绝。
// 骨架无从知道你项目的合法键集，所以业务上必须显式声明——
// 宁可报错让人加一行白名单，也不要静默接受任意键污染 store.json。
export async function set({ patch = {} } = {}) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return { status: 'ok', skipped: true, settings: (await loadStore()).settings };

  const unknown = keys.filter((k) => !SETTING_KEYS.includes(k));
  if (unknown.length) {
    throw badInput(`未知的设置键: ${unknown.join(', ')}（允许: ${SETTING_KEYS.join(', ')}）`);
  }

  const settings = await mutateStore((store) => {
    store.settings = { ...store.settings, ...patch };
    return store.settings;
  });
  return { status: 'ok', settings };
}
