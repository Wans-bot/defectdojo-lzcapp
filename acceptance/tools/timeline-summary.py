#!/usr/bin/env python3
"""从 monitor 的 timeline.jsonl 里抽出「首次出现」时间点，用于报告里的耗时时间线。"""
import json
import sys


def load_rows(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError as exc:
        print("cannot read %s: %s" % (path, exc), file=sys.stderr)
        return rows
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue  # 半行/损坏行直接跳过，不影响其它采样点
    return rows


def firsts(path, label):
    rows = load_rows(path)
    if not rows:
        print("== %s == (no samples)" % label)
        return
    out = {}

    def note(key, t):
        if key not in out:
            out[key] = t

    for r in rows:
        p = r.get("probe") or {}
        if p.get("ready_endpoint") == "200":
            note("/__ready/ 返回 200", r["t"])
        if p.get("db_ready") == "yes":
            note("db_ready 标记存在", r["t"])
        if p.get("uwsgi_3031") == "up":
            note("uwsgi 3031 可连", r["t"])
        home = p.get("home_via_nginx")
        if home in ("200", "302"):
            note("首页 HTTP " + str(home), r["t"])
        if p.get("lzcinit_healthcheck") == 0:
            note("lzcinit -healthcheck=0", r["t"])
        if r.get("status") == 5:
            note("平台 status=5 (Starting)", r["t"])
        if r.get("status") == 6:
            note("平台 status=6 (RUNNING)", r["t"])
        c = r["containers"]
        if c["app"]["state"] == "running":
            note("app 容器 running", r["t"])
        if c["uwsgi"]["health"] == "healthy":
            note("uwsgi healthy", r["t"])
        if c["postgres"]["health"] == "healthy":
            note("postgres healthy", r["t"])
    print("== %s ==" % label)
    for key in sorted(out, key=lambda k: out[k]):
        print("  +%7.1fs  %s" % (out[key], key))
    print()


for arg in sys.argv[1:]:
    path, _, label = arg.partition("=")
    firsts(path, label or path)
