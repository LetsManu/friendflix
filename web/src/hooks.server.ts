// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Handle } from '@sveltejs/kit/hooks';
import { cspWithSocketHost, securityHeaders } from '../server/headers.js';

/**
 * The security headers (web/server/headers.js) on every SvelteKit response; the server entry sets the same on static files.
 * The app pages' CSP (vite.config.ts) gets this host's websocket origin in connect-src.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  for (const [k, v] of Object.entries(securityHeaders(event.url.pathname))) {
    // a route's own value wins (none sets one today); redirects and errors get the defaults too
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  const csp = res.headers.get('content-security-policy');
  if (csp) res.headers.set('content-security-policy', cspWithSocketHost(csp, event.url));
  return res;
};
