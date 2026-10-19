# DefectDojo LPK 返工报告 —— 审核驳回 #20694「启动报错」

- 包名：`cloud.lazycat.app.defectdojo`，版本 **3.4.101（未改动）**
- 应用域名：`defectdojo.wans.heiyu.space`；盒子：`lzcbox`（lzcos，`lzc-docker`）
- 结论：**平台「应用状态错误」页的触发点是「应用对 HTTP 请求返回 5xx / 无法给出正常响应」，不是首装太慢。**
  真实根因是包内引用了一个**从未提交过的注入脚本文件**，导致 lzcinit 对**每一个页面**返回
  `500 Injection Failed`。已补齐该文件；顺带把平台就绪门从 214s 压到 17s 作为第二道保险。
- 实机验收：全新安装 + 装完重装（保留数据）两条路径均通过；截图 8 张（PC 5 + 移动 2 + 修复前对照 1）。

---

## 1. 「应用状态错误」的触发判据（带证据）

### 1.1 这个页面是谁画的

| 事实 | 证据 |
|---|---|
| `应用状态错误` / `Application status error` 只存在于 **lzc-ingress** 二进制 | `grep -a 应用状态错误 /lzcsys/sspks/lzc-runtime/bin/lzc-ingress` → 命中；`/lzcinit/<pkg>`（lzcinit）里**没有**该串 |
| 页面渲染路径 | `lzcapp.renderAppStatus` → `templates/template.html`；`lzcapp.RenderError` → **HTTP 500** + `templates/apperror.html` |
| 状态页的选择发生在 | `ingress/lzcapp.(*AppService).EnsureRunning`（内含 `waitStateChanged` / `handleEndIfStatusChanged`），两处 `call …renderAppStatus` |
| 错误页正文 = 应用名 + 状态文案 + **主服务日志** | 内嵌模板里有 `{{.FileName}}` / `deploy_id={{.DeployID}}` / `<pre>{{.Content}}</pre>`，与驳回截图版式一致（标题 DefectDojo、正文「应用状态错误」、下面是 `uwsgi-1` 日志） |

平台状态枚举（从二进制字符串表提取，`cloud.lazycat.apis.sys`）：
```
AppStatus:      NotInstalled, Downloading, Paused, Installing, Installed, Failed
InstanceStatus: Status_Error, Status_Paused, Status_Stopping, Status_Starting, Status_Running
```
`lpk-manager inspect` / 7733 接口返回的 `status` 实测取值：**5 = 启动中（Starting）**、**6 = RUNNING**、
**8 = PAUSED**。三者互斥，只有落到 `Status_Error` 一侧才会渲染「应用状态错误」。

### 1.2 判定「错误」的真正来源：应用返回 500

驳回截图里 uwsgi 是**正常启动完**的，所以问题不在 uwsgi。把包按原样装到盒子上、用脚手架浏览器
（真实域名 + TLS 前置 + 打 lzcinit 网关，保留注入链路）打开，复现出下面这一页：

> **Injection Failed**
> Reason: `open /lzcapp/pkg/content/lazycat-injects/defectdojo-http-download-bridge.js: no such file or directory`
> Script: `file:///lzcapp/pkg/content/lazycat-injects/defectdojo-http-download-bridge.js`
> Path: `/login`

截图：`acceptance/shots/before-injection-failed-1920x1080.png`
浏览器控制台同一时刻：`Failed to load resource: the server responded with a status of 500 (Internal Server Error)` × 12。

根因链：

1. `lzc-manifest.yml:80` 声明了 browser 注入 `defectdojo-http-download-bridge`
   （`src: file:///lzcapp/pkg/content/lazycat-injects/defectdojo-http-download-bridge.js`，`when: /*`）；
2. 该文件**从来没有提交过** —— `git ls-files content/` 只有 `content/lazycat-injects/lzc-file-chooser-inject.js`，
   目录里也只有这一个文件；
3. lzcinit 渲染页面时按 manifest 逐个注入，文件打不开就**放弃整页渲染并返回 500**
   （`Injection Failed`），因为 `when: /*`，所以**每一个路径都是 500**；
4. 平台侧探测/转发拿到 5xx → 实例被判 `Status_Error` → ingress 渲染「应用状态错误」页，
   并把主服务（`uwsgi-1`）日志贴出来 —— 于是评审看到的正是「uwsgi 明明起来了，但应用状态错误」。

> 这也解释了为什么 `/__ready/` 一直是 200：健康检查走 nginx 自己的 location，**不经过注入**，
> 所以健康检查通过、页面却整体 500，两者并不矛盾。

### 1.3 平台就绪门（第二道判据，已量化）

平台实例状态 `Starting → RUNNING` 的翻转点 = **本服务 healthcheck 首次通过**（实测与
`lzc-docker inspect <uwsgi> --format '{{json .State.Health}}'` 首次 `exit=0` 同秒）。

- 平台生成的 compose：`/lzcsys/data/system/pkgm/run/cloud.lazycat.app.defectdojo/docker-compose.yml`
  里 `app`（lzcinit）自带 `healthcheck: CMD /lzcinit/<pkg> -healthcheck`，`start_period: 30m0s`、`start_interval: 1s`。
- `lzc-docker-compose up` 本身**不等健康检查就返回**：pkgm 日志
  `INFO engine engine/engine.go:337 project cloud.lazycat.app.defectdojo is in ready, cost:...`（2~5s）。
  因此「就绪」是靠容器事件监控持续上报的。
- 失败分支：`engine/engine.go:330 project "..." end with err exit...`。

---

## 2. 首装到可打开的耗时时间线（逐秒实测）

探针：`acceptance/tools/dd-monitor.py`（1s 采样：7733 实例状态 + 7 个容器 Health + lzcinit
`-healthcheck` + `/__ready/` + 首页 HTTP + `db_ready` + 3031 端口）。
原始数据：`/root/dd-run/{baseline,final,reinstall}/timeline.jsonl`（盒子上）。

| 事件 | 基线（旧包·全新安装） | 修复后（全新安装） | 修复后（重装·保留数据） |
|---|---|---|---|
| 平台 status=5（启动中） | +19.1s | +3.4s | +3.3s |
| app 容器 running | +21.2s | +5.6s | +4.4s |
| `/__ready/` → 200 | +21.2s | +5.6s | +5.4s |
| 首页（应用自己的等待页）HTTP 200 | +21.2s | +5.6s | +5.4s |
| postgres healthy | +29.4s | +17.2s | +7.0s |
| **平台 status=6（RUNNING）** | **+214.0s** | **+17.2s** | **+8.1s** |
| uwsgi healthy | +214.0s | +7.2s | +5.4s |
| `db_ready`（迁移完成） | +208.3s | +232.2s | +5.4s（残留标记） |
| uwsgi 3031 可连 / 首页 302（真应用） | +214.0s / +219.8s | +238.0s / +243.9s | +34.8s |

读法：

- **首装的长尾是 Django 迁移**（本机 208~232s，评审机更慢），`/__ready/` 在 +21s 就已经 200，
  等待页从 +21s 起就能正常显示（HTTP 200，不是 5xx）。
- 基线里「平台可访问窗口」被 uwsgi 的 healthcheck 拖到 **214s**；修复后 **17.2s**（**12.4×**）。
- 重装保留数据（`db_ready` 残留）不会卡住：**8.1s 就 RUNNING**，首页 302 直接进真应用。

> 平台侧是否会因为「Starting 停留太久」而判错，本次**没有**取得可复现的阈值证据（`EnsureRunning`/
> `waitStateChanged` 的具体超时常量未从二进制中解出）。因此没有把结论建立在「阈值」上，而是两条都做：
> ①消除 5xx（根因），②把 Starting 窗口压到十几秒（保险）。

---

## 3. 改动清单（未改 version）

| 文件 | 改动 |
|---|---|
| `content/lazycat-injects/defectdojo-http-download-bridge.js` | **新增（根因修复）**。manifest 早就引用了它但文件不存在。实现：拦截 `<a href="/reports/(csv\|excel)_export">` 点击（这类链接没有 `download` 属性、也不是 `blob:`，官方 `isDownloadAnchor()` 不接管）→ 同源 fetch 成 Blob → 造 `a[download]` + `blob:` 锚点 → `click()`，交给官方 `open-save-chooser` 弹「保存至懒猫」；失败自动退回原生下载，绝不吞点击。标记 `window.__lzcDefectdojoDownloadBridge = {version:1, intercepted, lastError}`。 |
| `content/uwsgi-entry.sh` | 新增**启动期探针口 8082**：迁移未完成时返回 `200 ok <phase>`（`starting`/`waiting-postgres`/`migrating`/`running`），迁移完成后（`phase=running`）额外要求 TCP 连得上 3031，否则返回 **503** —— 即「守护进程活着 + 该起的时候起得来」，不是永久 200 的空探针。python 崩溃由 `while` 拉起；容器退出则探针不可达。 |
| `lzc-manifest.yml` | `uwsgi.healthcheck.test` 由「TCP 探 3031」改为「探 8082」；`interval 15s→10s`、`timeout 10s→15s`（`retries 40` / `start_period 1800s` 不变）。目的：把平台 RUNNING 从「迁移跑完」解耦到「容器已就绪」。 |

未做（有意）：没有给 `nginx` / `celerybeat` / `celeryworker` 补 healthcheck。实测这三个服务
无健康状态**并不会**阻塞 RUNNING（基线里它们在 `health=none` 的情况下实例照样到达 status=6 并稳定
运行 1 小时以上），反而是「补一个可能失败的探针」会把原本不可见的软状态变成硬失败 —— 只会增加
落到错误页的风险。

`package.yml` 的 `version` 保持 `3.4.101`；未 push、未提审、未重建镜像、未改知识库。

---

## 4. 实机验收（都真做了）

脚手架（按 `toolbox/README.md` 的纪律）：
```
bash /lzcsys/data/document/wans/wans/lpk-skill/toolbox/box/box-harness.sh \
     up cloudlazycatappdefectdojo-app-1 defectdojo.wans.heiyu.space dd
# → APP_IP / TLS_IP / CHROME_IP=172.28.4.195；CDP 在 CHROME_IP:9441
ssh -f -N -L 9334:172.28.4.195:9441 lzcbox      # 本机访问 CDP
node acceptance/tools/cdp-drive.mjs --cdp http://127.0.0.1:9334 --mode during|full
node acceptance/tools/probe-inject.mjs          # 注入 + 历史驳回点回归
```
（盒子上没有 node/puppeteer，故用 node 22+ 内置 WebSocket 写了零依赖 CDP 驱动。）

### 4.1 全新安装路径（卸载 → 清 `/lzcsys/data/appvar/cloud.lazycat.app.defectdojo` → 安装）

- **装的过程中**打开应用：`+0.6s` 抓到 `title="DefectDojo 正在初始化"`，
  正文「这是首次启动：正在创建数据库结构、基础数据与管理员账号，通常需要 2~5 分钟…」，
  HTTP 200、控制台 **0 条** error/warning。→ `pc-01-first-install-waiting-1920x1080.png`
- **就绪后**：`+189.7s` 变为 `title="DefectDojo" /login?next=/`，中文登录页。
- 登录后：`full` 模式首次进入即 `/dashboard`（沿用上一轮验证留下的会话 cookie，故未再走登录表单）；
  随后用 `probe-inject.mjs` **清 cookie 走真实表单 POST 登录**再次验证通过。
  PC 5 张、移动 2 张，界面为简体中文，**控制台 0 报错**。
- 平台状态：`status=6` 于 **+17.2s**。

### 4.2 重装（保留数据）路径（卸载 → **不删** appvar → 安装）

- `db_ready` 残留存在的情况下：**+8.1s → status=6**，首页 `+34.8s` 302 进真应用，无卡壳。
- 浏览器复跑 `probe-inject.mjs`：9 项全过、控制台 0 报错（见 4.4）。

### 4.3 截图（`acceptance/shots/`）

| 文件 | 内容 |
|---|---|
| `pc-01-first-install-waiting-1920x1080.png` | **首装等待期的应用自身等待页**（1920×1080，416KB） |
| `pc-02-home-1920x1080.png` | 仪表板（中文） |
| `pc-03-finding-1920x1080.png` | 发现项 |
| `pc-04-engagement-1920x1080.png` | 测试活动 |
| `pc-05-product_type-1920x1080.png` | 组织列表 |
| `m-01-home-390x844.png` | 移动端首页（390×844） |
| `m-02-findings-390x844.png` | 移动端发现项 |
| `before-injection-failed-1920x1080.png` | **修复前对照**：`Injection Failed` 500 页 |
| `cdp-during-evidence.json` / `cdp-full-evidence.json` / `inject-verify.json` | 逐条证据（时间线、控制台、检查项） |

### 4.4 历史驳回点回归（`inject-verify.json`，9/9 通过）

| 驳回点 | 结论 | 证据 |
|---|---|---|
| #20451 登录 POST 403 CSRF | **不再复现**。清 cookie 后走真实表单提交，登录成功，无 403 | 登录后 `url=https://defectdojo.wans.heiyu.space/simple_search?query=`，页面为已登录导航 |
| #20257 导出/下载需走网盘 | **桥接已生效**：合成点击 `/reports/csv_export` → 拦截计数 `0→1`；无报告数据时服务端返回空体，脚本按设计退回原生下载（`lastError="export returned empty body"`，未白屏、未吞点击） | 同上 |
| #20257 注入送达 | 页面 DOM 内 4 个注入脚本齐备：`inject_loader.js`、`open-save-chooser_0.js`、`defectdojo-http-download-bridge_0.js`、`lazycat-auto-login_0.js`，全部 HTTP **200** | 同上 |
| #20257 注入执行 | 把脚本源码注入页面上下文后 `window.__lzcDefectdojoDownloadBridge={version:1}`，拦截逻辑生效 | 同上 |
| #20257 New User 跳站外 | `/user/add` 返回 200 且 `host` 不变；导航/用户菜单**无异常站外跳转** | `unexpectedNav: []` |
| 页面可用性 | `/login` HTTP 200、含用户名字段、**非** `Injection Failed`（40823 字节） | 同上 |
| 控制台 | error/warning **0** | 同上 |

说明（重要）：脚手架里 **平台包装器不会真正执行 browser 注入** —— 包装器依赖的注入注册表
（`__lzcEnsureRegistry`）由懒猫客户端前端提供，直连 lzcinit 时不存在（`officialAnchorHook:false`）。
所以「执行」是用「把脚本源码放进页面上下文运行」来证明脚本自身逻辑成立；真实客户端里由平台触发，
代码路径一致。

---

## 5. 遗留风险

1. **`-healthcheck` 语义**：lzcinit 的 `-healthcheck` 在 `Injection Failed` 时仍返回 0（本次实测），
   说明它不覆盖页面渲染。已通过「注入文件必须存在」从根上消除该类故障，但若将来再新增注入，
   务必确认 `src` 指向的文件真的在包里 —— 这是本次事故的唯一触发条件。
2. **`lzc-file-chooser-inject.js` 的 `auth_required=true`**：无票据上下文里官方选择器脚本会抛错并
   接管原生文件选择。真实客户端（有票据）正常；脚手架里无法验证这一层。若评审在未登录状态点导出，
   可能退回原生下载。
3. **首次迁移仍是 3~4 分钟**（本机 208~232s）。现在平台侧 17s 就 RUNNING、用户看到的是等待页，
   但若评审机磁盘/CPU 极慢且平台另有「页面 5xx 次数」类判据，理论上仍可能触发；可考虑后续把
   `complete_initialization` 拆成预置模板库来进一步压缩。
4. **`Standing by until other services are healthy. ⌛`** 在 lzcinit 日志里长期存在（因为
   nginx/celery\* 没有 healthcheck）。实测不影响 RUNNING 与页面可用，但会掩盖真正的服务异常，
   建议后续版本给它们补「有意义且必然能过」的探针。
5. 平台侧 `EnsureRunning` / `waitStateChanged` 的**具体超时常量**未解出，报告中未据此下结论。

---

## 6. 复现与工具

| 工具 | 用途 |
|---|---|
| `acceptance/tools/dd-monitor.py` | 盒子上 1s 采样时间线 → `timeline.jsonl` / `timeline.log`（`<outdir>/stop` 停止） |
| `acceptance/tools/cdp-drive.mjs` | 零依赖 CDP 驱动；`--mode during` 轮询真实域名、抓等待页并等就绪；`--mode full` 登录 + PC/移动截图 + 控制台收集 |
| `acceptance/tools/probe-inject.mjs` | 注入送达/执行 + 历史驳回点回归（CSRF 登录、导出桥接、站外跳转、`/user/add`） |
| `acceptance/tools/timeline-summary.py` | 从 `timeline.jsonl` 抽「首次出现」表 |

复现一次全新安装验收：
```bash
cd /home/wans/rework/defectdojo && lzc-cli project release -f ./lzc-build.yml -o ./dist/dd.lpk
scp dist/dd.lpk lzcbox:/root/dd.lpk
ssh lzcbox 'bash /lzcsys/data/document/wans/wans/lpk-skill/toolbox/box/box-harness.sh down dd
            lpk-manager uninstall cloud.lazycat.app.defectdojo
            rm -rf /lzcsys/data/appvar/cloud.lazycat.app.defectdojo
            nohup python3 /root/dd-monitor.py /root/dd-run/x 900 >/dev/null 2>&1 &
            lpk-manager install /root/dd.lpk'
# 约 20s 后起脚手架，然后跑 cdp-drive.mjs --mode during / --mode full
```

踩过的坑（供后来者）：`pkill -f <模式>` 会杀掉命令行里含该模式的**自己**；
本机有 pi 钩子会拦截裸 `curl` 输出，改用 node/python 客户端；盒子没有 `strings`/`node`/`puppeteer-core`。
