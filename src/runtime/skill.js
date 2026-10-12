// skill 平台命令：把随包 skill 装到 ~/.claude/skills、或导出给外部 agent。
//
// 多 skill 形态（per server-cli-web-scaffold B04）：
//   - 默认 install: 装 package.json.name（=APP_NAME=nx-kn）
//   - skill install <name>: 装指定 skill
//   - skill install --group=<g>: 一键装一组（g 是 groups.json 里的 key）
//   - skill list: 列所有 skill + group，标默认 install
//   - skill groups: 列所有 group
//   - skill get [name] [ref]: 导出单 skill（与历史兼容）
//   - groups.json 缺失/损坏 → 降级到目录扫描（每个 assets/<x>/SKILL.md 视作一个 group）
//
// 为什么有这个：本骨架的工具不只是给人用的，也是给 agent 用的（A00 驱动链第 3 条）。
//   skill install → 让本机 agent 学得会用（装到 ~/.claude/skills）
//   skill get     → 让不读本机 skill 目录的外部 agent 一键拿全上下文（stdout 三段拼接）
//   skill list    → 让 agent 看到「还有什么 skill 能用」+ 默认装的是谁
//   skill groups  → 让 agent 看到 `--group` 的取用形态与可用 group
import { readFileSync, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeName, APP_NAME } from '../core/paths.js';
import { badInput, notFound } from '../core/errors/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = join(__dirname, '..', '..', 'assets');
export const DEFAULT_SKILLS_DIR =
  join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
export const SKILL_NAME = APP_NAME;
const SENTINEL = '# --- begin skill content (do not modify this line) ---';
const GROUPS_FILE = join(ASSETS_DIR, 'groups.json');
const PACKAGE_JSON = join(__dirname, '..', '..', 'package.json');

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- 单 skill 原语（历史 API，供 runInstall 调用）----------
export async function bundledSkillNames() {
  try {
    const entries = await fsp.readdir(ASSETS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function installBundledSkill({ name = SKILL_NAME, to, force } = {}) {
  name = assertSafeName(name);
  const src = join(ASSETS_DIR, name);
  if (!existsSync(join(src, 'SKILL.md'))) {
    const available = (await bundledSkillNames()).join(', ');
    throw notFound(`未找到内置 skill: ${name}（可用: ${available || '(assets/ 下无 skill)'}）`);
  }
  const dst = join(to || DEFAULT_SKILLS_DIR, name);
  const files = await diffTrees(src, dst);
  if (!files.length) return { status: 'ok', skipped: true, path: dst, files: 0 };

  const existsDst = await exists(dst);
  if (existsDst && !force) {
    return { status: 'conflict', path: dst, files, count: files.length };
  }
  if (existsDst) await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true, dereference: true, force: true });
  return { status: 'ok', installed: !existsDst, replaced: existsDst, path: dst, files: files.length };
}

// skill get：读文档 + 顺手按 install 逻辑装（幂等）。
// 返回五元 {skillName, ref, content, contentBytes, install, group}——--json 的输出形状。
export async function getSkill({ name = SKILL_NAME, ref = '', to, force } = {}) {
  name = assertSafeName(name);
  let rel;
  if (!ref || ref === 'SKILL.md') rel = 'SKILL.md';
  else if (ref.includes('/') || ref.startsWith('./')) rel = ref.replace(/^\.\//, '');
  else {
    const a = join(ASSETS_DIR, name, 'references', `${ref}.md`);
    const b = join(ASSETS_DIR, name, `${ref}.md`);
    rel = (await exists(a)) ? join('references', `${ref}.md`) : (await exists(b)) ? `${ref}.md` : null;
    if (!rel) {
      const refs = await listRefs(name);
      throw badInput(`未知 ref: ${ref}（可用: SKILL.md, ${refs.join(', ')}）`);
    }
  }
  if (rel.includes('..')) {
    throw badInput(`ref 路径不允许包含 '..': ${ref}`);
  }
  const file = join(ASSETS_DIR, name, rel);
  const outside = !join(file).startsWith(join(ASSETS_DIR, name));
  if (outside) {
    throw badInput(`ref 越界: ${ref}`);
  }
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    throw notFound(`未找到 skill 文档: ${name}/${rel}`);
  }
  const install = await installBundledSkill({ name, to, force });
  // 反查该 skill 属于哪个 group（仅在 manifest 模式下确定；降级模式下无法反查）
  let group = null;
  try {
    const { groups, source } = await loadGroups();
    if (source === 'manifest') {
      for (const [gname, g] of Object.entries(groups)) {
        if (g.skills.includes(name)) {
          group = gname;
          break;
        }
      }
    }
  } catch {
    /* group 信息缺失不致命 */
  }
  return { skillName: name, ref: rel, content, contentBytes: Buffer.byteLength(content, 'utf8'), install, group };
}

// 前缀引导语：sentinel 行让 agent 有明确的「从这里开始复制」边界。
export function skillGetPrefix(name, ref) {
  return [
    `# === ${name} skill context ===`,
    `# 以下内容来自 ${name} skill \`${name}\` ${ref || 'SKILL.md'}。`,
    `# 建议：把 sentinel 行之后的全文复制到你可访问的路径（如 .claude/skills/${name}/SKILL.md），以便后续会话复用。`,
    SENTINEL,
    '',
  ].join('\n');
}

export function skillGetInstallStatus(install) {
  if (install.status === 'conflict') {
    return `-- install 状态 --\n冲突: ${install.path}（${install.count} 个文件不同；确认覆盖用 ${APP_NAME} skill install --force）`;
  }
  if (install.skipped) return `-- install 状态 --\n已是最新: ${install.path}`;
  if (install.replaced) return `-- install 状态 --\n已替换: ${install.path}（${install.files} 个文件）`;
  return `-- install 状态 --\n已安装: ${install.path}（${install.files} 个文件）`;
}

export async function listRefs(name) {
  const dir = join(ASSETS_DIR, name, 'references');
  try {
    return (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

// 对比两棵树，返回内容不同的相对路径（安装器据此判断「跳过/冲突/覆盖」）
async function diffTrees(src, dst, rel = '') {
  const changed = [];
  let srcEntries;
  try {
    srcEntries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const e of srcEntries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      changed.push(...(await diffTrees(s, d, rel ? rel + '/' + e.name : e.name)));
    } else if (e.isFile()) {
      let same = false;
      try {
        const [a, b] = await Promise.all([fsp.readFile(s), fsp.readFile(d)]);
        same = a.equals(b);
      } catch {
        same = false; // dst 不存在 = 新文件
      }
      if (!same) changed.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return changed;
}

// ---------- 多 skill 扩展（per B04）----------

function readPackageName() {
  try {
    const raw = readFileSync(PACKAGE_JSON, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

async function listAssetDirs() {
  const out = [];
  try {
    const entries = await fsp.readdir(ASSETS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (await exists(join(ASSETS_DIR, e.name, 'SKILL.md'))) out.push(e.name);
    }
  } catch {
    /* assets/ 不可读 → 空 */
  }
  return out;
}

// 校验 group 名：字母数字下划线连字符，禁路径穿越字符
function assertSafeGroupName(name) {
  if (typeof name !== 'string' || !name) throw badInput('group 名不能为空');
  if (name !== name.trim()) throw badInput(`group 名不能含首尾空白: '${name}'`);
  // 以 `-` 开头的视为 flag 防误读
  if (name.startsWith('-')) throw badInput(`group 名不能以 '-' 开头: '${name}'`);
  assertSafeName(name);
  return name;
}

// 读 groups.json；缺/坏则降级到目录扫描
export async function loadGroups() {
  const pkgName = readPackageName();

  // 1. 试 manifest
  if (existsSync(GROUPS_FILE)) {
    let manifest;
    try {
      const raw = await fsp.readFile(GROUPS_FILE, 'utf8');
      manifest = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(
        `[WARN] groups.json 解析失败（${e && e.message ? e.message : String(e)}），降级到目录扫描\n`,
      );
      manifest = null;
    }
    if (manifest) {
      // 严格 schema 校验：不合规即 INVALID_INPUT，不静默
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        throw badInput('groups.json 顶层必须是对象');
      }
      if (!('version' in manifest)) throw badInput('groups.json 缺 version 字段');
      if (!('groups' in manifest) || typeof manifest.groups !== 'object' || manifest.groups === null || Array.isArray(manifest.groups)) {
        throw badInput('groups.json 缺 groups 对象（或类型错）');
      }
      const groups = {};
      const seen = new Set();
      for (const [gname, g] of Object.entries(manifest.groups)) {
        assertSafeGroupName(gname);
        if (typeof g !== 'object' || g === null || Array.isArray(g)) {
          throw badInput(`group ${gname} 必须是对象`);
        }
        if (!Array.isArray(g.skills)) {
          throw badInput(`group ${gname} 缺 skills 数组`);
        }
        // 同 group 内去重；同时跨 group 也去重（避免同一 skill 多次 install 计数错乱）
        const skills = [];
        for (const s of g.skills) {
          if (typeof s !== 'string' || !s) throw badInput(`group ${gname} 含非法 skill 名`);
          assertSafeName(s);
          if (seen.has(s)) continue;
          seen.add(s);
          skills.push(s);
        }
        groups[gname] = { skills, summary: typeof g.summary === 'string' ? g.summary : '' };
      }
      return {
        source: 'manifest',
        groups,
        defaultGroup: pkgName && groups[pkgName] ? pkgName : null,
        pkgName,
      };
    }
    // manifest = null（解析失败已经写过 stderr）→ 落进降级
  }

  // 2. 降级：目录扫描
  const assetDirs = await listAssetDirs();
  const groups = {};
  for (const name of assetDirs) groups[name] = { skills: [name], summary: '' };
  return {
    source: 'assets-dirs',
    groups,
    defaultGroup: pkgName && groups[pkgName] ? pkgName : null,
    pkgName,
  };
}

// 列出所有 group 名（list 与 groups 共用）
export async function availableGroups() {
  const { groups } = await loadGroups();
  return Object.keys(groups);
}

// ---- dispatcher（install 子命令）----
// 形态：
//   runInstall({})                                     → 默认 install（=package.name）
//   runInstall({name})                                 → 单 skill install
//   runInstall({group})                                → 一键装 group
//   runInstall({name, group})                          → INVALID_INPUT（互斥）
//   runInstall({group: '' / '-' / '\n' / nullish})     → INVALID_INPUT
export async function runInstall({ name, group, to, force } = {}) {
  // --group 校验：空值 / 以 `-` 开头 / 非字符串 一律报错（绝不回落默认）
  if (group !== undefined && group !== null) {
    if (typeof group !== 'string' || !group.trim()) {
      throw badInput('--group 值不能为空');
    }
    if (group.startsWith('-')) {
      throw badInput(`--group 值不能以 '-' 开头: '${group}'`);
    }
    assertSafeGroupName(group);
  }

  // 互斥
  const hasName = name !== undefined && name !== null && name !== '';
  if (hasName && group !== undefined && group !== null) {
    throw badInput('--group 与位置参数 [name] 互斥；二选一');
  }

  // --group 一键装
  if (group !== undefined && group !== null) {
    const { groups } = await loadGroups();
    const g = groups[group];
    if (!g) {
      const available = Object.keys(groups).join(', ');
      throw badInput(`未知 group: ${group}（可用: ${available || '(无)'}）`);
    }
    if (!g.skills.length) {
      throw badInput(`group ${group} 为空`);
    }
    const perSkill = [];
    for (const s of g.skills) {
      const r = await installBundledSkill({ name: s, to, force });
      perSkill.push({
        skill: s,
        path: r.path,
        installed: !!r.installed,
        replaced: !!r.replaced,
        skipped: !!r.skipped,
        conflict: r.status === 'conflict',
        files: r.files ?? null,
        count: r.count ?? null,
      });
    }
    return {
      status: 'ok',
      group,
      skills: perSkill,
    };
  }

  // 默认 / 显式 name
  const skillName = hasName ? name : SKILL_NAME;
  const r = await installBundledSkill({ name: skillName, to, force });
  // 与历史形状兼容：保留 status/installed/replaced/skipped/conflict/path/files/count
  // 增加：skill, group:null 标明这是单 skill 而非 group install
  return { ...r, skill: skillName, group: null };
}

// list（list 与 groups 子命令共用 loadGroups；不重复实现目录扫描）
export async function runList() {
  const { groups, defaultGroup, source, pkgName } = await loadGroups();
  const skills = Object.keys(groups);
  return {
    skills,
    groups: Object.entries(groups).map(([name, g]) => ({
      name,
      skills: g.skills,
      summary: g.summary,
      isDefault: name === defaultGroup,
    })),
    defaultGroup,
    pkgName,
    source,
  };
}

export async function runGroups() {
  const r = await runList();
  return { groups: r.groups, defaultGroup: r.defaultGroup, source: r.source, pkgName: r.pkgName };
}
