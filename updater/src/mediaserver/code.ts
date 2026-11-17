// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';

/**
 * The media base code (spec "Base folder"): 12 Crockford base32 symbols shown as XXXX-XXXX-XXXX. It goes to the updater's stdout in one
 * line and nowhere else; only its sha256 is kept. Same rules as backend/src/setup/code.ts.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 symbols, so `byte & 31` is unbiased
const CODE_LEN = 12;

export function newBaseCode(): { display: string; hash: string } {
  const raw = [...randomBytes(CODE_LEN)].map((b) => ALPHABET[b & 31]).join('');
  return { display: raw.match(/.{4}/g)!.join('-'), hash: hashBaseCode(raw) };
}

/** what a person types, as stored: upper case without spaces and dashes; O reads as 0, I and L as 1 */
export function normalizeBaseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function hashBaseCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/** the one log line that carries the code */
export function baseCodeLogLine(path: string, display: string, expiresAt: Date): string {
  return `FriendFlix media folder: to allow ${path} as the media base folder, enter the code ${display} in Admin (valid until ${expiresAt.toISOString().slice(11, 16)} UTC).`;
}
