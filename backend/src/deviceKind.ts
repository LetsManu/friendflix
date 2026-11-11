// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';

export type ClientKind = 'web' | 'tizen' | 'webos' | 'firetv' | 'desktop' | 'android';

/** Which kind of client a user agent belongs to (a display hint for the account's own devices; precedence as listed). */
export function clientKind(ua: string): ClientKind {
  if (ua.includes(' FriendFlixFireTV/')) return 'firetv';
  if (ua.includes(' FriendFlixTizen/') || (ua.includes('Tizen') && ua.includes('SMART-TV'))) return 'tizen';
  if (ua.includes('Web0S')) return 'webos';
  if (ua.includes(' FriendFlixDesktop/')) return 'desktop';
  if (ua.includes(' FriendFlixAndroid/')) return 'android';
  return 'web';
}

/**
 * Stores the kind of the device when it differs from the stored one (one conditional update).
 * `keepSpecific` (GET /api/me): never downgrade a stored kind to `web`; the native players call /api/me with their own HTTP
 * client (OkHttp, reqwest) and the WebView's cookie, which says nothing about the device.
 */
export async function noteClientKind(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string, ua: string, keepSpecific = false): Promise<void> {
  const guard = keepSpecific ? " and (client is null or $3 <> 'web')" : '';
  await ctx.db.query(`update devices set client = $3 where user_id = $1 and device_id = $2 and client is distinct from $3${guard}`, [userId, deviceId, clientKind(ua)]);
}
