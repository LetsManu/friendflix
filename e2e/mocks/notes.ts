// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The notifications center (backend/src/notifications): a stateful feed of 70 groups over 3 pages (30 groups each), sections
 * *Heute*, *Diese Woche* and the previous calendar month, six "TV connected" entries in one group, one broadcast. GET
 * /api/notifications/feed (limit=0: the counts only; limit=5: Mein Bereich's newest five groups), POST /read, /hide (an undo token) and /unhide. The legacy GET
 * /api/notifications keeps its fixed answer unless `legacyFromFeed` (then: the newest 30 visible entries, so its unread count
 * matches the feed's).
 */
export const NOTE_CATEGORIES = ['downloads', 'devices', 'series', 'achievements', 'livetv', 'system', 'requests', 'social', 'other'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];
export interface NoteEntry { id: number; kind: string; category: NoteCategory; title: string; body: string | null; link: string | null; at: string; read: boolean; hidden: boolean; broadcast?: boolean }
export interface NotesMock {
  entries: NoteEntry[];
  /** undo tokens of /hide → the entry ids they cleared */
  tokens: Map<string, number[]>;
  /** the legacy list follows the feed (default: its fixed single entry, as before the notifications center) */
  legacyFromFeed: boolean;
  nextId: number;
}

const PAGE = 30;
const ITEMS = 20;
/** kinds that never group (backend NEVER_GROUPED) */
const SINGLE = new Set(['update_available', 'update_failed', 'syscheck_problem', 'pin_locked', 'deletion_requested', 'deletion_done', 'deletion_failed', 'deletion_restored', 'access_ended', 'access_soon']);

const startOfToday = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
/** the calendar month before this one, as the feed's section key ('YYYY-MM') and a date inside it */
export function prevMonth(now = new Date()): { key: string; date: Date } {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, date: d };
}
/** the web's label of that section (lib/notifications/look.ts sectionLabel) */
export function prevMonthLabel(now = new Date()): string {
  const { date } = prevMonth(now);
  const m = new Intl.DateTimeFormat('de', { month: 'long' }).format(date);
  return date.getFullYear() === now.getFullYear() ? m : `${m} ${date.getFullYear()}`;
}
function sectionOf(at: string, now = new Date()): string {
  const d = new Date(at), today = startOfToday(now);
  if (d >= today) return 'today';
  if (d >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)) return 'week';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const keyOf = (e: NoteEntry) => (SINGLE.has(e.kind) ? `${e.kind}|id:${e.id}` : `${e.kind}|${e.title}`);
const groupIdOf = (e: NoteEntry) => `${sectionOf(e.at)}|${keyOf(e)}`;

export function notesState(): NotesMock {
  const now = Date.now(), today = startOfToday().getTime();
  /** today, `min` minutes ago (never before midnight: shortly after it the entries crowd into the first minutes, in the same order) */
  const todayAt = (min: number) => new Date(Math.max(today + (600 - min) * 1000, now - min * 60_000)).toISOString();
  const daysAgo = (d: number, h = 12) => new Date(today - d * 864e5 + h * 3600e3).toISOString();
  const st: NotesMock = { entries: [], tokens: new Map(), legacyFromFeed: false, nextId: 1 };
  const add = (e: Omit<NoteEntry, 'id' | 'hidden'>) => st.entries.push({ ...e, id: st.nextId++, hidden: false });
  // Heute: 4 groups
  for (let k = 0; k < 6; k++) add({ kind: 'tv_paired', category: 'devices', title: 'Ein Fernseher wurde mit deinem Konto verbunden', body: `Sternwarte 24 · Wohnzimmer ${6 - k}`, link: '/devices', at: todayAt(10 + k * 12), read: false });
  add({ kind: 'download_ready', category: 'downloads', title: 'Nordlicht ist bereit', body: 'Zum Ansehen ohne Internet gespeichert.', link: '/downloads', at: todayAt(100), read: false });
  add({ kind: 'party_invite', category: 'social', title: 'Anna Beispiel lädt dich zur Watch-Party ein', body: 'Hafenkanal, heute um 20:15', link: '/party', at: todayAt(110), read: false });
  add({ kind: 'achievement', category: 'achievements', title: 'Neues Achievement: Nachteule', body: 'Fünf Filme nach Mitternacht.', link: null, at: todayAt(120), read: true });
  // Diese Woche: 6 groups, one of them a broadcast
  add({ kind: 'update_available', category: 'system', title: 'Version 1.4 ist da', body: 'Neue Funktionen und Fehlerbehebungen.', link: '/admin/updates', at: daysAgo(1), read: true, broadcast: true });
  add({ kind: 'request_available', category: 'requests', title: 'Dein Wunsch „Hafenkanal“ ist verfügbar', body: null, link: '/requests', at: daysAgo(2), read: true });
  add({ kind: 'episode', category: 'series', title: 'Neue Folge: Sternwarte 24', body: 'Staffel 2, Folge 3', link: '/new', at: daysAgo(3), read: true });
  add({ kind: 'livetv.recording', category: 'livetv', title: 'Aufnahme fertig: Nordlicht-Doku', body: null, link: '/live/recordings', at: daysAgo(4), read: true });
  add({ kind: 'recommend', category: 'social', title: 'Ben Muster hat dir „Hafenkanal“ empfohlen', body: 'Das musst du sehen!', link: '/new', at: daysAgo(5), read: true });
  add({ kind: 'digest', category: 'series', title: 'Dein Wochenrückblick', body: 'Drei neue Folgen deiner Serien.', link: '/digest', at: daysAgo(6), read: true });
  // the previous calendar month: 60 groups
  const base = prevMonth().date.getTime();
  for (let i = 0; i < 60; i++) {
    add({ kind: 'episode', category: 'series', title: `Neue Folge: Hafenkanal – Folge ${60 - i}`, body: `Staffel 1, Folge ${60 - i}`, link: '/new', at: new Date(base - i * 3600e3).toISOString(), read: true });
  }
  return st;
}

const visible = (st: NotesMock) => st.entries.filter((e) => !e.hidden).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
const shows = (e: NoteEntry, filter: string) => filter === 'all' || (filter === 'unread' ? !e.read : e.category === filter);

function counts(st: NotesMock) {
  const vis = visible(st);
  return { unread: vis.filter((e) => !e.read).length, categories: NOTE_CATEGORIES.map((key) => ({ key, n: vis.filter((e) => e.category === key).length })).filter((c) => c.n > 0) };
}

function feed(st: NotesMock, filter: string, cursor: string | null, limit = PAGE) {
  const groups = new Map<string, NoteEntry[]>();
  for (const e of visible(st).filter((x) => shows(x, filter))) {
    const id = groupIdOf(e);
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  const all = [...groups.entries()];
  const start = cursor ? Number(cursor) : 0;
  const sections: Array<{ key: string; groups: unknown[] }> = [];
  for (const [id, es] of all.slice(start, start + limit)) {
    const top = es[0]!, key = sectionOf(top.at);
    if (sections.at(-1)?.key !== key) sections.push({ key, groups: [] });
    sections.at(-1)!.groups.push({
      id, kind: top.kind, category: top.category, title: top.title, body: top.body, link: top.link, at: top.at, count: es.length, unread: es.some((x) => !x.read),
      items: es.slice(0, ITEMS).map((x) => ({ id: x.id, title: x.title, body: x.body, at: x.at })),
    });
  }
  return { sections, next: start + limit < all.length ? String(start + limit) : null, ...counts(st) };
}

/** the visible entries a selection names (ids, feed group ids, a filter) */
function selected(st: NotesMock, sel: { ids?: number[]; groups?: string[]; category?: string }): NoteEntry[] {
  return visible(st).filter((e) => !!sel.ids?.includes(e.id) || !!sel.groups?.includes(groupIdOf(e)) || (sel.category !== undefined && shows(e, sel.category)));
}

type Reply = (b: unknown, status?: number) => Promise<void>;
let tokenSeq = 0;

/** the notification routes; null for any other path (and for the legacy list unless `legacyFromFeed`: api.ts keeps its fixed answer) */
export function notesRoute(st: NotesMock, m: string, p: string, sp: URLSearchParams, body: () => any, J: Reply): Promise<void> | null {
  if (p === '/api/notifications' && m === 'GET' && st.legacyFromFeed) {
    return J({ notifications: visible(st).slice(0, 30).map((e) => ({ id: e.id, kind: e.kind, title: e.title, body: e.body, link: e.link, created_at: e.at, read: e.read })) });
  }
  if (p === '/api/notifications/feed' && m === 'GET') {
    if (sp.get('limit') === '0') return J(counts(st));
    const limit = sp.get('limit');
    return J(feed(st, sp.get('filter') || 'all', sp.get('cursor'), limit ? Math.min(Math.max(1, Number(limit)), PAGE) : PAGE));
  }
  if (p === '/api/notifications/read' && m === 'POST') {
    const sel = body();
    for (const e of Object.keys(sel).length ? selected(st, sel) : visible(st)) e.read = true;
    return J({ ok: true });
  }
  if (p === '/api/notifications/hide' && m === 'POST') {
    const hit = selected(st, body());
    for (const e of hit) e.hidden = true;
    const token = `undo-${++tokenSeq}`;
    st.tokens.set(token, hit.map((e) => e.id));
    return J({ undo: token, n: hit.length });
  }
  if (p === '/api/notifications/unhide' && m === 'POST') {
    const ids = st.tokens.get(body().token);
    if (!ids) return J({ error: 'undo_expired' }, 404);
    st.tokens.delete(body().token);
    for (const e of st.entries) if (ids.includes(e.id)) e.hidden = false;
    return J({ n: ids.length });
  }
  return null;
}

/** a new unread entry today (the newest: also shortly after midnight, when the fixed ones crowd into the first minutes), as the backend would add it */
export function addNote(st: NotesMock, title = 'Hafenkanal ist bereit'): NoteEntry {
  const at = new Date(Math.max(Date.now(), ...st.entries.map((x) => Date.parse(x.at) + 1000))).toISOString();
  const e: NoteEntry = { id: st.nextId++, kind: 'download_ready', category: 'downloads', title, body: 'Zum Ansehen ohne Internet gespeichert.', link: '/downloads', at, read: false, hidden: false };
  st.entries.push(e);
  return e;
}
