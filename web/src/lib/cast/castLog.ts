// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The on-device cast log (Diagnose, "Copy report"): a ring buffer of the last 200 events in localStorage.
 * Nothing is uploaded. Every text goes through `scrub()`: no URLs, tokens, ids, castIds or addresses.
 */
import type { Store } from './resume';

export type CastLevel = 'info' | 'warn' | 'error';
export type CastTag = 'session' | 'load' | 'receiver' | 'queue' | 'network' | 'renew' | 'sender' | 'test';
export interface CastLogEntry { at: number; level: CastLevel; tag: CastTag; text: string }

export const CAST_LOG_KEY = 'ff-castlog', CAST_LOG_MAX = 200;

const H = '[0-9a-fA-F]{1,4}';
const IPV6 = new RegExp(`(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?|::(?:${H}:){0,6}${H}`, 'g');
/** replaces everything that could identify a stream, an item or a network with `…` */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…')
    .replace(/(^|[\s("'=,;])\/\/\S+/g, '$1…')
    .replace(/\/media\/c\/\S*/g, '…')
    .replace(/[A-Za-z0-9_-]{32,}/g, '…') // also covers 32+ hex ids
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '…')
    .replace(IPV6, '…');
}

function defaultStore(): Store {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
const LEVELS = new Set<string>(['info', 'warn', 'error']);
const TAGS = new Set<string>(['session', 'load', 'receiver', 'queue', 'network', 'renew', 'sender', 'test']);

export function readCastLog(store: Store = defaultStore()): CastLogEntry[] {
  try {
    const raw = store?.getItem(CAST_LOG_KEY);
    if (!raw) return [];
    const a: unknown = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.filter((e): e is CastLogEntry => !!e && typeof e === 'object'
      && typeof (e as CastLogEntry).at === 'number' && LEVELS.has((e as CastLogEntry).level) && TAGS.has((e as CastLogEntry).tag) && typeof (e as CastLogEntry).text === 'string');
  } catch {
    return [];
  }
}
/** appends one entry (text scrubbed) and keeps the last 200; never throws */
export function castLog(e: Omit<CastLogEntry, 'at'>, now: number = Date.now(), store: Store = defaultStore()): void {
  if (!store) return;
  try {
    const list = readCastLog(store);
    list.push({ at: now, level: e.level, tag: e.tag, text: scrub(e.text) });
    store.setItem(CAST_LOG_KEY, JSON.stringify(list.slice(-CAST_LOG_MAX)));
  } catch { /* storage full or blocked */ }
}
export const CAST_LOG_DEVICES_KEY = 'ff-castlog-devices';
/** remembers a TV's name seen in the log (at most 20) so the copied report can anonymise names of earlier sessions too */
export function noteCastDevice(name: string, store: Store = defaultStore()): void {
  const n = name.trim().slice(0, 80);
  if (!n || !store) return;
  try {
    const list = castLogDevices(store).filter((d) => d !== n);
    list.push(n);
    store.setItem(CAST_LOG_DEVICES_KEY, JSON.stringify(list.slice(-20)));
  } catch { /* storage full or blocked */ }
}
export function castLogDevices(store: Store = defaultStore()): string[] {
  try {
    const a: unknown = JSON.parse(store?.getItem(CAST_LOG_DEVICES_KEY) ?? '[]');
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function clearCastLog(store: Store = defaultStore()): void {
  try { store?.removeItem(CAST_LOG_KEY); store?.removeItem(CAST_LOG_DEVICES_KEY); } catch { /* storage blocked */ }
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** the plain-text report for a bug report (for maintainers: headings stay English; times are local, the header names the offset): card rows, the events, the AirPlay log; device names become "TV 1", "TV 2" by first appearance */
export function castReport(o: { rows: Array<[string, string]>; entries: CastLogEntry[]; air: string; devices: string[] }): string {
  const off = -new Date().getTimezoneOffset();
  const zone = `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  const text = [
    `FriendFlix casting report (times ${zone})`,
    '',
    ...o.rows.map(([k, v]) => `${k}: ${scrub(v)}`),
    '',
    'Events',
    ...(o.entries.length ? o.entries.map((e) => `${stamp(e.at)} ${e.level} ${e.tag} ${scrub(e.text)}`) : ['(none)']),
    '',
    'AirPlay log',
    o.air ? scrub(o.air) : '(none)',
  ].join('\n');
  return anonymise(text, o.devices);
}

/** the events as plain text for "Copy" on Diagnose: one line each, scrubbed, TV names anonymised like the report */
export const eventsText = (entries: CastLogEntry[], devices: string[]): string =>
  anonymise(entries.map((e) => `${stamp(e.at)} ${e.level} ${e.tag} ${scrub(e.text)}`).join('\n'), devices);

/** replaces every TV name in `text` with "TV 1", "TV 2" (numbered by first appearance); longest names first, so a name inside another never splits it */
export function anonymise(text: string, devices: string[]): string {
  const names = [...new Set(devices.map((d) => d.trim()).filter(Boolean))];
  if (!names.length) return text;
  const re = new RegExp([...names].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g');
  const label = new Map<string, string>();
  for (const m of text.matchAll(re)) if (!label.has(m[0])) label.set(m[0], `TV ${label.size + 1}`);
  return text.replace(re, (m) => label.get(m)!);
}
