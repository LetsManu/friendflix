// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api, fmtClock, type ClientKind } from '#lib/api';
import { fmtRelative, type TFn } from '#lib/i18n';
import { castLabel, deviceName } from './deviceName';

/** GET /api/handoff's answer (backend/src/handoff.ts HandoffAnswer): what another device played last, how far and when */
export interface Handoff {
  /** opaque, stable while that device plays that title */
  id: string;
  itemId: string;
  type: 'Movie' | 'Episode';
  title: string;
  year?: number | undefined;
  seriesName?: string | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  imageId: string;
  positionTicks: number;
  runtimeTicks?: number | undefined;
  ageSec: number;
  device: { kind: ClientKind; name?: string | undefined; via?: 'airplay' | 'chromecast' | undefined };
}

/** the offer for this profile (of the title or series `item` if given); any error (offline, 401, 5xx) is "no offer" */
export async function loadHandoff(item?: string): Promise<Handoff | null> {
  try {
    const r = (await api(`/api/handoff${item ? `?item=${encodeURIComponent(item)}` : ''}`)) as { handoff?: Handoff | null };
    return r?.handoff ?? null;
  } catch {
    return null;
  }
}

/** the title page's hint (spec 2.5): the answer only when it is for what the Play button would play */
export const hintFor = (h: Handoff | null, playTarget: string): Handoff | null => (h && playTarget && h.itemId === playTarget ? h : null);

// ---- dismissal: per device, the last DISMISS_MAX ids (spec 2.4) ----
export const DISMISS_KEY = 'ff-handoff-dismissed';
export const DISMISS_MAX = 20;
/** without usable storage the dismissal lasts until the page is left */
const memory = new Set<string>();
const store = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/** the stored ids; null = no usable storage (missing, blocked or throwing) */
function read(s: Storage | null): string[] | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch (e) {
    return e instanceof SyntaxError ? [] : null; // a broken value is an empty list, a throwing storage is none
  }
}

export function isDismissed(id: string, s: Storage | null = store()): boolean {
  const ids = read(s);
  return ids ? ids.includes(id) : memory.has(id);
}

export function dismiss(id: string, s: Storage | null = store()): void {
  const ids = read(s);
  if (ids) {
    try { s!.setItem(DISMISS_KEY, JSON.stringify([...ids.filter((x) => x !== id), id].slice(-DISMISS_MAX))); return; } catch { /* fall through to memory */ }
  }
  memory.add(id);
}

// ---- text ----
/** "LG-Fernseher", "AirPlay (Safari auf iPhone)" (spec 2.6) */
export function handoffDevice(h: Handoff, tf: TFn): string {
  const sender = deviceName({ kind: h.device.kind, name: h.device.name }, tf);
  return h.device.via ? castLabel(h.device.via, sender, tf) : sender;
}

/** the player's format: m:ss, h:mm:ss from one hour */
export const handoffTime = (ticks: number): string => fmtClock(Math.floor(ticks / 1e7));

/** "gerade eben" under 2 minutes, else "vor 12 Minuten" */
export function handoffAge(ageSec: number, tf: TFn, now: number = Date.now()): string {
  return ageSec < 120 ? tf('home.handoff.justNow') : fmtRelative(now - ageSec * 1000, now);
}

/** "Dunmoor S1:F4 · The Lantern Road"; films "title · year" */
export function handoffTitle(h: Handoff, tf: TFn): string {
  if (h.type === 'Episode' && h.seriesName) {
    const code = h.season != null && h.episode != null ? ` ${tf('detail.view.episodeCode', { s: h.season, e: h.episode })}` : '';
    return `${h.seriesName}${code} · ${h.title}`;
  }
  return h.year ? `${h.title} · ${h.year}` : h.title;
}

/** the web player at the shown position */
export const handoffHref = (h: Handoff): string => `/watch/${h.itemId}?t=${Math.floor(h.positionTicks / 1e7)}`;

// ---- TV remote (spec 2.4) ----
/** how long after the page's mount an arriving card may still take the focus */
export const TAKE_FOCUS_MS = 2000;

/**
 * TV: the card's primary button takes the focus only when the card arrives within 2 s of the page's mount and no key was
 * pressed yet; later it would pull the focus away from where the viewer is, so it waits to be reached with Up.
 */
export function shouldTakeFocus(o: { mountedAt: number; arrivedAt: number; keyPressed: boolean }): boolean {
  const dt = o.arrivedAt - o.mountedAt;
  return !o.keyPressed && dt >= 0 && dt <= TAKE_FOCUS_MS;
}
