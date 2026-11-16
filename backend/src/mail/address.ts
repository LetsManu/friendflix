// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, hkdfSync } from 'node:crypto';
import { z } from 'zod';

/**
 * E-mail addresses (docs/superpowers/specs/2026-11-16-mail-design.md): a full address never reaches a log, an audit row or an error
 * text; at most its masked form does. Rate limits and lookups use a keyed hash of the address instead of the address itself.
 */
const email = z.email();

/** An address zod's e-mail check accepts (no display name, no whitespace, so no header injection). */
export function isMailAddress(s: string): boolean {
  return email.safeParse(s).success;
}

/** `anna@friend.example.com` -> `a…@friend.example.com`; anything without a local part and a domain -> `…`. */
export function maskAddress(addr: string): string {
  const at = addr.lastIndexOf('@');
  const local = at > 0 ? addr.slice(0, at) : '';
  const domain = at > 0 ? addr.slice(at + 1) : '';
  if (!local || !domain) return '…';
  return `${Array.from(local)[0]}…@${domain}`;
}

/** A 32-byte key for one purpose, derived from APP_ENC_KEY (HKDF-SHA256), so a hash or token never uses the encryption key itself. */
export function mailSubkey(encKey: Buffer, purpose: 'recipient' | 'unsubscribe'): Buffer {
  return Buffer.from(hkdfSync('sha256', encKey, 'friendflix-mail', `${purpose} v1`, 32));
}

/** The keyed hash (hex HMAC-SHA256) of an address, the same for any case and surrounding whitespace. */
export function recipientKey(encKey: Buffer, addr: string): string {
  return createHmac('sha256', mailSubkey(encKey, 'recipient')).update(addr.trim().toLowerCase()).digest('hex');
}
