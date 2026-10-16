#!/bin/sh
# DefectDojo 入口 nginx（平台封装）
#
# 审核驳回原文：「启动报错」（review 19335，审核截图：app: unhealthy +
# "Health check not successful: HTTP status is not 200: 502"）。
# 根因：首次安装时 uwsgi 必须先跑完数据库迁移再监听端口（实机实测 3~4 分钟），
# 这段时间 nginx 虽在运行，但上游连不上 → 网关拿到 502 → 应用被判「启动报错」。
#
# 本脚本让整个启动过程都不出现 5xx：
#   1. nginx 立即启动（上游域名没解析出来也不退出）；
#   2. 给 8080 打补丁：加 /__ready/ 健康检查端点（nginx 起来即 200，不依赖 uwsgi），
#      并把上游不可用时的 502/503/504 换成 /__warming/ 静态等待页（HTTP 200，
#      每 6 秒自动刷新）——首装那几分钟用户看到的是「正在初始化」而不是报错页；
#   3. 后台守护探测 uwsgi 的 liveness 口（8081）返回 200 后，把 upstream 换成真实
#      地址并 nginx -s reload，用户下一次刷新就进 DefectDojo；
#   4. nginx 进程退出会被拉起（平台容器没有 restart 策略，退出即实例异常）。
set -u

HOST="uwsgi.cloud.lazycat.app.defectdojo.lzcapp"
PORT="${DD_UWSGI_PORT:-3031}"
log() { echo "[lzc][nginx] $*"; }

mkdir -p /run/defectdojo 2>/dev/null || true

# ---- 1) 给镜像自带配置打补丁 ----
patch_conf() {
  cfg="$1"
  [ -f "$cfg" ] || return 0
  grep -q "lzc-warming" "$cfg" && return 0
  awk '
    /listen[ \t]+8080;/ {
      print;
      print "    # lzc-warming: 健康检查端点，nginx 就绪即 200，不依赖 uwsgi";
      print "    location = /__ready/ { default_type text/plain; return 200 \"ok\"; }";
      print "    # lzc-warming: 首装迁移期的等待页（静态文件，由下面的 error_page 内部跳转进入）";
      print "    location /__warming/ { alias /lzcapp/pkg/content/warming/; index index.html; }";
      next
    }
    /error_page[ \t]+500[ \t]+502[ \t]+503[ \t]+504[ \t]+\/50x\.html;/ {
      print "    # lzc-warming: 上游未就绪（首装迁移期）给等待页而不是 502；真实 500 仍走 50x 页";
      print "    error_page 500 /50x.html;";
      print "    error_page 502 503 504 =200 /__warming/;";
      next
    }
    { print }
  ' "$cfg" > "$cfg.lzc" && cat "$cfg.lzc" > "$cfg" && rm -f "$cfg.lzc"
  log "patched $cfg"
}

for c in /etc/nginx/nginx.conf /etc/nginx/nginx_TLS.conf; do patch_conf "$c"; done

# ---- 2) 上游先指向保留地址：nginx 一定能解析、一定能启动，请求命中等待页 ----
export DD_UWSGI_HOST=127.0.0.1
export DD_UWSGI_PORT=9

(
  while true; do
    IP="$(getent ahostsv4 "$HOST" 2>/dev/null | awk 'NR==1{print $1}')"
    # 切换判据 = 「uwsgi 容器已跑完数据库初始化」（它在 exec uwsgi 前写了 db_ready 标记）
    # 且「3031 端口已可连接」。不用镜像的 --http 8081 liveness 口做判据：
    # 实测该端口在本环境下不返回响应（curl 挂起 90s），拿它当判据会让等待页永远切不过去。
    if [ -n "$IP" ] && [ -f /lzcapp/var/ready/db_ready ] && nc -z -w 3 "$IP" "$PORT" 2>/dev/null; then
      WANT="server $IP:$PORT;"
      if [ "$(cat /run/defectdojo/uwsgi_server 2>/dev/null)" != "$WANT" ]; then
        echo "$WANT" > /run/defectdojo/uwsgi_server
        log "uwsgi ready at $IP:$PORT, switching upstream"
        nginx -s reload 2>/dev/null || true
      fi
    fi
    sleep 5
  done
) &

# ---- 3) nginx 常驻 + 退出自动拉起 ----
while true; do
  /entrypoint-nginx.sh
  log "nginx exited (code $?), restarting in 5s"
  sleep 5
done
