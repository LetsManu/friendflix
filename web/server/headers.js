// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security headers of the web container, in one place. Two layers use it:
 * - the server entry (web/server/index.js) sets them on EVERY response before adapter-node answers, so the static files
 *   (/_app/immutable/*, icons, /service-worker.js) and the prerendered /offline page carry them too: adapter-node serves those
 *   without running hooks.server.ts;
 * - hooks.server.ts sets them again on the SvelteKit responses (`vite dev` has no server entry) and narrows the CSP's websocket
 *   source to this host (cspWithSocketHost).
 * Plain JavaScript (JSDoc types): the entry runs it in the image as it is, without a build step.
 */

/** the trailer player (lib/TrailerButton.svelte): the only third-party frame, which gets autoplay, EME, PiP and fullscreen delegated */
const TRAILER_FRAME = '"https://www.youtube-nocookie.com"';

/**
 * Features the app uses stay allowed for its own origin (and, where the trailer iframe's `allow` delegates them, for the trailer
 * frame); everything else is off. Allowed:
 * - autoplay / fullscreen / picture-in-picture: the player, previews, the trailer frame;
 * - encrypted-media: only what the trailer frame may need (the app plays no DRM);
 * - screen-wake-lock: offline downloads keep the screen on while they run (lib/offline/manager.ts);
 * - clipboard-write: the copy buttons (share-link fallback, party link, recovery codes, diagnose reports). Reading the clipboard is
 *   not listed: the app never reads it, the browser asks the user first anyway, and the e2e tests check what was copied with it.
 * WebAuthn (passkeys) and Web Share (the share buttons) keep their default (`self`) and are not listed. Casting (Cast sender SDK,
 * Remote Playback / AirPlay) and the Media Session API have no Permissions-Policy feature, nothing here can block them. Only
 * feature names current Chromium parses from the header: an unknown one is a console warning on every page (the Playwright
 * Chromium rejects `bluetooth` and `web-share`).
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  `autoplay=(self ${TRAILER_FRAME})`,
  'camera=()',
  'clipboard-write=(self)',
  'display-capture=()',
  `encrypted-media=(self ${TRAILER_FRAME})`,
  `fullscreen=(self ${TRAILER_FRAME})`,
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  `picture-in-picture=(self ${TRAILER_FRAME})`,
  'screen-wake-lock=(self)',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Paths another origin loads by design, so they get `Cross-Origin-Resource-Policy: cross-origin`:
 * - /cast-receiver/ (page, script, stylesheet): the Cast receiver the TV loads;
 * - /cast-test/ (clip.mp4): the cast test clip, played by Google's Default Media Receiver (a gstatic origin) when no own receiver
 *   is registered.
 * Everything else is `same-origin`: the app, the TV and desktop shells and the Android WebView all run on the portal's own origin.
 */
const CROSS_ORIGIN = /^\/(?:cast-receiver|cast-test)(?:\/|$)/;

/** whether a request path (query allowed) is one another origin loads by design */
export function crossOriginPath(/** @type {string} */ url) {
  const q = url.search(/[?#]/);
  return CROSS_ORIGIN.test(q === -1 ? url : url.slice(0, q));
}

/**
 * The headers for a response to `url` (the request path, query allowed). COOP `same-origin`: the app opens no window it talks to
 * (sign-in is a full-page redirect, links to other sites open with noopener), so nothing needs an opener across origins. No COEP:
 * `require-corp` would block the trailer frame and the Cast sender script from gstatic, and the app needs no cross-origin isolation.
 * @returns {Record<string, string>}
 */
export function securityHeaders(/** @type {string} */ url) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-resource-policy': crossOriginPath(url) ? 'cross-origin' : 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    // the CSP's frame-ancestors does the same, but the prerendered /offline page only has a <meta> CSP, which cannot carry it
    'x-frame-options': 'DENY',
  };
}

/** a URL host (name or [IPv6] plus an optional port) that is safe to put into a CSP source list; anything else is left out */
const PLAIN_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Adds this host's own websocket origins (wss://host and ws://host) to `connect-src`. CSP Level 3 browsers already allow them
 * through 'self'; older engines (the TV browsers the Tizen and webOS shells run the app in) only through an explicit source, which
 * used to be the scheme-wide `ws: wss:` (any host). Both schemes: the request's scheme is only as right as the proxy's
 * X-Forwarded-Proto (adapter-node assumes https without it), and a page served over https cannot open ws:// anyway (mixed content).
 * Unchanged when the policy has no connect-src or the host is not a plain host name (a forged Host header never reaches the policy).
 */
export function cspWithSocketHost(/** @type {string} */ csp, /** @type {URL} */ url) {
  if (!PLAIN_HOST.test(url.host)) return csp;
  const src = `wss://${url.host} ws://${url.host}`;
  return csp.replace(/(^|;\s*)connect-src\b([^;]*)/, (_m, pre, list) => `${pre}connect-src${list.trimEnd()} ${src}`);
}

/**
 * Sets the security headers on every response of `server` before its own request handler runs (prependListener). A handler's
 * own value wins: Node merges the headers given to writeHead over the ones set here.
 */
export function installSecurityHeaders(/** @type {import('node:http').Server} */ server) {
  server.prependListener('request', (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req.url ?? '/'))) res.setHeader(k, v);
  });
}
