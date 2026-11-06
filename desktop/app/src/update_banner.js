// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The update banner ("Ask first", spec §5): a fragment of the init script (shell::init_script, inside its function, after
// the origin check). The app sends `ff-update-available {version}`; the banner shows local text in a closed shadow root,
// and *Install and restart* (a real click only) sends `{ffUpdate: "install", token, version}` through bridge_message.
// The token is not in the page's reach before the first real click, but it is no secret from a hostile page after
// that: the click travels through Tauri's IPC, which uses page-global functions (fetch, JSON) the page can replace. So
// the guarantee is narrower: the page can at most re-trigger the one signed update that is pending and that the viewer
// already asked to install, never another version and never while the player runs (updater.rs checks all three). The
// DOM helpers are taken before any page script runs, so the page cannot fake the click itself.
var updToken = "@TOKEN@";
var updApply = Reflect.apply;
var updCreate = Document.prototype.createElement;
var updAttach = Element.prototype.attachShadow;
var updListen = EventTarget.prototype.addEventListener;
var updAppend = Node.prototype.appendChild;
var updParse = JSON.parse;
var updStringify = JSON.stringify;
var updVersion = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
var updHost = null;
var updCss =
  ".b{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;" +
  "align-items:center;max-width:calc(100vw - 48px);box-sizing:border-box;padding:12px 16px;border-radius:8px;" +
  "background:#182028;color:#eef2f5;border:1px solid #2a3440;font:14px/1.4 'Segoe UI',system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)}" +
  "button{font:inherit;border:0;border-radius:4px;padding:6px 12px;cursor:pointer}" +
  ".i{background:#d6325a;color:#fff}.l{background:transparent;color:#9aa7b3}button:disabled{opacity:.6;cursor:default}";
var updTexts = {
  player: "Close the player first, then install the update.",
  failed: "The update could not be installed. FriendFlix tries again later.",
  none: "This update is no longer available."
};

function updEl(tag, cls, text) {
  var e = updApply(updCreate, document, [tag]);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function updOnClick(el, fn) {
  updApply(updListen, el, ["click", function (ev) { if (ev.isTrusted) fn(); }]);
}

function updClose() {
  if (updHost && updHost.parentNode) updHost.parentNode.removeChild(updHost);
  updHost = null;
}

function updShow(version) {
  updClose();
  var host = updEl("div");
  var root = updApply(updAttach, host, [{ mode: "closed" }]);
  var box = updEl("div", "b");
  var text = updEl("span", "", "FriendFlix " + version + " is available.");
  var install = updEl("button", "i", "Install and restart");
  var later = updEl("button", "l", "Later");
  updApply(updAppend, root, [updEl("style", "", updCss)]);
  updApply(updAppend, box, [text]);
  updApply(updAppend, box, [install]);
  updApply(updAppend, box, [later]);
  updApply(updAppend, root, [box]);
  updOnClick(later, updClose);
  updOnClick(install, function () {
    var t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== "function") return;
    install.disabled = true;
    text.textContent = "Downloading FriendFlix " + version + "…";
    var msg = updStringify({ ffUpdate: "install", token: updToken, version: version });
    t.invoke("bridge_message", { msg: msg }).then(function (reply) {
      var what = "failed";
      try { what = updParse(reply).ffUpdate; } catch { /* stays "failed" */ }
      if (what === "installing") return;
      text.textContent = updTexts[what] || updTexts.failed;
      install.disabled = what === "none";
    }, function () {
      text.textContent = updTexts.failed;
      install.disabled = false;
    });
  });
  updHost = host;
  updApply(updAppend, document.documentElement, [host]);
}

// true when `data` was the update event (it is not passed on to the page); called by the init script's `deliver`
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function updateBanner(data) {
  if (data.indexOf("ff-update-available") < 0) return false;
  var m;
  try { m = updParse(data); } catch { return false; }
  if (!m || m.event !== "ff-update-available") return false;
  var v = m.detail && m.detail.version;
  if (typeof v === "string" && updVersion.test(v)) updShow(v);
  return true;
}
