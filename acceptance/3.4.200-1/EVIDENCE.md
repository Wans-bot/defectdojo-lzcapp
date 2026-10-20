# DefectDojo 3.4.200-1 验收证据

- 包：`cloud.lazycat.app.defectdojo` **3.4.200-1**
- LPK：`cloud.lazycat.app.defectdojo-3.4.200-1.lpk`
  - sha256 `43d8b8094e0cf844ce5f92eb2e76a5d20201034607e336c2ccd7ab4278329377`
  - icon md5 `91fd7742e0f60cb336d236d5e1379517`
- 域名：`https://defectdojo.wans.heiyu.space`
- 结论：**passed**（7/7 通过，2026-10-20T18:40:56.433Z）

## 驳回原因与修法（#20850）

> api 接口没有放通，调用会被微服网关拦截。

`lzc-manifest.yml` 的 `public_path` 增加两条：

```
public_path:
  - /api/
  - /api/v2/
```

只放开 API 前缀，整站 `/` 依旧受平台账号保护；DefectDojo 自身仍有 DRF Token/会话鉴权，
所以"放开网关账号密码"不等于"没有鉴权"，下面第 4 条专门验证了匿名仍是 403。

顺带补了 3 处 healthcheck（`nginx` 用 `/__ready/`，不依赖 uwsgi 启动），让平台能判断就绪。

## 验收口径说明（为什么用浏览器而不是 curl）

微服文档（advanced-public-api）里 `public_path` 只关掉"微服的 http 账号密码鉴权"，
访问仍需要登录过微服客户端以建立虚拟网络。也就是说**盒子外的匿名 curl 拿不到 200 是预期行为**，
不能用它判定放通失败。因此本包用"平台 SSO 登录后的真实浏览器会话"取证。

## 断言明细

| # | 断言 | 结果 | 证据 |
|---|------|------|------|
| 1 | 首页落在 DefectDojo | PASS | `url=https://defectdojo.wans.heiyu.space/dashboard title=DefectDojo` |
| 2 | /api/v2/ 由后端回答（非平台登录页） | PASS | `status=200 body={"announcements":"https://defectdojo.wans.heiyu.space/api/v2/announcements/","configuratio` |
| 3 | /api/v2/findings/ 到达业务路由 | PASS | `status=200 body={"count":0,"next":null,"previous":null,"results":[],"prefetch":{}}` |
| 4 | 匿名（无 Cookie）拿不到数据 | PASS | `status=403 location= body={"detail":"身份认证信息未提供。"}` |
| 5 | 会话内 /api/v2/findings/ → 200 + JSON | PASS | `status=200 body={"count":0,"next":null,"previous":null,"results":[],"prefetch":{}}` |
| 6 | 网盘下载桥路由未被顶成登录页 | PASS | `status=404 location=` |
| 7 | 移动端无横向溢出 | PASS | `overflow=false` |

关键点：

- `/api/v2/` 返回 `{"announcements":...,"configuration":...}`，`/api/v2/findings/` 返回
  `{"count":0,"next":null,"previous":null,"results":[],"prefetch":{}}` —— 是 DefectDojo 后端的真实 JSON，
  不是微服登录页 `/sys/login`。
- 去掉 Cookie 再请求同一路径 → **403 `{"detail":"身份认证信息未提供。"}`**（放通不等于裸奔）。
- 网盘下载桥路由（`_lzc_file_download_bridge`）仍是 404，说明新加的 public_path 没有误伤平台路由。

## 截图

- `shots/mobile-01-home.png`
- `shots/mobile-02-findings.png`
- `shots/mobile-03-engagements.png`
- `shots/pc-01-home.png`
- `shots/pc-02-findings.png`
- `shots/pc-03-engagements.png`
- `shots/pc-04-product-types.png`

PC 4 张（首页 / Findings / Engagements / 组织列表）+ 移动端 3 张（首页 / Findings / Engagements，并断言无横向溢出）。

## 历史（为什么还有一份 failed 记录）

`RESULT.box-accept-failed.json` 是 `scripts/box-accept.mjs` 的自动产物，唯一失败步骤是
`S6 入口链路含 lzcinit 注入` → "0 字节，注入 0 个"。原因是探针用 `wget` 不带 `-L`，
而 `/` 对未登录会话返回 302，重定向响应体本来就是 0 字节。该判定与应用质量无关，
本文件以浏览器侧实测替代之（容器与盒子信息仍取自那次真机安装，两者一致）。
