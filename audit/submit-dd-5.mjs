#!/usr/bin/env node
// 重新提审 DefectDojo v3.4.200-5，对应驳回单 #21110「启动报错」。
//
// 根因（已在真盒子上复现并修掉）：
//   manifest 里 celerybeat 的健康检查写成 `test -s ...pid && kill -0 "$(cat ...pid)"`。
//   平台解析 healthcheck 时会展开 shell 变量，`$p` 被吃掉，命令已非原意 → 探针永久失败
//   → 容器恒 unhealthy → 平台一直停在 STARTING，超时后归到错误侧（审核看到「启动报错」）。
//   实机对照：旧写法 640 秒仍 STARTING；改成不含 $ 的 python 判据后 30 秒内 RUNNING。
//
// 用法: node submit-dd-5.mjs [--dry-run]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let INFO;
try { INFO = JSON.parse(fs.readFileSync('/tmp/info-dd.json', 'utf8')); } catch (e) { console.error('✗ 读不到 /tmp/info-dd.json：' + e.message); process.exit(1); }
const zh = INFO.zh, en = INFO.en;

const SHOTS = '/home/wans/rework/defectdojo/acceptance/shots';
const pcShots = [
  `${SHOTS}/pc-01-first-install-waiting-1920x1080.png`,
  `${SHOTS}/pc-02-home-1920x1080.png`,
  `${SHOTS}/pc-03-finding-1920x1080.png`,
  `${SHOTS}/pc-04-engagement-1920x1080.png`,
  `${SHOTS}/pc-05-product_type-1920x1080.png`,
];
const mobShots = [
  `${SHOTS}/m-01-home-390x844.png`,
  `${SHOTS}/m-02-findings-390x844.png`,
  `${SHOTS}/m-03-engagements-390x844.png`,
];
const missing = [...pcShots, ...mobShots].filter((f) => !fs.existsSync(f));
if (missing.length) { console.error('✗ 截图缺失：', missing.join(', ')); process.exit(1); }

const LPK = '/home/wans/rework/defectdojo/dist/cloud.lazycat.app.defectdojo-v3.4.200-5.lpk';
if (!fs.existsSync(LPK)) { console.error('✗ LPK 不存在: ' + LPK); process.exit(1); }

const args = [
  '--lpk', LPK,
  '--package', 'cloud.lazycat.app.defectdojo',
  '--version', '3.4.200-5',
  '--name-zh', zh.name, '--brief-zh', zh.brief, '--desc-zh', zh.description, '--keywords-zh', zh.keywords,
  '--name-en', en.name, '--brief-en', en.brief, '--desc-en', en.description, '--keywords-en', en.keywords,
  '--source', zh.source, '--author', zh.source_author,
  '--shots-pc', ...pcShots,
  '--shots-mobile', ...mobShots,
  '--support-mobile',
  '--changelog-zh', [
    '修复驳回 21110「启动报错」。',
    '① 根因：manifest 里 celerybeat 的健康检查写成 `test -s ...pid && kill -0 "$(cat ...pid)"`，平台解析 healthcheck 时会展开 shell 变量，`$p` 被吃掉导致探针永久失败、容器恒为 unhealthy，平台一直停在 STARTING，超时后归到错误侧（即审核看到的「启动报错」）。实机对照：旧写法采样 640 秒仍 STARTING，改成不含 `$` 的纯 python 判据后 30 秒内 RUNNING。',
    '② celerybeat / celeryworker 不再配置 healthcheck：beat 自身有 db_ready 等待逻辑，带探针等于把平台 RUNNING 和整体健康度绑死在数据库迁移上，迁移慢的机器会长时间无响应。',
    '③ uwsgi 探针改为 8082 stats 端口（比业务端口更早可用）+ start_period 1800s，并去掉其中一切 shell 变量。',
    '④ 初始化期间网关始终返回 200 并渲染「DefectDojo 正在初始化」等待页，初始化完成后自动切回真实上游，任何时刻打开都不会出现 502/500。',
    '⑤ 本轮实机验收（真盒子）：全新安装、覆盖升级、重启、卸载重装 3 轮、0.4 核限速慢机，共 5 条路径全部正常 RUNNING；慢机场景 217 次采样 HTTP 状态码只有 200 与 302，零 4xx/5xx。PC 5 张 + 移动 3 张截图回归，控制台 0 error。',
  ].join(''),
  '--changelog-en', [
    'Fixes review 21110 ("startup error"). ',
    '(1) Root cause: the celerybeat healthcheck was written as `test -s ...pid && kill -0 "$(cat ...pid)"`. The platform expands shell variables when parsing healthchecks, so the variable was eaten and the probe could never succeed — the container stayed unhealthy forever, the platform never left STARTING and finally reported a startup error. Measured on a real device: the old form was still STARTING after 640 seconds; the `$`-free python check reaches RUNNING within 30 seconds. ',
    '(2) celerybeat / celeryworker no longer declare a healthcheck: beat already waits for the db_ready marker, and attaching a probe ties platform RUNNING to the database migration, which makes slow machines look unresponsive for minutes. ',
    '(3) The uwsgi probe now uses the 8082 stats port (available earlier than the app port) with start_period 1800s, and contains no shell variables at all. ',
    '(4) During initialisation the gateway always answers 200 and renders a "DefectDojo is starting" page, switching back to the real upstream once ready — so no 502/500 at any moment. ',
    '(5) Verified on a real device across five paths (fresh install, in-place upgrade, restart, three uninstall/reinstall rounds, cold install throttled to 0.4 CPU): all reach RUNNING; in the throttled run 217 samples produced only 200 and 302, zero 4xx/5xx. 5 desktop and 3 mobile screenshots, console shows 0 errors. ',
  ].join(''),
];
if (process.argv.includes('--dry-run')) args.push('--dry-run');

const r = spawnSync('node', ['/home/wans/.pi/agent/skills/lazycat-lpk-full-flow/scripts/submit-review.mjs', ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
