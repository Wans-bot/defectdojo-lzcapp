#!/usr/bin/env python3
"""DefectDojo LPK 首装/启动时间线探针（在盒子上跑）。

每 1s 采样一次平台与应用两侧的真实状态，产出可直接引用的时间线证据：
  - 平台侧：lpk-manager/7733 的 instance status（0=Status_Error … 见 STATUS_NAME）
  - 容器侧：7 个容器的 State/Health（是否 healthy / 有无 healthcheck）
  - 应用侧：lzcinit 的 -healthcheck 退出码、nginx /__ready/ 状态码、
            首页经 nginx 的 HTTP 码、db_ready 标记、uwsgi 3031 端口

用法: dd-monitor.py <输出目录> [最长秒数]
停止: 在输出目录创建文件 stop（或到时自动停）
"""
import json
import os
import subprocess
import sys
import time

PKG = "cloud.lazycat.app.defectdojo"
APP = "cloudlazycatappdefectdojo-app-1"
NGINX = "cloudlazycatappdefectdojo-nginx-1"
UWSGI = "cloudlazycatappdefectdojo-uwsgi-1"
PREFIX = "cloudlazycatappdefectdojo-"
ENV = dict(os.environ, DOCKER_HOST="unix:///lzcsys/run/lzc-docker/docker.sock")
SERVICES = ["app", "postgres", "valkey", "nginx", "uwsgi", "celerybeat", "celeryworker"]

# InstanceStatus 枚举（lzc-sdk proto: Status_Error=0 … Status_Running=4；
# REST 层另有 6=RUNNING / 8=PAUSED，实测见 acceptance/REPORT.md）
STATUS_NAME = {
    "0": "Status_Error", "1": "Status_Paused", "2": "Status_Stopping",
    "3": "Status_Starting", "4": "Status_Running", "6": "RUNNING", "8": "PAUSED",
    "None": "unreachable",
}

# 需要 shell 语义的固定命令串（无任何插值，避免注入面）
SH_DOCKER_PS = ["lzc-docker", "ps", "-a", "--format", "{{.Names}}|{{.State}}|{{.Status}}"]
SH_UWSGI_PORT = ["lzc-docker", "exec", UWSGI, "bash", "-c",
                 "</dev/tcp/127.0.0.1/3031 && echo up || echo down"]


def run(args, timeout=10):
    """执行固定 argv（不做 shell 插值）。"""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           env=ENV, check=False)
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except OSError as e:
        return 125, "", str(e)


def instance_status():
    rc, out, _ = run(["curl", "-s", "--max-time", "3",
                      f"http://127.0.0.1:7733/api/app/instance/status?id={PKG}"])
    if rc != 0 or not out:
        return None
    try:
        d = json.loads(out)
    except ValueError:
        return None
    return d.get("status") if isinstance(d, dict) else None


def container_states():
    rc, out, _ = run(SH_DOCKER_PS, timeout=15)
    seen = {}
    if rc == 0:
        for line in out.splitlines():
            if not line.startswith(PREFIX):
                continue
            parts = line.split("|")
            if len(parts) < 3:
                continue
            name = parts[0][len(PREFIX):]
            name = name.rsplit("-1", 1)[0]
            stat = parts[2]
            if "(unhealthy)" in stat:
                health = "unhealthy"
            elif "(healthy)" in stat:
                health = "healthy"
            elif "(health: starting)" in stat:
                health = "starting"
            else:
                health = "none"  # 无 healthcheck
            seen[name] = {"state": parts[1], "health": health}
    return {s: seen.get(s, {"state": "absent", "health": "absent"}) for s in SERVICES}


def probe_app():
    """应用侧探针：全部在容器内执行，避免宿主解析差异。"""
    out = {}
    rc, _, _ = run(["lzc-docker", "exec", APP, f"/lzcinit/{PKG}", "-healthcheck"], timeout=25)
    out["lzcinit_healthcheck"] = rc
    rc, o, _ = run(["lzc-docker", "exec", NGINX, "curl", "-s", "-o", "/dev/null", "-m", "4",
                    "-w", "%{http_code}", "http://127.0.0.1:8080/__ready/"], timeout=15)
    out["ready_endpoint"] = o or ("rc%d" % rc)
    rc, o, _ = run(["lzc-docker", "exec", NGINX, "curl", "-s", "-o", "/dev/null", "-m", "6",
                    "-w", "%{http_code}", "-H", "Host: defectdojo.wans.heiyu.space",
                    "http://127.0.0.1:8080/"], timeout=20)
    out["home_via_nginx"] = o or ("rc%d" % rc)
    rc, _, _ = run(["lzc-docker", "exec", NGINX, "ls", "/lzcapp/var/ready/db_ready"], timeout=10)
    out["db_ready"] = "yes" if rc == 0 else "no"
    rc, o, _ = run(SH_UWSGI_PORT, timeout=15)
    lines = o.splitlines()
    out["uwsgi_3031"] = lines[-1] if lines else "?"
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: dd-monitor.py <outdir> [maxsec]", file=sys.stderr)
        return 2
    outdir = sys.argv[1]
    maxsec = int(sys.argv[2]) if len(sys.argv) > 2 else 1800
    try:
        os.makedirs(outdir, exist_ok=True)
    except OSError as e:
        print(f"cannot create {outdir}: {e}", file=sys.stderr)
        return 1
    stopfile = os.path.join(outdir, "stop")
    tl_path = os.path.join(outdir, "timeline.jsonl")
    human_path = os.path.join(outdir, "timeline.log")
    try:
        tl = open(tl_path, "a", encoding="utf-8")
        human = open(human_path, "a", encoding="utf-8")
    except OSError as e:
        print(f"cannot open logs: {e}", file=sys.stderr)
        return 1

    def emit(line):
        human.write(line + "\n")
        human.flush()

    t0 = time.time()
    emit(f"# monitor start {time.strftime('%Y-%m-%dT%H:%M:%S%z')}")
    last_probe = -999.0
    prev_sig = ""
    while time.time() - t0 < maxsec:
        el = time.time() - t0
        st = instance_status()
        cs = container_states()
        rec = {"t": round(el, 1), "clock": time.strftime("%H:%M:%S"), "status": st,
               "status_name": STATUS_NAME.get(str(st), str(st)), "containers": cs}
        sig = json.dumps([st] + [[s, cs[s]["state"], cs[s]["health"]] for s in SERVICES])
        if sig != prev_sig:
            prev_sig = sig
            emit(f"+{el:7.1f}s {rec['clock']} STATUS={rec['status']}({rec['status_name']}) "
                 + " ".join(f"{s}={cs[s]['state']}/{cs[s]['health']}" for s in SERVICES))
        if el - last_probe >= 5:
            last_probe = el
            rec["probe"] = probe_app()
            emit(f"+{el:7.1f}s {rec['clock']}   probe: " + json.dumps(rec["probe"]))
        tl.write(json.dumps(rec, ensure_ascii=False) + "\n")
        tl.flush()
        if os.path.exists(stopfile):
            emit(f"+{el:7.1f}s stop file found")
            break
        time.sleep(1)
    emit(f"# monitor end +{time.time() - t0:.1f}s")
    tl.close()
    human.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
