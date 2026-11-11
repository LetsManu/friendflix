// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

const REFUSED = /[\p{Cc}‪-‮⁦-⁩]/u;

/**
 * The user's own name for a device (spec 2.8). `null` or blank resets it. Control and bidi characters are refused on the
 * whole raw input first (so a tab inside is refused, not collapsed); then NFC, trim, inner whitespace runs to one space,
 * 1 to 40 code points.
 */
export function cleanDeviceName(raw: unknown): { ok: true; name: string | null } | { ok: false } {
  if (raw === null) return { ok: true, name: null };
  if (typeof raw !== 'string' || REFUSED.test(raw)) return { ok: false };
  const s = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!s) return { ok: true, name: null };
  return [...s].length <= 40 ? { ok: true, name: s } : { ok: false };
}
