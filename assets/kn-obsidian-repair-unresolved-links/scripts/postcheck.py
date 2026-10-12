# -*- coding: utf-8 -*-
"""
postcheck.py — 新文件写完后，校验"新文件内部的双链引用是否真的被解析"
Py2.7 / Windows 兼容。

vault 根解析：--vault > NX_OBSIDIAN_VAULT > cwd 沿父目录找 .obsidian

设计原则（v1, 2026-07-09）：
- 不用正则自己解析 [[]]，全部交给 `obsidian unresolved` CLI
- 用 "snapshot diff" 识别新文件引入的失败引用：
    1. 写新笔记前，snapshot 当前 vault 的 unresolved 列表
    2. 写新笔记后，再跑一次 unresolved
    3. diff 两次结果 → 新增的未解析项 = 新笔记引入的问题

用法：
  python scripts/postcheck.py --snapshot snapshot.json
  python scripts/postcheck.py --snapshot-before snapshot.json --new-file "日常/foo.md"

退出码：
  0 = 通过（新文件的双链全部解析成功）
  1 = 失败（新文件引入 ≥1 个未解析链接，stderr 打印明细）
  2 = 调用 obsidian CLI 出错
"""
import argparse
import io
import json
import os
import subprocess
import sys

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


def find_skill_dir():
    """从 __file__ 向上找含 SKILL.md 的目录。
    因为 install 路径不可预测（用户可能 --to 到任何路径），不能硬编码。
    """
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(5):
        if os.path.isfile(os.path.join(cur, 'SKILL.md')):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent
    return None


def sout(msg):
    """安全写 stderr。"""
    if isinstance(msg, str):
        sys.stderr.write(msg)
    else:
        sys.stderr.write(msg.encode('utf-8', 'replace'))
    sys.stderr.flush()


def _u(s):
    if isinstance(s, bytes):
        for enc in ('utf-8', 'cp936', 'gbk'):
            try:
                return s.decode(enc)
            except UnicodeDecodeError:
                continue
        return s.decode('utf-8', errors='replace')
    return s


def run_scan_fallback(vault, skill_dir):
    """obsidian CLI 不在 PATH 时，退回 scan_unresolved.py。"""
    if not skill_dir:
        sout(u'[ERROR] 找不到 skill 目录（脚本所在父目录不含 SKILL.md）\n')
        sys.exit(2)
    scan_script = os.path.join(skill_dir, u'scripts', u'scan_unresolved.py')
    out_json = os.path.join(skill_dir, u'unresolved.json')
    try:
        proc = subprocess.Popen(
            [sys.executable, scan_script, '--out', out_json, '--vault', vault],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        proc.communicate()
        with io.open(out_json, u'r', encoding=u'utf-8') as f:
            return json.load(f)
    except (OSError, IOError, ValueError) as e:
        sout(u'[ERROR] scan_unresolved.py fallback failed: %s\n' % _u(e))
        sys.exit(2)


def run_obsidian_unresolved(vault):
    """调 obsidian CLI，返回 unresolved 列表。"""
    try:
        proc = subprocess.Popen(
            ['obsidian', 'unresolved', 'verbose', 'format=json'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=vault,
        )
    except OSError:
        sout(u'[WARN] obsidian CLI 不在 PATH，退回 scan_unresolved.py 扫描\n')
        skill_dir = find_skill_dir()
        return run_scan_fallback(vault, skill_dir)

    out_bytes, err_bytes = proc.communicate()
    out = _u(out_bytes) + u'\n' + _u(err_bytes)

    start = out.find(u'[')
    end = out.rfind(u']')
    no_link_marker = u'No unresolved links found.'
    if start < 0 or end < 0 or end <= start:
        if no_link_marker in out:
            return []
        sout(u'[ERROR] obsidian 输出无 JSON 数组\nblob=%r\n' % out[:500])
        sys.exit(2)
    try:
        return json.loads(out[start:end + 1])
    except ValueError as e:
        sout(u'[ERROR] JSON parse failed: %s\nblob=%r\n' % (e, out[start:end + 1][:500]))
        sys.exit(2)


def take_snapshot(out_path, vault, skill_dir):
    items = run_obsidian_unresolved(vault)
    snap = {}
    for it in items:
        link = _u(it[u'link'])
        snap[link] = _u(it.get(u'sources', u''))
    full_path = out_path if os.path.isabs(out_path) else os.path.join(vault, out_path)
    import codecs
    with codecs.open(full_path, u'w', encoding=u'utf-8') as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)
        f.write(u'\n')
    sout(u'[SNAPSHOT] %d unresolved links saved to %s\n' % (len(snap), full_path))
    sout(u'[VAULT]   %s\n' % vault)
    return snap


def diff_and_report(snap_before_path, new_file_rel, vault, skill_dir):
    full_path = snap_before_path if os.path.isabs(snap_before_path) else os.path.join(vault, snap_before_path)
    if not os.path.isfile(full_path):
        sout(u'[ERROR] snapshot not found: %s\n' % full_path)
        sout(u'       请先跑 --snapshot 步骤\n')
        sys.exit(2)

    import codecs
    with codecs.open(full_path, u'r', encoding=u'utf-8') as f:
        before = json.load(f)
    before_keys = set(_u(k) for k in before.keys())

    after_items = run_obsidian_unresolved(vault)
    after_map = {}
    for it in after_items:
        after_map[_u(it[u'link'])] = _u(it.get(u'sources', u''))

    new_unresolved = sorted(set(after_map.keys()) - before_keys)
    if not new_unresolved:
        sout(u'[OK] 新文件 %s 未引入新的未解析双链\n' % _u(new_file_rel))
        return 0

    sout(u'[FAIL] 新文件 %s 引入了 %d 个未解析双链：\n' % (_u(new_file_rel), len(new_unresolved)))
    for link in new_unresolved:
        sources = after_map[link]
        sout(u'  - [[%s]]  (sources: %s)\n' % (_u(link), _u(sources)))
    sout(u'\n')
    sout(u'常见根因（按发生概率排序）：\n')
    sout(u'  1. 双链含不可见字符：半角空格 / 全角空格（　）/ NBSP（\\u00A0）/ 中文空格（\\u3000）\n')
    sout(u'  2. 双链首尾多了标点：`[[foo]]、` 被记成 `foo、` 找不到\n')
    sout(u'  3. 双链用了全角括号：`【foo】` 不是 `[[foo]]`\n')
    sout(u'  4. 目标文件名带空格但双链写成下划线/无空格（反之亦然）\n')
    sout(u'  5. 目标文件实际未创建（先跑 SKILL.md 步骤 7 确认文件落地）\n')
    sout(u'  6. 目标文件在另一个目录但双链用了 basename（应改 [[path/file]] 或确保同目录唯一 basename）\n')
    sout(u'\n')
    sout(u'修复方式：用 Edit 工具把新文件里 [[<bad>]] 改成 [[<good>]]，然后再跑一次 postcheck\n')
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(u'--vault', metavar=u'VAULT_PATH',
                    help=u'vault 根路径（默认从 cwd 沿父目录找 .obsidian）')
    ap.add_argument(u'--snapshot', metavar=u'OUT_JSON',
                    help=u'snapshot 当前 unresolved 到文件')
    ap.add_argument(u'--snapshot-before', metavar=u'BEFORE_JSON',
                    help=u'与该 snapshot 对比')
    ap.add_argument(u'--new-file', metavar=u'REL_PATH',
                    help=u'刚写完的新文件相对 vault 的路径')
    args = ap.parse_args()

    cli_vault = _u(args.vault) if args.vault else None
    vault = resolve_vault(cli_vault)
    skill_dir = find_skill_dir()

    if args.snapshot:
        take_snapshot(args.snapshot, vault, skill_dir)
        return 0
    if args.snapshot_before and args.new_file:
        return diff_and_report(args.snapshot_before, args.new_file, vault, skill_dir)
    ap.print_help()
    sout(u'\n[ERROR] 必须传 --snapshot 或 (--snapshot-before + --new-file)\n')
    sys.exit(2)


if __name__ == '__main__':
    rc = main()
    if rc is None:
        rc = 0
    sys.exit(rc)
