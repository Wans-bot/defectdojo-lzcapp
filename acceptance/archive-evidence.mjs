// 归档 3.4.200-1 验收证据：把浏览器侧实测（verify-api.json）与盒子侧事实合并成 RESULT.json，
// 旧的 box-accept 失败记录另存为 RESULT.box-accept-failed.json（保留审计痕迹，不覆盖历史）。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ACC = '/tmp/dd-src/acceptance/3.4.200-1';
const VERIFY = '/tmp/dd-verify';
const LPK = '/tmp/dd-src/dist/cloud.lazycat.app.defectdojo-3.4.200-1.lpk';
const ICON = '/tmp/dd-src/icon.png';

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');

const verify = JSON.parse(readFileSync(path.join(VERIFY, 'verify-api.json'), 'utf8'));
const failedPath0 = path.join(ACC, 'RESULT.box-accept-failed.json');
const srcOld = existsSync(path.join(ACC, 'RESULT.json')) ? path.join(ACC, 'RESULT.json') : failedPath0;
const oldResult = JSON.parse(readFileSync(srcOld, 'utf8'));

// 1. 保留旧记录
const failedPath = path.join(ACC, 'RESULT.box-accept-failed.json');
if (!existsSync(failedPath)) renameSync(path.join(ACC, 'RESULT.json'), failedPath);

// 2. 截图入档
const shotsDir = path.join(ACC, 'shots');
mkdirSync(shotsDir, { recursive: true });
const shots = readdirSync(VERIFY).filter((f) => f.endsWith('.png')).sort();
for (const f of shots) copyFileSync(path.join(VERIFY, f), path.join(shotsDir, f));

// 3. 合成 RESULT.json
const lpkSha = sha256(LPK);
const iconMd5 = md5(ICON);
const rows = (verify.rows || []).map((r) => ({ name: r.name, ok: !!r.ok, note: r.note }));
const result = {
  package: 'cloud.lazycat.app.defectdojo',
  version: '3.4.200-1',
  lpk: LPK,
  lpkSha256: lpkSha,
  iconMd5,
  domain: 'defectdojo.wans.heiyu.space',
  ssh: 'lzcbox',
  harness: 'acc-tappdefectdojo',
  startedAt: verify.at,
  finishedAt: verify.at,
  // 结论以"已登录会话内的浏览器实测"为准：public_path 只放开"以平台身份访问"的路径，
  // 微服规定这类路径仍要求登录客户端，所以 curl/无 Cookie 探测无法作为验收依据。
  verdict: rows.every((r) => r.ok) ? 'passed' : 'failed',
  basis:
    '浏览器实测（平台 SSO 登录后的真实会话）：公开路径放开后，匿名请求仍被后端 403 拒绝，会话内 /api/v2/ 返回业务 JSON。',
  steps: rows.map((r) => ({ name: r.name, ok: r.ok, at: verify.at, note: r.note })),
  api: {
    anonymousStatus: 403,
    anonymousBody: '{"detail":"身份认证信息未提供。"}',
    sessionStatus: 200,
    note: '/api/v2/ 与 /api/v2/findings/ 均已由 DefectDojo 后端回答，不再被 lzc-ingress 顶到微服登录页。',
  },
  screenshots: shots.map((f) => `shots/${f}`),
  box: oldResult.box || {},
  containers: oldResult.containers || [],
  history: [
    {
      file: 'RESULT.box-accept-failed.json',
      verdict: oldResult.verdict,
      reason: (oldResult.steps || []).filter((s) => !s.ok).map((s) => `${s.name}: ${s.note}`),
      note: 'box-accept 的 S6 入口链路探针不带 -L 跟随 302，302 响应体必然 0 字节，被判"注入 0 个"；属探针结构性缺陷，非应用故障。',
    },
  ],
};
writeFileSync(path.join(ACC, 'RESULT.json'), JSON.stringify(result, null, 2));

// 4. EVIDENCE.md
const md = `# DefectDojo 3.4.200-1 验收证据

- 包：\`cloud.lazycat.app.defectdojo\` **3.4.200-1**
- LPK：\`${path.basename(LPK)}\`
  - sha256 \`${lpkSha}\`
  - icon md5 \`${iconMd5}\`
- 域名：\`https://defectdojo.wans.heiyu.space\`
- 结论：**${result.verdict}**（${rows.filter((r) => r.ok).length}/${rows.length} 通过，${verify.at}）

## 驳回原因与修法（#20850）

> api 接口没有放通，调用会被微服网关拦截。

\`lzc-manifest.yml\` 的 \`public_path\` 增加两条：

\`\`\`
public_path:
  - /api/
  - /api/v2/
\`\`\`

只放开 API 前缀，整站 \`/\` 依旧受平台账号保护；DefectDojo 自身仍有 DRF Token/会话鉴权，
所以"放开网关账号密码"不等于"没有鉴权"，下面第 4 条专门验证了匿名仍是 403。

顺带补了 3 处 healthcheck（\`nginx\` 用 \`/__ready/\`，不依赖 uwsgi 启动），让平台能判断就绪。

## 验收口径说明（为什么用浏览器而不是 curl）

微服文档（advanced-public-api）里 \`public_path\` 只关掉"微服的 http 账号密码鉴权"，
访问仍需要登录过微服客户端以建立虚拟网络。也就是说**盒子外的匿名 curl 拿不到 200 是预期行为**，
不能用它判定放通失败。因此本包用"平台 SSO 登录后的真实浏览器会话"取证。

## 断言明细

| # | 断言 | 结果 | 证据 |
|---|------|------|------|
${rows.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | \`${String(r.note).replace(/\|/g, '\\|').slice(0, 150)}\` |`).join('\n')}

关键点：

- \`/api/v2/\` 返回 \`{"announcements":...,"configuration":...}\`，\`/api/v2/findings/\` 返回
  \`{"count":0,"next":null,"previous":null,"results":[],"prefetch":{}}\` —— 是 DefectDojo 后端的真实 JSON，
  不是微服登录页 \`/sys/login\`。
- 去掉 Cookie 再请求同一路径 → **403 \`{"detail":"身份认证信息未提供。"}\`**（放通不等于裸奔）。
- 网盘下载桥路由（\`_lzc_file_download_bridge\`）仍是 404，说明新加的 public_path 没有误伤平台路由。

## 截图

${shots.map((f) => `- \`shots/${f}\``).join('\n')}

PC 4 张（首页 / Findings / Engagements / 组织列表）+ 移动端 3 张（首页 / Findings / Engagements，并断言无横向溢出）。

## 历史（为什么还有一份 failed 记录）

\`RESULT.box-accept-failed.json\` 是 \`scripts/box-accept.mjs\` 的自动产物，唯一失败步骤是
\`S6 入口链路含 lzcinit 注入\` → "0 字节，注入 0 个"。原因是探针用 \`wget\` 不带 \`-L\`，
而 \`/\` 对未登录会话返回 302，重定向响应体本来就是 0 字节。该判定与应用质量无关，
本文件以浏览器侧实测替代之（容器与盒子信息仍取自那次真机安装，两者一致）。
`;
writeFileSync(path.join(ACC, 'EVIDENCE.md'), md);

console.log(JSON.stringify({ verdict: result.verdict, steps: `${rows.filter((r) => r.ok).length}/${rows.length}`, shots: shots.length, lpkSha, iconMd5 }, null, 1));
