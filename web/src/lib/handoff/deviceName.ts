// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClientKind } from '#lib/api';
import type { TFn } from '#lib/i18n';

/** the display rule (spec 2.8): custom name, else the client kind's name (not for web), else the stored label, else "unknown" */
export function deviceName(d: { kind?: ClientKind | null; name?: string | null; label?: string | null }, tf: TFn): string {
  if (d.name) return d.name;
  switch (d.kind) {
    case 'tizen': return tf('common.deviceKind.tizen');
    case 'webos': return tf('common.deviceKind.webos');
    case 'firetv': return tf('common.deviceKind.firetv');
    case 'desktop': return tf('common.deviceKind.desktop');
    case 'android': return tf('common.deviceKind.android');
    default: return d.label || tf('common.unknown');
  }
}

/** "AirPlay (Safari auf iPhone)": a cast row, named after the sending device */
export function castLabel(via: 'airplay' | 'chromecast', sender: string, tf: TFn): string {
  return tf(via === 'airplay' ? 'common.deviceKind.airplay' : 'common.deviceKind.chromecast', { sender });
}

// the same rules as backend/src/deviceName.ts (cleanDeviceName); test-vectors/device-names.json keeps both honest
const REFUSED = /[\p{Cc}\p{Cs}‪-‮⁦-⁩‎‏؜]/u;
const NOT_VISIBLE = /^[\p{Cf}\p{Z}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}⠀]*$/u;

/** the form's check: refused characters first (on the raw input), then NFC, trim, collapse; no visible character = reset (null); 1 to 40 code points */
export function cleanName(raw: string): { ok: true; name: string | null } | { ok: false } {
  if (REFUSED.test(raw)) return { ok: false };
  const s = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (NOT_VISIBLE.test(s)) return { ok: true, name: null };
  return [...s].length <= 40 ? { ok: true, name: s } : { ok: false };
}
