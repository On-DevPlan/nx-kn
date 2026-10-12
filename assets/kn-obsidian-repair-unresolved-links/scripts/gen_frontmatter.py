#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_frontmatter.py - 从 templater 模板生成 Obsidian 标准 frontmatter
Py2.7 / Py3.x 兼容。

vault 根解析：--vault > NX_OBSIDIAN_VAULT > cwd 沿父目录找 .obsidian

用法:
  cd /path/to/vault
  python gen_frontmatter.py --link "什么时候发生Crash"
  python gen_frontmatter.py --source 日常/undolog.md --link "什么时候发生Crash"
  python gen_frontmatter.py --source 日常/undolog.md --link "什么时候发生Crash" --locate
  python gen_frontmatter.py --vault /path/to/vault --source 日常/foo.md --link "xxx"
"""

import codecs
import os
import re
import sys
from datetime import datetime

# ---------- Py2/Py3 兼容辅助 ----------
try:
    unicode_type = unicode  # Py2
    bytes_type = str
except NameError:
    unicode_type = str  # Py3
    bytes_type = bytes

ILLEGAL = re.compile(r'[*"\\/<>:\|?]')
WIKI = re.compile(r'\[\[([^\]]+)\]\]')


def _to_unicode(s, encoding=None):
    """Py2: str(可能 cp936/utf-8) -> unicode; Py3: 原样返回."""
    if s is None:
        return u''
    if isinstance(s, unicode_type):
        return s
    if not encoding:
        for enc in ('utf-8', 'cp936', 'gbk'):
            try:
                return s.decode(enc)
            except (UnicodeDecodeError, AttributeError):
                continue
        return s.decode('utf-8', errors='replace')
    return s.decode(encoding, errors='replace')


def _setup_stdout():
    """让 print 出来的中文不乱码: Py2 重写 stdout, Py3 reconfigure."""
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, Exception):
        pass
    if sys.version_info[0] == 2:
        try:
            sys.stdout = codecs.getwriter('utf-8')(sys.stdout, errors='replace')
        except Exception:
            pass


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
    """vault 根解析：CLI 参数 > 环境变量 > cwd。"""
    if cli_vault:
        return _to_unicode(cli_vault)
    env = os.environ.get('NX_OBSIDIAN_VAULT')
    if env:
        return _to_unicode(env)
    return _to_unicode(find_vault_root(os.getcwd()))


# ---------- 文件读取 ----------
def read_file(path):
    """utf-8 读取，失败回退 cp936 / gbk / replace。"""
    with open(path, 'rb') as f:
        data = f.read()
    for enc in ('utf-8-sig', 'utf-8', 'cp936', 'gbk'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', errors='replace')


# ---------- 源文件定位 ----------
def find_sources(vault, link_text):
    """找到所有引用了 [[link_text]] 的 markdown 文件."""
    link_text_u = _to_unicode(link_text)
    hits = []
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '.git']
        for f in sorted(files):
            if not f.endswith('.md'):
                continue
            fpath = os.path.join(root, f)
            rel = os.path.relpath(fpath, vault).replace('\\', '/')
            if rel.startswith('ctl/'):
                continue
            try:
                content = read_file(fpath)
            except Exception:
                continue
            for i, line in enumerate(content.split('\n'), 1):
                for m in WIKI.finditer(line):
                    resolved = _to_unicode(
                        m.group(1).split('#')[0].split('|')[0]
                    ).strip()
                    matched = False
                    try:
                        matched = (resolved == link_text_u)
                    except UnicodeWarning:
                        matched = (
                            _to_unicode(resolved) == _to_unicode(link_text_u)
                        )
                    if matched:
                        hits.append({'file': rel, 'line': i})
    return hits


# ---------- 文件名清理 ----------
def sanitize(raw):
    name = ILLEGAL.sub('', raw).strip().strip('.')
    name = re.sub(r' {2,}', ' ', name)
    if not name:
        name = 'unresolved-%d' % (abs(hash(raw)) % 10000)
    return name


# ---------- 模板键同义映射 ----------
_BKLINK_ALIASES = ('bklink', 'backlinks', 'backlink', 'aliases')
_TIME_ALIASES = ('creatime', 'created', 'create_time', 'date')
_TAG_ALIASES = ('tags', 'tag')

# 默认生成三段（不依赖 vault 里的任何模板文件——客户零依赖）
DEFAULT_KEYS = ['creatime', 'tags', 'bklink']


def gen_frontmatter(keys, bklink_entries):
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    lines = [u'---']
    for key in keys:
        key = _to_unicode(key) if isinstance(key, bytes_type) else key
        k = key.lower()
        if k in _TIME_ALIASES:
            lines.append(u'%s: %s' % (key, now))
        elif k in _TAG_ALIASES:
            lines.append(u'%s: []' % key)
        elif k in _BKLINK_ALIASES:
            if bklink_entries:
                lines.append(u'%s:' % key)
                seen = set()
                for entry in bklink_entries:
                    # 取 basename 不再 splitext：文件名含点时（如 kafka的Log.scala文件是干嘛的）
                    # 不该被误当扩展名截断成 kafka的Log
                    stem = _to_unicode(os.path.basename(entry))
                    if stem not in seen:
                        seen.add(stem)
                        lines.append(u'  - "[[%s]]"' % stem)
            else:
                lines.append(u'%s: []' % key)
        else:
            lines.append(u'%s:' % key)
    lines.append(u'---')
    return u'\n'.join(lines)


def _get_arg(flag):
    """从 sys.argv 拿 --flag 的下一个值。"""
    if flag not in sys.argv:
        return None
    idx = sys.argv.index(flag)
    return sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None


# ---------- 入口 ----------
def main():
    _setup_stdout()

    if sys.version_info[0] == 2:
        try:
            sys.setdefaultencoding('utf-8')
        except Exception:
            pass

    link = _get_arg('--link')
    if not link:
        print('usage: gen_frontmatter.py --link <link> [--source <file>] [--locate] [--vault <path>]')
        sys.exit(1)

    source_u = _to_unicode(_get_arg('--source'))
    link_u = _to_unicode(link)
    cli_vault = _to_unicode(_get_arg('--vault'))

    vault = resolve_vault(cli_vault)
    keys = DEFAULT_KEYS
    safe = sanitize(link_u)

    print(u'. vault: %s' % vault)
    print(u'. frontmatter keys: %s' % keys)
    print(u'. filename: %s.md' % safe)

    bklink_entries = []
    if source_u:
        stem = os.path.splitext(os.path.basename(source_u))[0]
        bklink_entries.append(stem)
    if '--locate' in sys.argv or not source_u:
        sources = find_sources(vault, link_u)
        for s in sources:
            stem = os.path.splitext(os.path.basename(_to_unicode(s['file'])))[0]
            if stem not in bklink_entries:
                bklink_entries.append(stem)
            print(u'. source: %s:%d' % (_to_unicode(s['file']), s['line']))

    print(gen_frontmatter(keys, bklink_entries))


if __name__ == '__main__':
    main()
