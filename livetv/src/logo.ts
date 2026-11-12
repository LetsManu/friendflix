// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { guardedFetch, type GuardDeps } from './fetch.js';

/**
 * Channel logos (spec §3.4): at most 512 KB, PNG / JPEG / WebP recognised by their magic bytes only; the server's content type is
 * never trusted, and SVG (scriptable) is refused.
 */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_TIMEOUT_MS = 10_000;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** the image type by magic bytes only; anything else (SVG, GIF, HTML) → null */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (startsWith(b, PNG)) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

export class LogoError extends Error {
  constructor(readonly code: 'not_image') {
    super(code);
    this.name = 'LogoError';
  }
}

/** fetch a logo through the guard (≤ 512 KB → else `too_big`, 10 s) and check its bytes (`not_image`) */
export async function fetchLogo(url: string, allowLan: boolean, guard: GuardDeps): Promise<{ type: ImageType; bytes: Buffer }> {
  const res = await guardedFetch(url, { allowLan, timeoutMs: LOGO_TIMEOUT_MS, maxBytes: LOGO_MAX_BYTES }, guard);
  const parts: Buffer[] = [];
  for await (const c of res.body) parts.push(Buffer.from(c));
  const bytes = Buffer.concat(parts);
  const type = sniffImage(bytes);
  if (!type) throw new LogoError('not_image');
  return { type, bytes };
}
