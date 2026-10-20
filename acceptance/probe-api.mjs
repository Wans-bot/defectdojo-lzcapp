#!/usr/bin/env node
// DefectDojo 验收探针（box-accept.mjs --probe 调用）
//
// 针对驳回 #20850「api 接口没有放通，调用会被微服网关拦截」。
//
// 为什么必须用浏览器会话测、而不是裸 curl：
// 官方 advanced-public-api.md 明确「public_path 仅是关闭微服的 http 账号密码鉴权，
// 访问时依旧需要登录微服客户端建立虚拟网络」，未登录的 curl 会被 ingress 挂住，
// 它证明不了后端是否放通。所以这里复用 box-accept 已经建立好的平台登录态，
// 在页面里做同源 fetch —— 这正是评审在客户端里的真实条件。
//
// 断言：
//   1. / 落在 DefectDojo 自己（不是平台登录页）
//   2. /api/v2/ 返回 Django/DRF 的鉴权 JSON（不是平台登录 HTML）
//   3. /api/v2/findings/ 同样到后端
//   4. 伪造 Token 被判 401（放通后仍必须有鉴权）
//   5. 持有平台会话时可拿到 200 + JSON（真的能用）
//   6. 网盘下载桥路由没被网关顶掉（#20257 回归）
//
// 环境变量：BASE_URL、CDP、ACCEPT_OUT、PACKAGE（由 box-accept.mjs 注入）
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), '_probe.js'));
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || '';
const CDP = process.env.CDP || '';
const OUT = process.env.ACCEPT_OUT || '/tmp';
const rows = [];
const fails = [];

if (!BASE) {
  console.error('缺少 BASE_URL');
  process.exit(2);
}

const check = (name, ok, note) => {
  rows.push({ name, ok, note });
  if (!ok) fails.push(`${name} — ${note}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${note}`);
};

const brief = (s, n = 130) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
// 平台登录页特征：lzc-ingress 把未放通的请求改写成这张「去登录」页面
const isPlatformLogin = (s) => /\/sys\/login|微服登录|login-lazycat/i.test(String(s || ''));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });

try {
  // ── 0. 先进应用首页，把平台登录态建立起来 ─────────────────────────────
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 }).catch((e) => {
    console.log('导航提示：', e.message);
  });
  await new Promise((r) => setTimeout(r, 3000));

  // ── 1. 首页落在 DefectDojo 自己 ────────────────────────────────────────
  const home = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    head: document.documentElement.outerHTML.slice(0, 1200),
  }));
  check(
    '首页落在 DefectDojo（不是平台登录页）',
    !isPlatformLogin(home.head) && !/\/sys\/login/.test(home.url),
    `url=${brief(home.url, 70)} title=${brief(home.title, 40)}`,
  );

  // ── 2~5. 同源 fetch 打 API ─────────────────────────────────────────────
  const api = await page.evaluate(async () => {
    const get = async (p, headers = {}) => {
      try {
        const r = await fetch(p, { redirect: 'manual', headers: { Accept: 'application/json', ...headers } });
        const text = await r.text();
        return { status: r.status, type: r.type, body: text.slice(0, 600), location: r.headers.get('location') || '' };
      } catch (e) {
        return { error: String(e) };
      }
    };
    return {
      v2: await get('/api/v2/'),
      findings: await get('/api/v2/findings/?limit=1'),
      bogus: await get('/api/v2/findings/?limit=1', {
        Authorization: 'Token 0000000000000000000000000000000000000000',
      }),
      bridge: await get('/__lazycat_file_bridge/'),
    };
  });

  check(
    '/api/v2/ 拿到 DRF 鉴权响应（不再被网关换成登录页）',
    [200, 401, 403].includes(api.v2.status) && !isPlatformLogin(api.v2.body),
    `status=${api.v2.status} body=${brief(api.v2.body, 90)}`,
  );
  check(
    '/api/v2/findings/ 到达业务路由',
    [200, 401, 403].includes(api.findings.status) && !isPlatformLogin(api.findings.body),
    `status=${api.findings.status} body=${brief(api.findings.body, 90)}`,
  );
  check(
    '伪造 Token 被判 401（放通后仍有鉴权）',
    api.bogus.status === 401,
    `status=${api.bogus.status} body=${brief(api.bogus.body, 80)}`,
  );
  check(
    '持平台会话可正常调用 API（200 + JSON）',
    api.findings.status === 200 && /"count"|"results"|\[/.test(api.findings.body),
    `status=${api.findings.status} body=${brief(api.findings.body, 90)}`,
  );
  check(
    '网盘下载桥路由仍可达（#20257 回归）',
    !isPlatformLogin(api.bridge.body) && api.bridge.status !== 404,
    `status=${api.bridge.status} location=${brief(api.bridge.location, 50)}`,
  );

  const summary = {
    base: BASE, package: process.env.PACKAGE || '', checked: rows.length, failed: fails.length, rows,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, 'probe-api.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  await page.close().catch(() => {});
  await browser.disconnect().catch(() => {});
}

if (fails.length) {
  console.error(`\n不通过的项：\n- ${fails.join('\n- ')}`);
  process.exit(1);
}
console.log('\n探针全部通过');
process.exit(0);
