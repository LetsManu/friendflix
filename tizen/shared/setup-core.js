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

/** The page the shell opens: the TV mode, marked as the Tizen app (and as the probe run for the probe app). */
function watchUrl(origin, probe) {
  return origin + '/tv?ff_app=tizen' + (probe ? '&probe=1' : '');
}

root.FFSetupCore = { normaliseServer: normaliseServer, checkVersionAnswer: checkVersionAnswer, watchUrl: watchUrl };
})(window);
