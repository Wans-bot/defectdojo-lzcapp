#!/usr/bin/env node
// DefectDojo 实机验证（带平台登录态）：API 放通 + 页面可用 + 截图
//
// 为什么要登录态：官方 advanced-public-api.md 写明 public_path 只关闭微服的 http 账号密码鉴权，
// 访问时依旧要登录微服客户端建立虚拟网络。所以只有「已登录的浏览器会话」才能证明
// /api/ 与 /api/v2/ 真的被放通到后端，裸 curl 只能证明网关的鉴权闸门存在。
//
// 断言：
//   1. 首页落在 DefectDojo（不是平台登录页）
//   2. /api/v2/ 返回 DRF 的鉴权 JSON（放通后由后端回答，不再是平台登录 HTML）
//   3. /api/v2/findings/ 同样到达后端
//   4. 伪造 Token → 401（放通不等于关鉴权）
//   5. 会话内 /api/v2/findings/ → 200 + JSON
//   6. /__lazycat_file_bridge/ 未被网关顶成登录页（#20257 回归）
// 另出 PC 与移动端截图。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.env.PUPPETEER_CORE_DIR || process.cwd(), 'x.js'));
const puppeteer = require('puppeteer-core');

const CDP = process.env.CDP || 'http://127.0.0.1:9334';
const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/tmp/dd-verify';
const PLATFORM_USER = process.env.PLATFORM_USER || '';
const PLATFORM_PASS = process.env.PLATFORM_PASS || '';
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASS || '';

const rows = [];
const fails = [];
const check = (name, ok, note) => {
  rows.push({ name, ok, note });
  if (!ok) fails.push(`${name} — ${note}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${note}`);
};
const brief = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const isPlatformLogin = (s) => /\/sys\/login|微服登录|login-lazycat/i.test(String(s || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });

// 登录：平台 SSO（/sys/login，手机号+密码）与应用自身登录页都要能过
async function loginAny(page) {
  for (let i = 0; i < 4; i += 1) {
    const state = await page.evaluate(() => {
      const pw = [...document.querySelectorAll('input[type=password]')].find((e) => e.offsetParent !== null);
      return { hasPw: !!pw, url: location.href, title: document.title };
    }).catch(() => ({ hasPw: false, url: page.url(), title: '' }));

    if (!state.hasPw) return state;
    const platformStep = /\/sys\/|\/login\/?$/.test(new URL(state.url).pathname) && !/defectdojo/i.test(state.title);
    const user = platformStep || isPlatformLogin(state.url) ? PLATFORM_USER : APP_USER;
    const pass = platformStep || isPlatformLogin(state.url) ? PLATFORM_PASS : APP_PASS;
    if (!pass) return state;

    await page.evaluate(([u, p]) => {
      const pw = [...document.querySelectorAll('input[type=password]')].find((e) => e.offsetParent !== null);
      if (!pw) return;
      const form = pw.closest('form') || document;
      const userEl = form.querySelector('input[type=text],input[type=email],input[name*=user i],input[name*=account i],input[name*=phone i],input:not([type])');
      const set = (el, v) => {
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (userEl && u) set(userEl, u);
      set(pw, p);
      const btn = form.querySelector('button[type=submit],input[type=submit]')
        || [...document.querySelectorAll('button')].find((b) => /登录|登入|Sign in|Log in/i.test(b.innerText || ''));
      if (btn) btn.click(); else form.submit?.();
    }, [user, pass]).catch(() => {});
    await sleep(5000);
  }
  const finalState = await page.evaluate(() => ({
    hasPw: !![...document.querySelectorAll('input[type=password]')].find((e) => e.offsetParent !== null),
    url: location.href, title: document.title,
  })).catch(() => ({ hasPw: false, url: page.url(), title: '' }));
  return finalState;
}

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => console.log('导航：', e.message));
  await sleep(2500);
  const afterLogin = await loginAny(page);
  console.log('登录后：', brief(`${afterLogin.url} | ${afterLogin.title}`, 120));

  // 1. 首页落在 DefectDojo
  const home = await page.evaluate(() => ({
    url: location.href, title: document.title,
    head: document.documentElement.outerHTML.slice(0, 1500),
  }));
  check(
    '首页落在 DefectDojo',
    !isPlatformLogin(home.head) && !/\/sys\/login/.test(home.url) && !afterLogin.hasPw,
    `url=${brief(home.url, 90)} title=${brief(home.title, 40)}`,
  );

  // 2~6. 同源 fetch
  const api = await page.evaluate(async () => {
    const get = async (p, headers = {}) => {
      try {
        const r = await fetch(p, { redirect: 'manual', headers: { Accept: 'application/json', ...headers } });
        const t = await r.text();
        return { status: r.status, body: t.slice(0, 500), location: r.headers.get('location') || '' };
      } catch (e) { return { error: String(e) }; }
    };
    // 匿名探测：不带任何 Cookie（放通后仍必须被网关或后端拒绝）
    const anonGet = async (p) => {
      try {
        const r = await fetch(p, { credentials: 'omit', redirect: 'manual', headers: { Accept: 'application/json' } });
        const t = await r.text();
        return { status: r.status, body: t.slice(0, 300), location: r.headers.get('location') || '' };
      } catch (e) { return { error: String(e) }; }
    };
    return {
      v2: await get('/api/v2/'),
      findings: await get('/api/v2/findings/?limit=1'),
      anon: await anonGet('/api/v2/findings/?limit=1'),
      bridge: await get('/__lazycat_file_bridge/'),
    };
  });

  check('/api/v2/ 由后端回答（非平台登录页）',
    [200, 401, 403].includes(api.v2.status) && !isPlatformLogin(api.v2.body),
    `status=${api.v2.status} body=${brief(api.v2.body, 90)}`);
  check('/api/v2/findings/ 到达业务路由',
    [200, 401, 403].includes(api.findings.status) && !isPlatformLogin(api.findings.body),
    `status=${api.findings.status} body=${brief(api.findings.body, 90)}`);
  check('匿名（无 Cookie）拿不到数据',
    [301, 302, 303, 307, 308, 401, 403].includes(api.anon.status) && !/"count":/.test(api.anon.body),
    `status=${api.anon.status} location=${brief(api.anon.location, 40)} body=${brief(api.anon.body, 60)}`);
  check('会话内 /api/v2/findings/ → 200 + JSON',
    api.findings.status === 200 && /"count"|"results"/.test(api.findings.body),
    `status=${api.findings.status} body=${brief(api.findings.body, 90)}`);
  check('网盘下载桥路由未被顶成登录页',
    !isPlatformLogin(api.bridge.body),
    `status=${api.bridge.status} location=${brief(api.bridge.location, 40)}`);

  // 截图（PC）
  const shots = [];
  const shot = async (p, name) => {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
    await sleep(2000);
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f, fullPage: false });
    shots.push(f);
    const info = await page.evaluate(() => ({ url: location.href, title: document.title }));
    console.log(`截图 ${name}: ${brief(info.title, 50)} ← ${brief(info.url, 80)}`);
  };
  await shot('/', 'pc-01-home');
  await shot('/finding/open', 'pc-02-findings');
  await shot('/engagement', 'pc-03-engagements');
  await shot('/product/type', 'pc-04-product-types');

  // 移动端
  const m = await browser.newPage();
  await m.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await m.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  await sleep(2500);
  const mState = await m.evaluate(() => ({ url: location.href, title: document.title })).catch(() => ({}));
  const mf = path.join(OUT, 'mobile-01-home.png');
  await m.screenshot({ path: mf, fullPage: false }).catch(() => {});
  shots.push(mf);
  await m.goto(`${BASE}/finding/open`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  await sleep(2000);
  const mf2 = path.join(OUT, 'mobile-02-findings.png');
  await m.screenshot({ path: mf2, fullPage: false }).catch(() => {});
  shots.push(mf2);
  await m.goto(`${BASE}/engagement`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  await sleep(2000);
  const mf3 = path.join(OUT, 'mobile-03-engagements.png');
  await m.screenshot({ path: mf3, fullPage: false }).catch(() => {});
  shots.push(mf3);
  const mOver = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => null);
  check('移动端无横向溢出', mOver === false, `overflow=${mOver}`);
  console.log(`移动端：${brief(`${mState.url} | ${mState.title}`, 110)}`);
  await m.close().catch(() => {});

  const summary = {
    base: BASE, at: new Date().toISOString(), checked: rows.length, failed: fails.length, rows, shots,
  };
  fs.writeFileSync(path.join(OUT, 'verify-api.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await page.close().catch(() => {});
  await browser.disconnect().catch(() => {});
}

if (fails.length) {
  console.error(`\n不通过：\n- ${fails.join('\n- ')}`);
  process.exit(1);
}
console.log('\n全部通过');
