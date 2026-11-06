// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RequestHandler } from './$types';
import { RECEIVER_CSP, receiverHtml } from '#lib/cast/receiverPage';

/**
 * FriendFlix's own Cast Web Receiver page (https://<PUBLIC_URL host>/cast-receiver/, registered as CAST_RECEIVER_APP_ID in the Google
 * Cast console). A plain endpoint, not an app page: the TV loads no app shell, no session, no service worker. Its own CSP (the app
 * pages' CSP in vite.config.ts stays as it is) allows Google's receiver framework, on this path only.
 */
export const trailingSlash = 'always';
export const prerender = false;

export const GET: RequestHandler = () => new Response(receiverHtml(), {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': RECEIVER_CSP,
    'cache-control': 'no-cache',
    'x-frame-options': 'DENY',
  },
});
