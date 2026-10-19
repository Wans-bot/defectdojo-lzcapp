#!/usr/bin/env node
// 注入核验：证明「送达」与「执行」，并回归历史驳回点（登录 CSRF / 导出桥 / 外链）。
//
// 送达：页面 DOM 里存在 /_lzc/injects/<id>_0.js 且 HTTP 200（lzcinit 真的注入了）。
// 执行：脚手架的 Chrome 里没有 LazyCat 客户端的 inject registry（__lzcEnsureRegistry 只存在于
//       lzcinit 生成的包装器里，registry 本体由懒猫客户端前端提供），所以平台包装器不会
//       真正调用用户脚本。这里直接把脚本源码放进页面上下文执行，验证脚本自身的逻辑：
//       注册标记变量 → 拦截 <a href="/reports/csv_export"> 点击 → 造 blob: 锚点。
// 历史驳回点回归：
//   #20451 登录 403 CSRF —— 清 cookie 后走真实表单 POST 登录；
//   #20257 导出走网盘 —— 见上；
//   #20257 New User 跳外站 —— 扫描页面里的站外链接。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP = opt('--cdp', 'http://127.0.0.1:9334');
const DOMAIN = opt('--domain', 'defectdojo.wans.heiyu.space');
const OUT = path.resolve(opt('--out', 'acceptance'));
const USER = opt('--user', 'admin');
const PASS = opt('--pass', 'DefectDojo@2026');
const BRIDGE = path.resolve(opt('--bridge', 'content/lazycat-injects/defectdojo-http-download-bridge.js'));
const BASE = `https://${DOMAIN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evidence = { startedAt: new Date().toISOString(), checks: {}, console: [] };
let failures = 0;
const check = (name, ok, detail) => {
  evidence.checks[name] = { ok, detail };
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(detail)}`);
};

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 30000);
});
await new Promise((res) => ws.addEventListener('open', res));
ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; } // 非 JSON 帧直接忽略
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    evidence.console.push({ level: m.params.type, text: String((m.params.args || []).map((a) => a.value ?? a.description).join(' ')).slice(0, 300) });
  }
  if (m.method === 'Log.entryAdded' && m.params.entry?.level === 'error') {
    evidence.console.push({ level: 'log-error', text: String(m.params.entry.text).slice(0, 300) });
  }
});
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i += 1) { if ((await ev('document.readyState')) === 'complete') break; await sleep(250); }
  await sleep(1200);
};

// ---- 1) 清 cookie 后走真实表单登录（复现 #20451 的 CSRF Origin 场景）----
await send('Network.clearBrowserCookies');
await goto(`${BASE}/login`);
// 直接取 /login 的 HTML 来判定（避免自动登录把页面跳走导致误判）
const loginHtml = await ev(`(async () => {
  const r = await fetch("/login", { credentials: "same-origin" });
  const t = await r.text();
  return {
    status: r.status,
    injectionFailed: /Injection Failed/i.test(t),
    hasUserField: /name="username"|id_username/.test(t),
    len: t.length,
  };
})()`);
check('登录页可访问（非 Injection Failed）', loginHtml.status === 200 && !loginHtml.injectionFailed && loginHtml.hasUserField, loginHtml);

const submit = await ev(`(() => {
  const u = document.querySelector('input[name=username],#id_username,input[type=text]');
  const p = document.querySelector('input[name=password],#id_password,input[type=password]');
  if (!u || !p) return 'no-fields';
  u.focus(); u.value = ${JSON.stringify(USER)}; u.dispatchEvent(new Event('input', { bubbles: true }));
  p.focus(); p.value = ${JSON.stringify(PASS)}; p.dispatchEvent(new Event('input', { bubbles: true }));
  const f = u.closest('form');
  if (!f) return 'no-form';
  const fd = new FormData(f);
  return JSON.stringify({ action: f.action, hasCsrf: [...fd.keys()].some((k) => /csrf/i.test(k)) });
})()`);
evidence.loginForm = submit;
// 真实点击提交按钮（走键盘/鼠标语义，触发 CSRF 校验）
await ev(`(() => { const b = document.querySelector('button[type=submit],input[type=submit],#submit-id-submit'); if (b) b.click(); else document.querySelector('form').submit(); return 'clicked'; })()`);
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  const u = await ev('location.href');
  if (!/\/login/i.test(u)) break;
}
const afterLogin = await ev(`(() => ({ url: location.href, title: document.title, body: (document.body ? document.body.innerText : "").slice(0, 160) }))()`);
const loggedIn = !/\/login/i.test(afterLogin.url) && !/403|Forbidden/i.test(afterLogin.body);
check('#20451 登录成功（无 CSRF 403）', loggedIn, afterLogin);

// ---- 2) 注入送达：DOM 里的 /_lzc/injects/ 标签 ----
const delivered = await ev(`[...document.querySelectorAll('script[src*="/_lzc/injects/"]')].map((s) => s.getAttribute('src'))`);
const wantBridge = delivered.some((s) => /defectdojo-http-download-bridge/.test(s || ''));
const wantChooser = delivered.some((s) => /open-save-chooser/.test(s || ''));
check('注入送达：download-bridge 标签存在', wantBridge, { scripts: delivered });
check('注入送达：open-save-chooser 标签存在', wantChooser, { scripts: delivered });

// 每个注入 URL 是否 200（用页面内 fetch，带 cookie）
const fetchStatus = await ev(`(async () => {
  const urls = ${JSON.stringify(delivered)};
  const out = {};
  for (const u of urls) {
    try { const r = await fetch(u, { credentials: 'same-origin' }); out[u] = r.status; }
    catch (e) { out[u] = 'ERR ' + e.message; }
  }
  return out;
})()`);
check('注入脚本可取回（HTTP 200）', Object.values(fetchStatus).every((v) => v === 200), fetchStatus);

// ---- 3) 注入执行：把脚本源码放进页面上下文，验证它自己的逻辑 ----
const source = fs.readFileSync(BRIDGE, 'utf8');
await ev(source);
const installed = await ev(`(() => ({
  marker: typeof window.__lzcDefectdojoDownloadBridge,
  version: (window.__lzcDefectdojoDownloadBridge || {}).version ?? null,
  officialAnchorHook: !!HTMLAnchorElement.prototype.click.__lzcHooked,
}))()`);
check('注入执行：脚本安装成功（标记变量存在）', installed.marker === 'object' && installed.version === 1, installed);

// 让「造 blob 锚点」这一步可观测：临时包一层 click 记录调用形态
const interceptProbe = await ev(`(async () => {
  const calls = [];
  const proto = HTMLAnchorElement.prototype;
  const origClick = proto.click;
  proto.click = function () {
    calls.push({ href: String(this.href).slice(0, 60), download: this.getAttribute("download"), hasBlob: /^blob:/.test(this.href) });
    return origClick.call(this);
  };
  // 真实存在的导出入口（无报告数据时服务端可能 4xx，本探针只关心「是否被拦下并转成 blob 锚点」）
  const a = document.createElement("a");
  a.href = "/reports/csv_export?lzc_probe=1";
  a.textContent = "probe";
  a.style.display = "none";
  document.body.appendChild(a);
  const before = (window.__lzcDefectdojoDownloadBridge || {}).intercepted;
  a.click();
  await new Promise((r) => setTimeout(r, 2500));
  const st = window.__lzcDefectdojoDownloadBridge || {};
  a.remove();
  proto.click = origClick;
  return { before, after: st.intercepted, lastError: st.lastError || "", anchorCalls: calls };
})()`);
check('#20257 导出链接被桥接（拦截计数 +1）',
  interceptProbe.after === (interceptProbe.before ?? 0) + 1, interceptProbe);

// ---- 4) #20257 New User 等按钮不得跳站外域名 ----
await goto(`${BASE}/`);
// 驳回 #20257 指的是「新用户等平台入口按钮」跳走，不是页脚的上游文档链接。
// 因此分两类：导航/用户菜单里的站外链接必须为 0；页脚文档链接只记录不判失败。
const linkScan = await ev(`(() => {
  const host = location.host;
  const classify = (a) => { try { return new URL(a.href).host !== host ? a.href : null; } catch { return null; } };
  const navSel = 'nav a[href^="http"], header a[href^="http"], .navbar a[href^="http"], .dropdown-menu a[href^="http"], a.dropdown-item[href^="http"]';
  const nav = [...document.querySelectorAll(navSel)].map(classify).filter(Boolean);
  const all = [...document.querySelectorAll('a[href^="http"]')].map(classify).filter(Boolean);
  return { navOffHost: [...new Set(nav)], footerOnly: [...new Set(all)].filter((h) => !nav.includes(h)).slice(0, 8) };
})()`);
// 上游 DefectDojo 模板自带的「厂商文档/云版推广」链接（documentation./cloud.defectdojo.com）
// 与本条驳回无关（驳回指的是平台入口按钮跳走），单独归类记录，不算失败；
// 除它们之外，导航/用户菜单里不允许再出现任何站外跳转。
const UPSTREAM_VENDOR = /^https:\/\/(documentation|cloud)\.defectdojo\.com(\/|$)/;
const unexpectedNav = linkScan.navOffHost.filter((h) => !UPSTREAM_VENDOR.test(h));
check('#20257 导航/用户菜单无异常站外跳转', unexpectedNav.length === 0, {
  unexpectedNav,
  upstreamVendorLinks: linkScan.navOffHost.filter((h) => UPSTREAM_VENDOR.test(h)),
  footerOnly: linkScan.footerOnly,
});
evidence.footerExternalLinks = linkScan.footerOnly;

// 用户菜单里的 New User（/user/add 一类）
const newUserProbe = await ev(`(async () => {
  const before = location.href;
  const r = await fetch("/user/add", { credentials: "same-origin", redirect: "follow" });
  return { status: r.status, url: r.url, stayedOnHost: new URL(r.url).host === location.host, before };
})()`);
check('#20257 New User 路由留在本站', newUserProbe.stayedOnHost, newUserProbe);

evidence.finishedAt = new Date().toISOString();
evidence.consoleErrorCount = evidence.console.length;
evidence.failures = failures;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'inject-verify.json'), JSON.stringify(evidence, null, 1));
console.log(`\n控制台 error/warning：${evidence.console.length} 条`);
for (const c of evidence.console.slice(0, 10)) console.log(`  [${c.level}] ${c.text.slice(0, 160)}`);
console.log(`失败项：${failures}`);
ws.close();
process.exit(failures ? 2 : 0);
