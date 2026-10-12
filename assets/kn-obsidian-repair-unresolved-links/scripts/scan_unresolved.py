#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
scan_unresolved.py — 扫描 vault 中所有未解析的 [[]] 链接
仿 `obsidian unresolved format=json` 输出。

vault 根解析：--vault > NX_OBSIDIAN_VAULT > cwd 沿父目录找 .obsidian

用法:
  cd /path/to/vault
  python scan_unresolved.py                        # 默认输出到脚本同目录 unresolved.json
  python scan_unresolved.py --out /tmp/out.json    # 输出到指定路径
  python scan_unresolved.py --vault /path/to/vault # 显式 vault 根
"""
import codecs
import io
import os
import re
import json
import sys

WIKI = re.compile(r'\[\[([^\]]+)\]\]')

# 文件扩展名白名单：图片/附件
IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp',
           '.pdf', '.mp4', '.mp3', '.wav', '.mov', '.webm', '.zip',
           '.tar', '.gz', '.rar', '.7z')


# ---------- vault 根解析 ----------
def find_vault_root(start):
    """从 start 出发找 vault 根（含 .obsidian 目录）。"""
    p = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(p, '.obsidian')):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            raise RuntimeError(
                'cannot find vault root: cwd 不是 vault 根（父目录里也找不到 .obsidian）。'
                ' 用 --vault 或 NX_OBSIDIAN_VAULT 显式指定。'
            )
        p = parent


def resolve_vault(cli_vault):
    if cli_vault:
        return cli_vault
    env = os.environ.get('NX_OBSIDIAN_VAULT')
    if env:
        return env
    return find_vault_root(os.getcwd())


def read_file(path):
    with open(path, 'rb') as f:
        data = f.read()
    for enc in ('utf-8-sig', 'utf-8', 'cp936', 'gbk'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', errors='replace')


def build_index(vault):
    """建立文件索引。
    返回:
      by_stem: {basename_stem -> [相对路径, ...]}  处理 [[name]] (basename)
      by_path: {rel_path_without_ext -> [相对路径, ...]}  处理 [[path/name]] 或 [[path/name.md]]
    """
    by_stem = {}
    by_path = {}

    def _u(s):
        if isinstance(s, bytes):
            for enc in ('cp936', 'gbk', 'utf-8'):
                try:
                    return s.decode(enc)
                except UnicodeDecodeError:
                    continue
            return s.decode('utf-8', errors='replace')
        return s

    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in ('.obsidian', '.git', '.claude')]
        for f in files:
            if not f.endswith('.md'):
                continue
            fpath = os.path.join(root, f)
            rel = os.path.relpath(fpath, vault).replace('\\', '/')
            stem = os.path.splitext(f)[0]
            rel_no_ext = os.path.splitext(rel)[0]
            by_stem.setdefault(_u(stem), []).append(_u(rel))
            by_path.setdefault(_u(rel_no_ext), []).append(_u(rel))
    return by_stem, by_path


def is_attachment_link(text):
    """[[foo.png]] 或 [[foo.png|caption]] 算附件"""
    lower = text.lower()
    return lower.endswith(IMG_EXT)


def is_code_block_skip(line, in_code):
    """简单状态机：跳过 ``` 围起来的代码块"""
    stripped = line.strip()
    if stripped.startswith('```'):
        return not in_code
    return in_code


def _get_arg(flag):
    if flag not in sys.argv:
        return None
    idx = sys.argv.index(flag)
    return sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None


def main():
    cli_vault = _get_arg('--vault')
    vault = resolve_vault(cli_vault)

    out_arg = _get_arg('--out')
    if out_arg:
        out_path = out_arg
    else:
        # 默认：脚本自身同目录 unresolved.json
        skill_dir = os.path.dirname(os.path.abspath(__file__))
        cur = skill_dir
        for _ in range(5):
            if os.path.isfile(os.path.join(cur, 'SKILL.md')):
                skill_dir = cur
                break
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        out_path = os.path.join(skill_dir, 'unresolved.json')

    by_stem, by_path = build_index(vault)
    refs = []  # [(link, file, line)]
    in_code = False
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in ('.obsidian', '.git', '.claude')]
        for f in sorted(files):
            if not f.endswith('.md'):
                continue
            fpath = os.path.join(root, f)
            rel = os.path.relpath(fpath, vault).replace('\\', '/')
            # 跳过模板文件
            if rel.startswith('ctl/tmpl_'):
                continue
            try:
                content = read_file(fpath)
            except Exception:
                continue
            in_code = False
            for i, line in enumerate(content.split('\n'), 1):
                in_code = is_code_block_skip(line, in_code)
                if in_code:
                    continue
                cleaned = re.sub(r'`[^`]*`', '', line)
                for m in WIKI.finditer(cleaned):
                    raw = m.group(1)
                    link = raw.split('#')[0].split('|')[0].strip()
                    if not link:
                        continue
                    if is_attachment_link(link):
                        continue
                    stem = os.path.splitext(os.path.basename(rel))[0]
                    try:
                        if isinstance(link, bytes):
                            link_cmp = link.decode('utf-8', 'replace')
                        else:
                            link_cmp = link
                        if isinstance(stem, bytes):
                            stem_cmp = stem.decode('utf-8', 'replace')
                        else:
                            stem_cmp = stem
                        if link_cmp == stem_cmp:
                            continue
                    except Exception:
                        continue
                    refs.append((link, rel, i))

    # 解析：link 是否能解析到现存文件
    unresolved = {}

    def _u(s):
        if isinstance(s, bytes):
            for enc in ('cp936', 'gbk', 'utf-8'):
                try:
                    return s.decode(enc)
                except UnicodeDecodeError:
                    continue
            return s.decode('utf-8', errors='replace')
        return s

    for link, f, ln in refs:
        resolved = False
        link_u = _u(link)
        link_no_ext = link_u
        if link_no_ext.lower().endswith('.md'):
            link_no_ext = link_no_ext[:-3]
        if link_no_ext in by_path:
            resolved = True
        elif link_u in by_path:
            resolved = True
        else:
            stem = os.path.basename(link_no_ext)
            if _u(stem) in by_stem:
                resolved = True
        if not resolved:
            unresolved.setdefault(link_u, []).append({'file': _u(f), 'line': ln})

    out = []
    for link, hits in sorted(unresolved.items()):
        out.append({
            'link': link,
            'sources': hits,
        })

    # 全部转成 unicode 字符串避免 Py2 json ascii error
    def _ub(s):
        if isinstance(s, bytes):
            return s.decode('utf-8', errors='replace')
        return s
    out_clean = []
    for o in out:
        out_clean.append({
            'link': _ub(o['link']),
            'sources': [{'file': _ub(h['file']), 'line': h['line']} for h in o['sources']],
        })
    payload = json.dumps(out_clean, ensure_ascii=False, indent=2)
    if isinstance(payload, bytes):
        payload = payload.decode('utf-8')
    with io.open(out_path, 'w', encoding='utf-8') as fp:
        fp.write(payload)
        fp.write(u'\n')
    sys.stderr.write('Total unresolved links: %d\n' % len(out))
    sys.stderr.write('Total references: %d\n' % sum(len(o['sources']) for o in out))
    sys.stderr.write('Output: %s\n' % out_path)
    sys.stderr.write('Vault: %s\n' % vault)


if __name__ == '__main__':
    main()
