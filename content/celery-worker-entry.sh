#!/bin/bash
# celery worker：等 DB 与主服务起来后再启动（避免表还没迁移完就报错）
set -u
cd /app
PGHOST="postgres.cloud.lazycat.app.defectdojo.lzcapp"
APP="uwsgi.cloud.lazycat.app.defectdojo.lzcapp"

echo "[lzc] waiting for postgres ..."
until (echo > /dev/tcp/${PGHOST}/5432) 2>/dev/null; do sleep 3; done

echo "[lzc] waiting for app (${APP}:8081) ..."
until (echo > /dev/tcp/${APP}/8081) 2>/dev/null; do sleep 5; done

echo "[lzc] starting celery worker"
exec /entrypoint-celery-worker.sh
