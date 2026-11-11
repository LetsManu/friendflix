// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What FriendFlix's own Chromecast receiver says it plays (`{ t: 'caps', v: 1, hevc, hevc10, surround }`, web/static/cast-receiver/logic.js),
 * what the sender attaches to its cast request, and what a failure makes it forget: `ff-cast-avoid` remembers per device NAME which feature
 * (HEVC, surround) failed on that TV, for 30 days (the web player's `ff_devcaps_avoid` does the same per user agent). Nothing here is ever
 * claimed before the receiver confirmed it; a receiver that never answers claims nothing.
 */
import type { Store } from './resume';

export type SurroundCodec = 'eac3' | 'ac3';
export interface ReceiverCaps { hevc: boolean; hevc10: boolean; surround: SurroundCodec[] }
export type CastFeature = 'hevc' | 'surround';
/** `delivery` of the cast answer (backend StreamDelivery): fixed codes and numbers only, sent only with receiver caps */
export interface CastDelivery { video: 'copy' | 'h264' | 'hevc'; videoCodec: 'h264' | 'hevc'; audio: 'copy' | 'stereo' | 'surround'; audioCodec: string; channels: number; why: string[] }

/** the receiver's caps message: exact shape, version 1; null for anything else (also when it claims nothing wrongly typed) */
export function parseReceiverCaps(raw: unknown): ReceiverCaps | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.t !== 'caps' || m.v !== 1 || typeof m.hevc !== 'boolean' || typeof m.hevc10 !== 'boolean' || !Array.isArray(m.surround)) return null;
  const got = new Set(m.surround.slice(0, 8));
  return { hevc: m.hevc, hevc10: m.hevc && m.hevc10, surround: [...(got.has('eac3') ? ['eac3' as const] : []), ...(got.has('ac3') ? ['ac3' as const] : [])] };
}

/** the `caps` of POST /api/cast/session: undefined when nothing is claimed (then the request is the Default Media Receiver's) */
export function castCapsBody(c: ReceiverCaps | null): { hevc: boolean; hevc10: boolean; surround: SurroundCodec[] } | undefined {
  if (!c || (!c.hevc && !c.surround.length)) return undefined;
  return { hevc: c.hevc, hevc10: c.hevc && c.hevc10, surround: [...c.surround] };
}

export const AVOID_KEY = 'ff-cast-avoid';
export const AVOID_MS = 30 * 86_400_000;
const AVOID_DEVICES = 20;
type Avoid = Record<string, { hevc?: number; surround?: number }>;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nameOf = (device: string) => device.trim().slice(0, 80);
function read(store: Store): Avoid {
  try {
    const o: unknown = JSON.parse(store?.getItem(AVOID_KEY) ?? 'null');
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Avoid = {};
    for (const [name, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      const hevc = finite(e.hevc) ? e.hevc : undefined, surround = finite(e.surround) ? e.surround : undefined;
      if (hevc !== undefined || surround !== undefined) out[name] = { ...(hevc !== undefined ? { hevc } : {}), ...(surround !== undefined ? { surround } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

/** which features this TV (by name) is not asked for now: remembered failures younger than 30 days */
export function avoidedOf(store: Store, device: string, now: number): Record<CastFeature, boolean> {
  const e = read(store)[nameOf(device)];
  return { hevc: e?.hevc !== undefined && now - e.hevc < AVOID_MS, surround: e?.surround !== undefined && now - e.surround < AVOID_MS };
}

/** remembers that `features` failed on this TV (expired entries and all but the 20 newest devices are dropped); never throws */
export function noteAvoid(store: Store, device: string, features: CastFeature[], now: number): void {
  const name = nameOf(device);
  if (!store || !name || !features.length) return;
  try {
    const all = read(store);
    for (const f of features) all[name] = { ...all[name], [f]: now };
    const alive = Object.entries(all).filter(([, e]) => (e.hevc !== undefined && now - e.hevc < AVOID_MS) || (e.surround !== undefined && now - e.surround < AVOID_MS));
    alive.sort((a, b) => Math.max(b[1].hevc ?? 0, b[1].surround ?? 0) - Math.max(a[1].hevc ?? 0, a[1].surround ?? 0));
    store.setItem(AVOID_KEY, JSON.stringify(Object.fromEntries(alive.slice(0, AVOID_DEVICES))));
  } catch { /* storage full or blocked */ }
}

/** the caps without the features this TV failed on */
export function applyAvoid(c: ReceiverCaps, avoided: Record<CastFeature, boolean>): ReceiverCaps {
  const hevc = c.hevc && !avoided.hevc;
  return { hevc, hevc10: hevc && c.hevc10, surround: avoided.surround ? [] : [...c.surround] };
}

/** the features a cast really carried (the server's fixed codes): HEVC in the picture, more than two channels in the sound */
export function usedFeatures(d: CastDelivery | null | undefined): CastFeature[] {
  const out: CastFeature[] = [];
  if (d?.videoCodec === 'hevc') out.push('hevc');
  if (typeof d?.channels === 'number' && d.channels > 2) out.push('surround');
  return out;
}
