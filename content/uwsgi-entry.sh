#!/bin/bash
# DefectDojo 主服务（平台封装）
#
# 职责：
#   1. 等 postgres / valkey 就绪（端口级 + 实际可用性）；
#   2. 跑 complete_initialization（建表 + 建管理员），失败无限重试，绝不退出容器
#      —— 平台容器没有 restart 策略，主进程退出 = 实例 ERROR = 审核判「启动报错」；
#   3. 把平台入口的 Origin 加进 CSRF 白名单（否则 https 下登录 POST 会 403）；
#   4. 初始化完成后 exec 官方 entrypoint 启动 uwsgi；
#   5. 启动期探针口（8082）：让平台健康检查在「迁移还没跑完」时就能通过，见下方注释。
set -u
cd /app

PGHOST="postgres.cloud.lazycat.app.defectdojo.lzcapp"
PGPORT=5432
UWSGI_SOCKET_PORT="${DD_UWSGI_PORT:-3031}"

# ---- 启动期健康探针（审核驳回 #20694「启动报错」的修复点）----
# 判据来自实机测量（acceptance/REPORT.md）：平台的实例状态 Starting→Running 只在
# 「本服务 healthcheck 首次通过」那一刻翻转。旧实现把 3031（uwsgi 监听）当判据，
# 而首装必须先跑完 Django 迁移才可能监听，实测本机 194~214s、评审机更慢；
# 这段时间实例一直停在 Starting，平台侧一旦超过自己的等待上限就落到它自己的
# 「应用状态错误」页（用户看到平台报错，而应用其实只是还在建库）。
#
# 现在把判据拆成两段，语义是「守护进程活着 + 该起的时候起得来」：
#   - 迁移期：8082 返回 200 且 body 里带当前阶段（waiting-postgres / migrating ...）
#     —— 容器活着、初始化在推进，就算健康，用户此时看到的是 nginx 的等待页（HTTP 200）；
#   - 迁移完成（phase=running）后：8082 额外探 3031，uwsgi 真挂了就返回 503，
#     平台照旧能判出「应用不健康」，不是永远返回 200 的空探针。
# 探针口挂掉（python 崩溃）由外层 while 拉起；容器退出时 PID 1 消失，探针自然不可达。
LZ_PHASE_PORT="${LZ_PHASE_PORT:-8082}"
LZ_PHASE_FILE="${LZ_PHASE_FILE:-/tmp/lz-phase}"
export LZ_PHASE_PORT LZ_PHASE_FILE UWSGI_SOCKET_PORT
lz_phase() { printf '%s\n' "${1:-unknown}" > "$LZ_PHASE_FILE" 2>/dev/null || true; }
lz_phase starting

cat > /tmp/lz-phase-server.py <<'PY'
"""启动期探针：报告初始化阶段；进入 running 后转发为 uwsgi 3031 的真实存活判定。"""
import http.server
import os
import socket
import socketserver

PHASE_FILE = os.environ.get("LZ_PHASE_FILE", "/tmp/lz-phase")
SOCK_PORT = int(os.environ.get("UWSGI_SOCKET_PORT", "3031"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            with open(PHASE_FILE, encoding="utf-8", errors="replace") as fh:
                phase = fh.read().strip() or "unknown"
        except OSError:
            phase = "unknown"
        code = 200
        if phase == "running":
            try:
                socket.create_connection(("127.0.0.1", SOCK_PORT), 5).close()
            except OSError:
                code, phase = 503, "uwsgi-socket-down"
        body = ("ok %s\n" % phase).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", int(os.environ.get("LZ_PHASE_PORT", "8082"))), Handler) as srv:
    srv.serve_forever()
PY

(
  while true; do
    python3 /tmp/lz-phase-server.py || true
    sleep 2
  done
) &

# ---- 平台入口有两个：公网域名（HTTPS）与 ingress 地址（http://app.<pkg>.lzcx，明文）----
# 浏览器实际用的 Origin 跟入口走，两种协议两个域名都要进白名单，
# 否则登录 POST 会被 Django 的 CSRF Origin 校验拦掉（403 Origin checking failed）。
ORIGINS=""
add_origin() {
  [ -n "${1:-}" ] || return 0
  case ",${ORIGINS}," in
    *",${1},"*) ;;
    *) ORIGINS="${ORIGINS:+${ORIGINS},}${1}" ;;
  esac
}
add_origin "https://${LAZYCAT_APP_DOMAIN:-}"
add_origin "http://${LAZYCAT_APP_DOMAIN:-}"
add_origin "https://${LZCAPP_SELF_INGRESS_ADDRESS:-}"
add_origin "http://${LZCAPP_SELF_INGRESS_ADDRESS:-}"

export DD_SITE_URL="https://${LAZYCAT_APP_DOMAIN:-localhost}"
export DD_CSRF_TRUSTED_ORIGINS="$ORIGINS"
export DD_SECURE_PROXY_SSL_HEADER="true"
export DD_ALLOWED_HOSTS="*"
echo "[lzc] CSRF trusted origins: ${DD_CSRF_TRUSTED_ORIGINS}"

# ---- 管理员账号：来自部署参数（manifest 渲染），渲染失败时回落到默认值 ----
# 渲染失败的形态是空串或字面量 "<no value>"，这两种都要按「没配」处理，
# 否则管理员密码会变成 "<no value>"，界面上直接露出来。
sanitize() {
  case "${1:-}" in
    ""|*"<no value>"*) return 1 ;;
    *) return 0 ;;
  esac
}
if ! sanitize "${DD_ADMIN_USER:-}"; then export DD_ADMIN_USER="admin"; fi
if ! sanitize "${DD_ADMIN_PASSWORD:-}"; then export DD_ADMIN_PASSWORD="DefectDojo@2026"; fi
if ! sanitize "${DD_ADMIN_MAIL:-}"; then export DD_ADMIN_MAIL="admin@defectdojo.local"; fi
echo "[lzc] admin user: ${DD_ADMIN_USER}"

lz_phase waiting-postgres
echo "[lzc] waiting for postgres ${PGHOST}:${PGPORT} ..."
until (echo > /dev/tcp/${PGHOST}/${PGPORT}) 2>/dev/null; do sleep 3; done
echo "[lzc] postgres port is open"
sleep 8
umask 0002

lz_phase migrating
echo "[lzc] running complete_initialization (db migrate + admin user) ..."
n=0
until python3 manage.py complete_initialization; do
  n=$((n + 1))
  echo "[lzc] complete_initialization attempt ${n} failed, retry in 15s"
  sleep 15
done

echo "[lzc] initialization finished, starting uwsgi"
# 初始化完成的标记：入口 nginx 看到这个文件才把上游从「等待页」切到真实 uwsgi。
# 之所以用标记文件而不是探测 uwsgi 端口：镜像的 --http 8081 liveness 口在本环境下
# 会挂起（实测 curl 90s 无响应），而「迁移跑完」才是首次打开要等的那个长任务。
mkdir -p /lzcapp/var/ready 2>/dev/null || true
date +%s > /lzcapp/var/ready/db_ready 2>/dev/null || true
# 迁移完成：探针转入「必须能连上 3031」模式，然后交棒给官方 entrypoint。
lz_phase running
exec /entrypoint-uwsgi.sh
