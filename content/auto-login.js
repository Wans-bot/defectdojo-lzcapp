/* DefectDojo 免密登录注入（上架要求：安装后无需手动输入账号密码）
 *
 * 凭据来自平台在部署时渲染好的注入参数 ctx.params（manifest 里由
 * lzc-deploy-params.yml 的 admin_username / admin_password 渲染而来），
 * 本文件不保存任何明文凭据；取不到参数就不动作，避免用错密码锁死账号。
 *
 * 其它设计要点（都是踩坑换来的）：
 * 1) 不用 sessionStorage/localStorage 记「已登录过」——那种标记在登出后依然存在，
 *    用户登出后再也进不去。用页面级内存变量，每次导航自然重置。
 * 2) 用户已经自己填了密码（例如登出后要换账号）就不覆盖，把控制权交还用户。
 * 3) 登录页出现错误提示（密码被改过 / 被限流）时不再提交，避免无限重载。
 * 4) 表单要选「可见」的那一个：DefectDojo 页面里可能同时存在隐藏的模板表单。
 * 5) 【2026-10-13 返工 #20257 修复】只在**登录页**（location.pathname 为 /login）动作，
 *    并且提交按钮**必须在目标表单内**找。旧版用全局 pick() 找第一个可见 submit 按钮，
 *    且判定「有 username + password 输入框 = 登录页」。但 /user/add「新建用户」表单同样
 *    含 input[name=username]/input[name=password]，脚本会把管理员凭据填进新建用户表单，
 *    再点到页面里**全局第一个可见 submit 按钮**（顶部导航的搜索框按钮，action=/simple_search）
 *    → 页面直接跳去 /simple_search?query=。这正是评审看到的「点击新建用户按钮之后，
 *    会跳转到其他页面」。
 *
 * 6) 【2026-10-14 返工 #20451 修复】评审驳回原文「点击应用跳转到了这个页面」，附件是
 *    Django 的 403「CSRF验证失败. 请求被中断.」。本机复现结论（直连 lzcinit 网关，
 *    逐个变量试 POST /login，见 `dd-csrf-probe.sh`）：
 *      - 页面上渲染的 csrfmiddlewaretoken 与**提交瞬间浏览器携带的 csrftoken Cookie
 *        不一致**时，Django 返回 403（日志 `Forbidden (CSRF token from POST incorrect.)`，
 *        页面正文 1001 字节，只剩标题三行——与驳回附件完全一致）；
 *      - 只缺 Cookie 是另一种页（正文 1300 字节，多一段「requires a CSRF cookie」）；
 *      - Origin 用 http:// 也仍能通过（DD_CSRF_TRUSTED_ORIGINS 已含两种协议）→ 不是 Origin 问题。
 *    也就是说，只要「DOM 里的 token」与「当前 Cookie」被拆开（客户端复用旧页面、
 *    或提交前 Cookie 恰好轮换过），就会稳定 403。旧版直接提交页面上那张表单，
 *    用的正是 DOM 里的 token，因此无法规避。
 *
 *    修法：提交前**重新取一张登录页**（`fetch` 带 cache-busting 与 cache: 'no-store'），
 *    用这次响应的隐藏字段（含 csrfmiddlewaretoken）拼一张新表单再提交。
 *    这样 token 一定来自「刚建立 Cookie 的那次响应」，两者天然一致，
 *    不依赖 DOM 里那份可能过期的 token。拿不到新页面时回落到旧的填表路径。
 *    另加一道自愈：若当前文档就是 CSRF 失败页，重载一次（内存标记防循环）。
 */
(function () {
  'use strict';

  function readParams() {
    try {
      if (typeof ctx === 'object' && ctx && typeof ctx.params === 'object' && ctx.params) return ctx.params;
    } catch (e) {}
    return {};
  }

  var P = readParams();
  var USER = (typeof P.user === 'string') ? P.user : '';
  var PASS = (typeof P.password === 'string') ? P.password : '';

  if (!USER || !PASS) return;
  if (typeof document === 'undefined') return;

  // ---- 自愈：当前文档是 Django 的 CSRF 失败页时，重载一次拿新 token ----
  // 只在本次文档生命周期里做一次（window 上的标记随导航自然消失），避免循环刷新。
  function isCsrfFailurePage() {
    try {
      var txt = (document.body && document.body.innerText || '').slice(0, 300);
      return /CSRF/i.test(txt) && /(禁止访问|Forbidden)/.test(txt);
    } catch (e) {
      return false;
    }
  }
  if (isCsrfFailurePage()) {
    if (!window.__lzcDdCsrfRetried) {
      window.__lzcDdCsrfRetried = true;
      location.reload();
    }
    return;
  }

  // 仅在登录页动作。DefectDojo 的登录页是 /login（可能带 ?next=...）。
  // 其它任何页面（包括 /user/add 新建用户表单）一律不碰。
  if (!/^\/login(\/|$|\?)/.test(location.pathname)) return;

  var submitted = false;
  var tries = 0;

  function visible(el) {
    return !!(el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length)));
  }

  function pick(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var list;
      try { list = document.querySelectorAll(selectors[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) { if (visible(list[j])) return list[j]; }
    }
    for (var k = 0; k < selectors.length; k++) {
      try { var e2 = document.querySelector(selectors[k]); } catch (e) { continue; }
      if (e2) return e2;
    }
    return null;
  }

  // 只在「登录表单本身报错」时放弃自动提交，避免失败后无限重载。
  // 注意：不能用 [role=alert] 这种宽泛选择器 —— DefectDojo 登录页顶部常驻一条
  // 营销横幅（"DefectDojo Pro now offers ..."）也带 role=alert，会导致脚本永远
  // 判定「登录失败」而不填表（实测踩过）。
  function loginFailed() {
    var u0 = document.querySelector('#id_username');
    var form = u0 && u0.closest('form');
    var scopes = [form, document];
    var sels = ['.errorlist', '.alert-danger', '.alert-error', '.invalid-feedback'];
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      if (!scope) continue;
      for (var i = 0; i < sels.length; i++) {
        var list;
        try { list = scope.querySelectorAll(sels[i]); } catch (e) { continue; }
        for (var j = 0; j < list.length; j++) {
          if (visible(list[j]) && (list[j].textContent || '').trim().length > 0) return true;
        }
      }
    }
    return false;
  }

  function nativeSet(el, v) {
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) { d.set.call(el, v); } else { el.value = v; }
    } catch (e) { el.value = v; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 提交按钮：只在目标表单内找（优先 DefectDojo 登录按钮 .login-btn）。
  // 严禁全局查找 —— 会点到页面里其它表单（如导航搜索框）的按钮。
  function findSubmit(form) {
    if (!form) return null;
    return form.querySelector('.login-btn, button[type="submit"], input[type="submit"]') || null;
  }

  function submit(form, btn) {
    if (btn && visible(btn)) { btn.click(); return true; }
    if (form) {
      if (form.requestSubmit) { try { form.requestSubmit(); return true; } catch (e) {} }
      form.submit();
      return true;
    }
    return false;
  }

  // 回落路径：直接用页面上那张可见表单（旧版行为），仅在拿不到新登录页时使用。
  function fallbackSubmitDom() {
    var u = pick(['#id_username', 'input[name="username"]']);
    var p = pick(['#id_password', 'input[name="password"]']);
    if (!u || !p) return false;
    if (p.value && p.value.length > 0) return true;
    submitted = true;
    nativeSet(u, USER);
    nativeSet(p, PASS);
    setTimeout(function () {
      var form = u.closest('form') || p.closest('form');
      submit(form, findSubmit(form));
    }, 250);
    return true;
  }

  // 主路径：重取登录页 → 用新响应的隐藏字段拼表单提交。
  // token 与 Cookie 来自同一次响应，因此不会出现「token from POST incorrect」。
  function freshSubmit() {
    var stamp = Date.now();
    return fetch('/login?_lzc=' + stamp, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    }).then(function (res) {
      if (!res || !res.ok) return false;
      return res.text();
    }).then(function (html) {
      if (!html) return false;
      var parsed = new DOMParser().parseFromString(html, 'text/html');
      var src = parsed.querySelector('form[method="post" i]') || parsed.querySelector('form');
      if (!src) return false;
      var tok = src.querySelector('input[name="csrfmiddlewaretoken"]');
      if (!tok || !tok.value) return false;

      var form = document.createElement('form');
      form.method = 'post';
      form.action = src.getAttribute('action') || '/login';
      form.style.display = 'none';

      // 复制原表单的隐藏字段（csrfmiddlewaretoken / next / 其它），凭据字段另写
      var inputs = src.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var name = el.getAttribute('name');
        if (!name) continue;
        if (/^(username|password)$/i.test(name)) continue;
        var hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = el.value;
        form.appendChild(hidden);
      }
      // 当前 URL 上的 next 优先（用户从某个页面被弹到登录页时用得上）
      var m = /[?&]next=([^&]+)/.exec(location.search);
      var nextVal = null;
      try { nextVal = m ? decodeURIComponent(m[1]) : null; } catch (e) { nextVal = m ? m[1] : null; }
      if (nextVal && !form.querySelector('input[name="next"]')) {
        var nx = document.createElement('input');
        nx.type = 'hidden';
        nx.name = 'next';
        nx.value = nextVal;
        form.appendChild(nx);
      }
      var uIn = document.createElement('input');
      uIn.type = 'hidden'; uIn.name = 'username'; uIn.value = USER;
      form.appendChild(uIn);
      var pIn = document.createElement('input');
      pIn.type = 'hidden'; pIn.name = 'password'; pIn.value = PASS;
      form.appendChild(pIn);

      document.body.appendChild(form);
      submitted = true;
      form.submit();
      return true;
    }).catch(function () { return false; });
  }

  function attempt() {
    tries++;
    if (submitted) return true;
    if (loginFailed()) return true;
    // 页面上确实有登录输入框（可见或隐藏模板都算），否则不动
    if (!document.querySelector('#id_username, input[name="username"]')) return false;
    // 用户自己填了密码就交还用户（切换账号场景）
    var pNow = pick(['#id_password', 'input[name="password"]']);
    if (pNow && pNow.value && pNow.value.length > 0) return true;

    freshSubmit().then(function (ok) {
      if (!ok && !submitted) fallbackSubmitDom();
    });
    return true;
  }

  if (attempt()) return;
  var t = setInterval(function () {
    if (attempt() || tries > 40) clearInterval(t);
  }, 500);
})();
