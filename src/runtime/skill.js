// skill 命令域：把随包 skill 装到 ~/.claude/skills、或导出给外部 agent。
// 平台级能力（不属于业务域），挂在 runtime/skill.js。
//
// 为什么有这个：这个骨架的工具不只是给人用的，也是给 agent 用的（A00 驱动链第 3 条）。
//   skill install → 让本机 agent 学得会用（装到 ~/.claude/skills）
//   skill get     → 让不读本机 skill 目录的外部 agent 一键拿全上下文（stdout 三段拼接）
// 缺任何一条，工具对 agent 的可编程性就单边打折。
import * as fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assertSafeName } from '../core/paths.js';
import { APP_NAME } from '../core/paths.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = join(__dirname, '..', '..', 'assets');
export const DEFAULT_SKILLS_DIR =
  join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
export const SKILL_NAME = APP_NAME;
const SENTINEL = '# --- begin skill content (do not modify this line) ---';

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

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
    const err = new Error(`未找到内置 skill: ${name}（可用: ${available || '(assets/ 下无 skill)'}）`);
    err.code = 'NOT_FOUND';
    throw err;
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
// 返回四元 {skillName, ref, content, contentBytes, install}——--json 的输出形状。
export async function getSkill({ name = SKILL_NAME, ref = '', to, force } = {}) {
  name = assertSafeName(name);
  let rel;
  if (!ref || ref === 'SKILL.md') rel = 'SKILL.md';
  else if (ref.includes('/') || ref.startsWith('./')) rel = ref.replace(/^\.\//, '');
  else {
    // 裸名：先 references/<name>.md 再 <name>.md
    const a = join(ASSETS_DIR, name, 'references', `${ref}.md`);
    const b = join(ASSETS_DIR, name, `${ref}.md`);
    rel = (await exists(a)) ? join('references', `${ref}.md`) : (await exists(b)) ? `${ref}.md` : null;
    if (!rel) {
      const refs = await listRefs(name);
      const err = new Error(`未知 ref: ${ref}（可用: SKILL.md, ${refs.join(', ')}）`);
      err.code = 'INVALID_INPUT';
      throw err;
    }
  }
  if (rel.includes('..')) {
    const err = new Error(`ref 路径不允许包含 '..': ${ref}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const file = join(ASSETS_DIR, name, rel);
  const outside = !join(file).startsWith(join(ASSETS_DIR, name));
  if (outside) {
    const err = new Error(`ref 越界: ${ref}`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    const err = new Error(`未找到 skill 文档: ${name}/${rel}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const install = await installBundledSkill({ name, to, force });
  return { skillName: name, ref: rel, content, contentBytes: Buffer.byteLength(content, 'utf8'), install };
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
