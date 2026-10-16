#!/bin/bash
# DefectDojo 主服务（平台封装）
#
# 职责：
#   1. 等 postgres / valkey 就绪（端口级 + 实际可用性）；
#   2. 跑 complete_initialization（建表 + 建管理员），失败无限重试，绝不退出容器
#      —— 平台容器没有 restart 策略，主进程退出 = 实例 ERROR = 审核判「启动报错」；
#   3. 把平台入口的 Origin 加进 CSRF 白名单（否则 https 下登录 POST 会 403）；
#   4. 初始化完成后 exec 官方 entrypoint 启动 uwsgi。
set -u
cd /app

PGHOST="postgres.cloud.lazycat.app.defectdojo.lzcapp"
PGPORT=5432

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

echo "[lzc] waiting for postgres ${PGHOST}:${PGPORT} ..."
until (echo > /dev/tcp/${PGHOST}/${PGPORT}) 2>/dev/null; do sleep 3; done
echo "[lzc] postgres port is open"
sleep 8
umask 0002

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
exec /entrypoint-uwsgi.sh
