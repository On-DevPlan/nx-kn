// obsidian 域：vault 定位与「内容规范文档」路径解析的唯一权威。
//
// 背景：kn-obsidian-repair-unresolved-links 的内容生成规范（内容四模式 / 问卷规范）
// 曾打包在 skill 的 references/ 里，用户改不了、只能改源码重装。现已迁进 vault
// （默认 <vault>/nx-kn/），skill 运行时跑 `nx-kn obsidian spec` 解析路径、去 vault 现读——
// 本模块就是那条解析链，也就是「skill 与内容要求解耦」的落点。
//
// 解析链（vault）：store.obsidian.vault > 环境变量 NX_OBSIDIAN_VAULT（skill 脚本同款）
//                 > 第一个含 .obsidian/ 的 kb 登记库 > 未设置。
//
// **兜底只在「未设置」时发生，不在「设了但坏了」时发生**：store 里明确指过的 vault
// 从磁盘上消失，必须如实报出来（vaultExists:false + hint）。静默换一个 vault
// 等于把配置错误藏起来——agent 会拿着错误的规范写一堆笔记，事后没人知道为什么。
//
// 错误契约（见 core/errors）：只有 set() 会抛（参数非法 / 目标不存在）；
// get() 与 spec() 未配置时返回**业务结果** {configured:false, hints:[...]}，不是错误——
// 调用方（skill / 面板）要能把它当正常状态渲染，而不是当成失败。
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { badInput, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  OBSIDIAN_VAULT_ENV,
  assertSafeRelPath,
  obsidianVaultFromEnv,
} from '../../core/paths.js';

// 写入口白名单。value 校验器在 set() 里逐键调用；空串 = 清除 / 复位到默认。
export const OBSIDIAN_KEYS = ['vault', 'specDir', 'contentDoc', 'questionnaireDoc'];

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- vault 解析链（get / spec 共用）----
async function resolveVault() {
  const store = await loadStore();
  const config = store.obsidian || {};
  if (config.vault) return { vault: resolve(config.vault), source: 'store', config };
  const fromEnv = obsidianVaultFromEnv();
  if (fromEnv) return { vault: resolve(fromEnv), source: 'env', config };
  for (const v of (store.kb && store.kb.vaults) || []) {
    if (!v || !v.path) continue;
    const p = resolve(String(v.path));
    if (existsSync(join(p, '.obsidian'))) return { vault: p, source: 'kb', config };
  }
  return { vault: null, source: null, config };
}

// ---- 全量解析：路径 + 存在性 + 可照做的 hints（永不抛）----
export async function resolvePaths() {
  const { vault, source, config } = await resolveVault();
  const out = { status: 'ok', configured: !!vault, source, vault, config: { ...config } };

  if (!vault) {
    out.hints = [
      `vault 未设置 —— 跑 ${APP_NAME} obsidian set vault=<vault绝对路径>`,
      `临时用可设环境变量 ${OBSIDIAN_VAULT_ENV}=<绝对路径>（skill 自带脚本的 python 侧也认它）`,
      `或先 ${APP_NAME} kb add <目录>：第一个含 .obsidian/ 的登记库会作为兜底`,
    ];
    return out;
  }

  out.vaultExists = isDir(vault);
  out.hasObsidianMarker = existsSync(join(vault, '.obsidian'));
  out.specDir = join(vault, config.specDir);
  out.specDirExists = isDir(out.specDir);
  out.docs = [
    { key: 'content', doc: config.contentDoc, path: join(out.specDir, config.contentDoc) },
    {
      key: 'questionnaire',
      doc: config.questionnaireDoc,
      path: join(out.specDir, config.questionnaireDoc),
    },
  ].map((d) => ({ ...d, exists: existsSync(d.path) }));

  const hints = [];
  if (!out.vaultExists) {
    hints.push(`vault 目录不存在: ${vault} —— 移动 / 改名后用 ${APP_NAME} obsidian set vault=<新路径> 更新`);
  } else if (!out.hasObsidianMarker) {
    hints.push(
      `未发现 .obsidian/：不像 Obsidian vault —— skill 自带脚本沿父目录找 .obsidian 定位，找不到时会要求显式 --vault 或 ${OBSIDIAN_VAULT_ENV}`,
    );
  }
  if (!out.specDirExists) {
    hints.push(
      `规范目录不存在: ${out.specDir} —— 在 vault 里创建它，或 ${APP_NAME} obsidian set specDir=<vault内相对路径>`,
    );
  } else {
    for (const d of out.docs) {
      if (d.exists) continue;
      const key = d.key === 'content' ? 'contentDoc' : 'questionnaireDoc';
      hints.push(`规范文档缺失: ${d.path} —— 把规范写进这个文件，或 ${APP_NAME} obsidian set ${key}=<文件名> 指向已有文件`);
    }
  }
  out.hints = hints;
  return out;
}

export async function get() {
  return resolvePaths();
}

// skill 面向的消费契约：只给「该读哪两个文件」。
// 故意与 get 分开——get 服务于管理（面板 / 人），可以随意加字段；
// spec 服务于 agent，形状保持最小且稳定。
export async function spec() {
  const r = await resolvePaths();
  if (!r.configured) return { status: 'ok', configured: false, hints: r.hints };
  return {
    status: 'ok',
    configured: true,
    source: r.source,
    vault: r.vault,
    specDir: r.specDir,
    docs: r.docs,
    ...(r.hints.length ? { hints: r.hints } : {}),
  };
}

// ---- set：白名单 + 逐键校验（只有这里允许抛）----
const VALIDATORS = {
  // 绝对路径：resolve 接受相对（对齐 kb add），存在性严格；空串 = 清除。
  vault: (v) => {
    if (!v) return '';
    const abs = resolve(String(v));
    if (!isDir(abs)) throw notFound(`vault 目录不存在: ${abs}（填的是: ${v}）`);
    return abs;
  },
  // vault 内相对路径。绝对路径 / .. 在这里被当场拒绝（assertSafeRelPath 抛 INVALID_INPUT）。
  specDir: (v) => (v ? assertSafeRelPath(v, { label: '规范目录（vault 内相对路径）' }) : ''),
  // 裸文件名：不允许出现路径分隔符。
  contentDoc: (v) => (v ? assertSafeRelPath(v, { label: '内容规范文档名', allowSubdir: false }) : ''),
  questionnaireDoc: (v) =>
    v ? assertSafeRelPath(v, { label: '问卷规范文档名', allowSubdir: false }) : '',
};

export async function set({ patch = {} } = {}) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return { status: 'ok', skipped: true, ...(await resolvePaths()) };

  const unknown = keys.filter((k) => !OBSIDIAN_KEYS.includes(k));
  if (unknown.length) {
    throw badInput(`未知的 obsidian 配置键: ${unknown.join(', ')}（允许: ${OBSIDIAN_KEYS.join(', ')}）`);
  }

  const validated = {};
  for (const k of keys) validated[k] = VALIDATORS[k](patch[k]);

  await mutateStore((store) => {
    store.obsidian = { ...store.obsidian, ...validated };
    return store.obsidian;
  });

  const r = await resolvePaths();
  return { status: 'ok', written: keys, ...r };
}
