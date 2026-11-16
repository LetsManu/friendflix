// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RequestHandler } from './$types';
import { RECEIVER_CSP, receiverHtml } from '#lib/cast/receiverPage';
import { cachedManifestBrand } from '#lib/manifest';

/**
 * FriendFlix's own Cast Web Receiver page (https://<PUBLIC_URL host>/cast-receiver/, registered as CAST_RECEIVER_APP_ID in the Google
 * Cast console). A plain endpoint, not an app page: the TV loads no app shell, no session, no service worker. Its own CSP (the app
 * pages' CSP in vite.config.ts stays as it is) allows Google's receiver framework, on this path only.
 */
export const trailingSlash = 'always';
export const prerender = false;

// the idle screen shows the instance's brand: the public brand from the backend (BACKEND_URL; unset or unreachable: the defaults),
// remembered for a minute like the manifest's
export const GET: RequestHandler = async () => new Response(receiverHtml(await cachedManifestBrand(process.env.BACKEND_URL)), {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': RECEIVER_CSP,
    'cache-control': 'no-cache',
    'x-frame-options': 'DENY',
  },
});
