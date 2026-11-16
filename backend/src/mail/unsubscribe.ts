// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mailSubkey } from './address.js';
import { isMailPrefType, type MailPrefType } from './people.js';

/**
 * The unsubscribe token (spec "Unsubscribe (stage B)", plan Controller's call 1): `v1.<userId>.<type>.<mac>`, mac = base64url
 * HMAC-SHA256 with the `unsubscribe` subkey of APP_ENC_KEY over `v1|<userId>|<type>`. Per person and type, no expiry (a link in
 * an old mail still works); rotating APP_ENC_KEY invalidates old links. Every part is URL-safe as it is. The token is the only
 * authorisation of the public unsubscribe routes, so it never reaches a log.
 */
const TOKEN = /^v1\.([0-9a-f-]{36})\.([a-z]{1,20})\.([A-Za-z0-9_-]{43})$/;
/** longer than any valid token: rejected before the regex */
const MAX_LEN = 128;

const mac = (encKey: Buffer, userId: string, type: string) =>
  createHmac('sha256', mailSubkey(encKey, 'unsubscribe')).update(`v1|${userId}|${type}`).digest('base64url');

export function unsubscribeToken(encKey: Buffer, userId: string, type: MailPrefType): string {
  return `v1.${userId}.${type}.${mac(encKey, userId, type)}`;
}

/** The person and type a token names, or null for anything not signed with this key (compared in constant time). */
export function verifyUnsubscribeToken(encKey: Buffer, token: string): { userId: string; type: MailPrefType } | null {
  try {
    if (typeof token !== 'string' || token.length > MAX_LEN) return null;
    const m = TOKEN.exec(token);
    if (!m) return null;
    const [, userId, type, got] = m as unknown as [string, string, string, string];
    if (!isMailPrefType(type)) return null;
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(mac(encKey, userId, type), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b) ? { userId, type } : null;
  } catch {
    return null;
  }
}

/** The footer link (the confirm page) and the List-Unsubscribe target (RFC 8058 one-click POST). */
export function unsubscribeUrls(origin: string, token: string): { page: string; oneClick: string } {
  const t = encodeURIComponent(token);
  return { page: `${origin}/mail/unsubscribe?t=${t}`, oneClick: `${origin}/api/public/mail/unsubscribe?t=${t}` };
}
