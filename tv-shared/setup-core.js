// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the server setup page (no DOM). A classic script (no module loading from the app's file:// page): it sets
// window.FFSetupCore; the node tests evaluate the file with a stand-in window. The answer check mirrors
// android/.../setup/ServerProbe.kt (and desktop/core/src/probe.rs).

(function (root) {
'use strict';

/**
 * The address a person typed, as `https://host[:port]`.
 * @param {unknown} input
 * @returns {{ ok: true, origin: string } | { ok: false, reason: 'empty' | 'http' | 'invalid' }}
 */
function normaliseServer(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '') return { ok: false, reason: 'empty' };
  if (/^http:\/\//i.test(text)) return { ok: false, reason: 'http' };
  const rest = text.replace(/^https:\/\//i, '');
  // a scheme left over (ftp://), spaces, user info or a bare path are not an address
  if (/[\s@\\]/.test(rest) || rest.includes('://')) return { ok: false, reason: 'invalid' };
  let url;
  try {
    url = new URL('https://' + rest);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '') return { ok: false, reason: 'invalid' };
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(url.hostname)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, origin: url.origin };
}

const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** `authOrigin` as an origin the shell may use: https, a host and nothing after it. Anything else is null. */
function authOriginOf(text) {
  if (typeof text !== 'string' || !/^https:\/\//i.test(text) || /[?#\s]/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '' || url.pathname !== '/') return null;
  return url.origin;
}

/**
 * Whether a parsed `/api/version` body is a FriendFlix answer ({sha, version, codename, ...}; `authOrigin` is optional).
 * @param {unknown} json
 * @returns {{ ok: true, authOrigin: string | null } | { ok: false }}
 */
function checkVersionAnswer(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false };
  const o = /** @type {Record<string, unknown>} */ (json);
  const nonEmpty = (v) => typeof v === 'string' && v !== '';
  if (!nonEmpty(o.sha) || !nonEmpty(o.codename) || typeof o.version !== 'string' || !SEMVER.test(o.version)) return { ok: false };
  return { ok: true, authOrigin: authOriginOf(o.authOrigin) };
}

/** The page the shell opens: the TV mode, marked with the app ('webos' or, by default, 'tizen'), plus the probe flag for a probe run. */
function watchUrl(origin, probe, app) {
  return origin + '/tv?ff_app=' + (app === 'webos' ? 'webos' : 'tizen') + (probe ? '&probe=1' : '');
}

const PROBE_TIMEOUT_MS = 15000;

/** the texts the setup pages show for a failed address or a failed check */
const MESSAGES = {
  empty: 'Enter the address of your FriendFlix server.',
  http: 'Plain http:// addresses are not allowed. Use an https:// address.',
  invalid: 'That does not look like a server address. Try something like friend.example.com.',
  unreachable: 'Cannot reach that server. Check the address, the TV network and that the server is running.',
  notFriendflix: 'That address answered, but it is not a FriendFlix server.',
};

/**
 * GET <origin>/api/version and judge the answer. `deps.fetch` / `deps.AbortController` default to the globals (tests stub them).
 * @returns {Promise<{ ok: true, authOrigin: string | null } | { ok: false, reason: 'unreachable' | 'notFriendflix' }>}
 */
async function askVersion(origin, deps) {
  const doFetch = deps && deps.fetch ? deps.fetch : fetch;
  const Ctl = deps && deps.AbortController ? deps.AbortController : (typeof AbortController === 'function' ? AbortController : null);
  const ctl = Ctl ? new Ctl() : null;
  let timer;
  // the timeout also settles a fetch that never answers or ignores the abort
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () { if (ctl) ctl.abort(); resolve({ ok: false, reason: 'unreachable' }); }, PROBE_TIMEOUT_MS);
  });
  const ask = (async function () {
    try {
      const r = await doFetch(origin + '/api/version', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ctl ? ctl.signal : undefined });
      if (r.status !== 200) return { ok: false, reason: 'notFriendflix' };
      let json;
      try { json = await r.json(); } catch { return { ok: false, reason: 'notFriendflix' }; }
      const answer = checkVersionAnswer(json);
      return answer.ok ? answer : { ok: false, reason: 'notFriendflix' };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

root.FFSetupCore = { normaliseServer: normaliseServer, checkVersionAnswer: checkVersionAnswer, watchUrl: watchUrl, askVersion: askVersion, MESSAGES: MESSAGES };
})(window);
