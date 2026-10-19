#!/usr/bin/env node
// 无依赖 CDP 驱动：驱动脚手架里的无头 Chrome 走「真实域名 + TLS 前置」抓图与回归。
//
// 为什么不用 puppeteer：盒子上没有 node，本机也没有 puppeteer-core；
// node 22+ 内置 WebSocket，直接用 CDP JSON-RPC 即可，零依赖、可复现。
//
// 用法：
//   node cdp-drive.mjs --cdp http://127.0.0.1:9334 --domain defectdojo.wans.heiyu.space \
//        --out acceptance/shots --mode full
//   node cdp-drive.mjs --mode during ...   # 只抓首装等待期那一张 + 轮询直到应用就绪
//
// 模式：
//   during  轮询页面直到出现「就绪标志」之一，期间把每次变化记成时间线并抓等待页截图
//   full    登录 + PC/移动端多页截图 + 控制台错误收集
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP = opt('--cdp', 'http://127.0.0.1:9334');
const DOMAIN = opt('--domain', 'defectdojo.wans.heiyu.space');
const OUT = path.resolve(opt('--out', 'acceptance/shots'));
const MODE = opt('--mode', 'full');
const USER = opt('--user', 'admin');
const PASS = opt('--pass', 'DefectDojo@2026');
const WAIT = Number(opt('--wait', '900')) * 1000;
fs.mkdirSync(OUT, { recursive: true });

const BASE = `https://${DOMAIN}`;
const evidence = { domain: DOMAIN, mode: MODE, startedAt: new Date().toISOString(), steps: [], console: [] };
const log = (m) => { console.log(m); evidence.steps.push({ at: new Date().toISOString(), msg: m }); };

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error(`ws error: ${e?.message || 'unknown'}`)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const c = new CDPClient(page.webSocketDebuggerUrl);
  await c.ready;

  // 控制台 / 页面异常全部留证
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  c.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      evidence.console.push({ level: p.type, text: String(text).slice(0, 500), at: new Date().toISOString() });
    }
  });
  c.on('Runtime.exceptionThrown', (p) => {
    evidence.console.push({
      level: 'exception',
      text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 500),
      at: new Date().toISOString(),
    });
  });
  c.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') {
      evidence.console.push({ level: 'log-error', text: String(p.entry.text).slice(0, 500), at: new Date().toISOString() });
    }
  });

  const evalJs = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { err: r.exceptionDetails.text };
    return r.result?.value;
  };
  const setViewport = (width, height, mobile = false) =>
    c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const shot = async (file) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUT, file);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    const buf = fs.readFileSync(p);
    const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20); // PNG IHDR
    log(`  shot ${file} ${w}x${h} ${(buf.length / 1024).toFixed(0)}KB`);
    return { file, w, h, bytes: buf.length };
  };
  const navigate = async (url) => {
    await c.send('Page.navigate', { url });
    // 等 document readyState complete
    for (let i = 0; i < 60; i += 1) {
      const st = await evalJs('document.readyState');
      if (st === 'complete') break;
      await sleep(250);
    }
  };
  const snapshot = async () => ({
    url: await evalJs('location.href'),
    title: await evalJs('document.title'),
    text: String(await evalJs('document.body ? document.body.innerText.slice(0,400) : ""') || ''),
  });

  await setViewport(1920, 1080, false);
  evidence.shots = [];

  if (MODE === 'during') {
    // 首装等待期：轮询真实域名，记录「用户此刻看到的页面」，直到应用首页出现
    const t0 = Date.now();
    let sawWaiting = false;
    let last = null;
    while (Date.now() - t0 < WAIT) {
      await navigate(`${BASE}/`);
      const s = await snapshot();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const sig = `${s.title}|${s.url}`;
      if (sig !== last) {
        last = sig;
        log(`+${elapsed}s 页面：title=${JSON.stringify(s.title)} url=${s.url}`);
        log(`   正文开头：${JSON.stringify(s.text.slice(0, 120))}`);
      }
      const waiting = /正在初始化|初始化|warming|Initializing/i.test(`${s.title} ${s.text}`);
      if (waiting && !sawWaiting) {
        sawWaiting = true;
        evidence.shots.push(await shot('pc-01-first-install-waiting-1920x1080.png'));
      }
      const ready = /DefectDojo/i.test(s.title || '') && /login|login|Sign In|Username|用户名/i.test(`${s.title} ${s.text}`);
      if (!waiting && s.text.length > 200) { log(`+${elapsed}s 应用已就绪`); break; }
      if (ready && !waiting) { log(`+${elapsed}s 应用登录页已就绪`); break; }
      await sleep(2000);
    }
    evidence.waitingShot = sawWaiting;
  }

  if (MODE === 'full') {
    await navigate(`${BASE}/`);
    let s = await snapshot();
    log(`进入：title=${JSON.stringify(s.title)} url=${s.url}`);
    if (/login/i.test(s.url) || /login|username|用户名/i.test(s.text)) {
      // 自动登录注入可能已填好；先等 3s 看是否自己跳走
      await sleep(3000);
      s = await snapshot();
      if (/login/i.test(s.url)) {
        log('仍在登录页，手工填表提交');
        await evalJs(`(() => {
          const u = document.querySelector('input[name=username],#id_username,input[type=text]');
          const p = document.querySelector('input[name=password],#id_password,input[type=password]');
          if (!u || !p) return 'no-fields';
          u.focus(); u.value = ${JSON.stringify(USER)}; u.dispatchEvent(new Event('input',{bubbles:true}));
          p.focus(); p.value = ${JSON.stringify(PASS)}; p.dispatchEvent(new Event('input',{bubbles:true}));
          const f = u.closest('form'); if (!f) return 'no-form';
          f.submit(); return 'submitted';
        })()`);
        for (let i = 0; i < 40; i += 1) {
          await sleep(500);
          const u2 = await evalJs('location.href');
          if (!/login/i.test(u2)) break;
        }
        s = await snapshot();
      }
    }
    log(`登录后：title=${JSON.stringify(s.title)} url=${s.url}`);
    await sleep(2500);

    // 注入「送达 + 执行」核验（KB 方法 03 §9）：变量在页面里存在 = 脚本已执行；
    // 再合成一次导出链接点击，看拦截计数是否 +1，并且页面不是「Injection Failed」。
    evidence.inject = await evalJs(`(() => {
      const st = window.__lzcDefectdojoDownloadBridge;
      return {
        bridgeVersion: st ? st.version : null,
        alreadyIntercepted: st ? st.intercepted : null,
        officialAnchorHook: !!HTMLAnchorElement.prototype.click.__lzcHooked,
        pickerDefined: !!customElements.get("lzc-file-picker"),
        injectionFailedPage: /Injection Failed/i.test(document.body ? document.body.innerText : ""),
      };
    })()`);
    log(`注入核验：${JSON.stringify(evidence.inject)}`);

    evidence.syntheticExport = await evalJs(`(async () => {
      const a = document.createElement("a");
      a.href = "/reports/csv_export?lzc_probe=1";
      a.textContent = "probe-export";
      a.style.display = "none";
      document.body.appendChild(a);
      const before = (window.__lzcDefectdojoDownloadBridge || {}).intercepted;
      a.click();
      await new Promise((r) => setTimeout(r, 2000));
      const st = window.__lzcDefectdojoDownloadBridge || {};
      const out = { before, after: st.intercepted, lastError: st.lastError || "" };
      a.remove();
      return out;
    })()`);
    log(`导出拦截探针：${JSON.stringify(evidence.syntheticExport)}`);
    evidence.shots.push(await shot('pc-02-home-1920x1080.png'));

    for (const [i, p] of ['/finding', '/engagement', '/product/type'].entries()) {
      await navigate(`${BASE}${p}`);
      await sleep(2000);
      const ss = await snapshot();
      log(`页面 ${p}：title=${JSON.stringify(ss.title)} url=${ss.url} 正文=${ss.text.length}字`);
      evidence.shots.push(await shot(`pc-0${i + 3}-${p.replace(/\//g, '_').replace(/^_/, '')}-1920x1080.png`));
    }

    // 移动端
    await setViewport(390, 844, true);
    await navigate(`${BASE}/`);
    await sleep(2500);
    evidence.shots.push(await shot('m-01-home-390x844.png'));
    await navigate(`${BASE}/finding`);
    await sleep(2500);
    evidence.shots.push(await shot('m-02-findings-390x844.png'));
    await navigate(`${BASE}/engagement`);
    await sleep(2500);
    evidence.shots.push(await shot('m-03-engagements-390x844.png'));
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.consoleErrors = evidence.console.length;
  fs.writeFileSync(path.join(OUT, `cdp-${MODE}-evidence.json`), JSON.stringify(evidence, null, 1));
  log(`完成：截图 ${evidence.shots.length} 张，控制台 error/warning ${evidence.console.length} 条`);
  if (evidence.console.length) {
    for (const e of evidence.console.slice(0, 20)) log(`  [${e.level}] ${e.text.slice(0, 200)}`);
  }
  c.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
