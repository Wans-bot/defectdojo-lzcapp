// DefectDojo 补接：把「普通 HTTP 导出下载」转成官方拦截器能识别的 blob: 下载锚点。
//
// 背景：官方 lzc-file-chooser-inject.js 的 downloadAnchor 钩子只认
//   anchor[download] 且 href 匹配 blob:/data: 的锚点；DefectDojo 的导出按钮是
//   普通 <a href="/reports/csv_export?url=...">（无 download 属性、同源 http），
//   点击直接触发浏览器原生下载，网盘拦截器完全覆盖不到。官方审核因此驳回
//   「导出按钮需要支持网盘的文件拦截」（#20257）。
//
// 做法：patch HTMLAnchorElement.prototype.click，对「DefectDojo 导出端点」或
//   「同源 + 带 download 属性」的锚点：preventDefault → fetch 取 blob（文件名
//   优先用响应的 Content-Disposition）→ 造 blob: 临时锚点并 dispatchEvent('click')，
//   由官方脚本的 document 捕获监听器接手，弹出「保存至懒猫」选择器。
//
// 与官方脚本的职责互斥（官方只管 blob:/data:，本脚本只管同源 http）。
// 包裹层永不调用链上的下一个 click（非目标走真正的原生 click），避免与官方
// 脚本互相包裹形成递归；两个脚本的执行顺序不确定（实测两种顺序都出现过）。
(function () {
  var FLAG = "__lzcHttpDownloadBridge";
  var NATIVE_CLICK = HTMLElement.prototype.click;
  var proto = HTMLAnchorElement.prototype;
  if (typeof proto.click !== "function" || typeof NATIVE_CLICK !== "function") return;
  window.__lzcHttpDownloadBridgeInstalled = true;

  // DefectDojo 的导出端点（普通 HTTP 下载，官方拦截器不管）。
  var EXPORT_PATH = /^\/reports\/(csv|excel)_export$/;

  function isBridgeTarget(anchor) {
    if (!anchor || anchor.tagName !== "A") return false;
    var href = "";
    try {
      href = anchor.href || "";
    } catch (e) {
      return false;
    }
    if (!/^https?:/i.test(href)) return false;
    var url;
    try {
      url = new URL(href, location.href);
    } catch (e) {
      return false;
    }
    if (url.origin !== location.origin) return false;
    if (EXPORT_PATH.test(url.pathname)) return true;
    // 通用兜底：同源、带 download 属性的普通 HTTP 下载（交给桥，官方只认 blob:/data:）
    if (anchor.hasAttribute("download")) return true;
    return false;
  }

  function filenameFrom(response, anchor) {
    try {
      var cd = response.headers.get("content-disposition") || "";
      var m = /filename\*?=(?:UTF-8'')?["']?([^;"']+)/i.exec(cd);
      if (m && m[1]) {
        try {
          return decodeURIComponent(m[1]);
        } catch (e) {
          return m[1];
        }
      }
    } catch (e) {
      /* ignore */
    }
    var raw = anchor.getAttribute("download");
    if (raw && raw.trim()) return raw.trim();
    try {
      var last = new URL(anchor.href, location.href).pathname.split("/").filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch (e) {
      /* ignore */
    }
    return "export.data";
  }

  function nativeClick(anchor) {
    try {
      NATIVE_CLICK.call(anchor);
    } catch (e) {
      /* ignore */
    }
  }

  function notify(message) {
    try {
      if (window.__lzcToast) {
        window.__lzcToast(message);
        return;
      }
    } catch (e) {
      /* ignore */
    }
    console.warn("[lzc-http-download-bridge] " + message);
  }

  var busy = false;

  async function bridge(anchor) {
    if (busy) {
      nativeClick(anchor);
      return;
    }
    busy = true;
    var href = anchor.href;
    try {
      var response = await fetch(href, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      var name = filenameFrom(response, anchor);
      var blob = await response.blob();
      // 注意：DefectDojo 空列表的导出是合法的 0 字节 CSV，不视为错误。
      var objectUrl = URL.createObjectURL(blob);
      var proxy = document.createElement("a");
      proxy.href = objectUrl;
      proxy.download = name;
      proxy.style.display = "none";
      document.body.appendChild(proxy);
      try {
        // 用 dispatchEvent 而不是 .click()：绕过所有 click 包裹层，直接让官方脚本的
        // document 捕获监听器接管这个 blob: 下载锚点。
        proxy.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
        );
      } finally {
        setTimeout(function () {
          try {
            proxy.remove();
            URL.revokeObjectURL(objectUrl);
          } catch (e) {
            /* ignore */
          }
        }, 60000);
      }
    } catch (error) {
      notify("保存到网盘失败：" + (error && error.message ? error.message : error));
      // 补接失败时退回浏览器原生下载，不能把用户的下载功能弄丢。
      nativeClick(anchor);
    } finally {
      busy = false;
    }
  }

  function ensurePatched() {
    if (typeof proto.click !== "function" || proto.click[FLAG]) return;
    function hookedClick() {
      if (isBridgeTarget(this)) {
        bridge(this);
        return;
      }
      return NATIVE_CLICK.call(this);
    }
    hookedClick[FLAG] = true;
    proto.click = hookedClick;
  }

  ensurePatched();

  // 真实用户点击（含下拉菜单里的导出项）在 document 捕获阶段兜底。
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      var anchor = target.closest ? target.closest("a") : null;
      if (!anchor || !isBridgeTarget(anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      bridge(anchor);
    },
    true,
  );

  // 官方脚本可能在本脚本之后再 patch 一次，把本补丁盖掉；这里按需重新包裹。
  var fast = setInterval(ensurePatched, 300);
  setTimeout(function () {
    clearInterval(fast);
    setInterval(ensurePatched, 2000);
  }, 15000);
})();
