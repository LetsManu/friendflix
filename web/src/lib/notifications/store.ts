// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable, type Readable } from 'svelte/store';
import { apiCode } from '#lib/api';
import { defaultApi, type NotesApi } from './api';
import type { Counts, Feed, FeedGroup, Filter, Section, Selection } from './types';

export interface FeedState {
  filter: Filter;
  sections: Section[];
  next: string | null;
  loading: 'idle' | 'first' | 'refresh' | 'more';
  error: string | null;
  /** unread entries that arrived since the first page was loaded (shown as a pill; never inserted as rows) */
  fresh: number;
  open: Set<string>;
  /** unread entries as this page knows them (the last load, less what was read or cleared here since) */
  unread: number;
  /** the categories with entries at the last load (global: they do not follow the filter) */
  categories: Counts['categories'];
  /** bumped by reset(): the page belongs to another person now (an open sheet loads theirs) */
  person: number;
}

export interface FeedStore extends Readable<FeedState> {
  load(filter: Filter): Promise<void>;
  /** back to the empty state (logout, profile switch): nothing of the previous person stays in memory */
  reset(): void;
  more(): Promise<void>;
  refresh(): Promise<void>;
  noteFresh(unreadNow: number): void;
  toggle(groupId: string): void;
  /** false when the server refused it (the groups are unread again, `error` set) */
  read(sel?: Selection): Promise<boolean>;
  /** the undo token and how many entries went, or null when the clear failed */
  hide(sel: Selection): Promise<{ undo: string; n: number } | null>;
  /** true when the entries are back */
  undo(token: string): Promise<boolean>;
  /** ms Rückgängig may still be offered for `token` (the server's 30 s less UNDO_MARGIN_MS); 0 once it may not */
  undoLeft(token: string): number;
}

interface Removed { group: FeedGroup; section: string; index: number; sectionIndex: number }
/** undo tokens handed out since the last reset() (this person): when the answer came, and the rows to put back while they are still on this page */
export type HeldTokens = Map<string, { at: number; removed: Removed[] | null }>;

/** the server keeps an undo token for 30 s; one held longer than that is dead */
const UNDO_TTL_MS = 30_000;
/** the undo offer ends this much earlier: a press just before the end still reaches the server in time */
const UNDO_MARGIN_MS = 2_000;

const errorOf = (e: unknown) => apiCode(e) ?? 'error';
const copy = (s: Section[]): Section[] => s.map((x) => ({ key: x.key, groups: [...x.groups] }));
const hits = (g: FeedGroup, sel: Selection) =>
  !!sel.groups?.includes(g.id) ||
  (sel.category !== undefined && (sel.category === 'all' || (sel.category === 'unread' ? g.unread : g.category === sel.category))) ||
  // only when every row of the group is known (count === items.length); else the next refresh corrects it
  (!!sel.ids?.length && g.count === g.items.length && g.items.length > 0 && g.items.every((i) => sel.ids!.includes(i.id)));
/** unread entries a group stands for (a partly read group only its unread ones: the server lowers its count by those) */
const unreadOf = (g: FeedGroup) => (g.unread ? g.unreadCount : 0);
const everything = (sel: Selection) => !sel.ids?.length && !sel.groups?.length && sel.category === undefined;

export function createFeed(api: NotesApi = defaultApi, held: HeldTokens = new Map()): FeedStore {
  let epoch = 0; // bumped only by reset(): a newer person
  const initial = (): FeedState => ({ filter: 'all', sections: [], next: null, loading: 'idle', error: null, fresh: 0, open: new Set(), unread: 0, categories: [], person: epoch });
  const { subscribe, update, set } = writable<FeedState>(initial());
  let state!: FeedState;
  subscribe((s) => (state = s));
  let gen = 0; // a newer load / refresh makes older answers obsolete
  let baseUnread = 0;
  /** the layout's last unread count since this page loaded (null: none yet), so a new baseline corrects the pill as well */
  let lastNow: number | null = null;
  /** the first page's snapshot (Feed.max: the newest entry id then); 0 before a page arrived */
  let snapMax = 0;
  const freshOf = (base: number) => (lastNow === null ? 0 : Math.max(0, lastNow - base));
  /** the page's unread baseline, mirrored into the state for the sheet's header, and the pill counted against it */
  const setBase = (n: number) => {
    baseUnread = n;
    update((s) => { const fresh = freshOf(n); return s.unread === n && s.fresh === fresh ? s : { ...s, unread: n, fresh }; });
  };
  /**
   * The server's counts after a clear or its undo: the page only knows its own rows, so entries on pages not loaded (a clear by
   * filter) and the categories that went or came back are read again. A failure keeps the local counts.
   */
  const recount = async (e0: number) => {
    try {
      const c = await api.counts();
      if (e0 !== epoch) return;
      setBase(c.unread);
      update((s) => ({ ...s, categories: c.categories }));
    } catch { /* the local counts stay */ }
  };
  const prune = () => {
    const now = Date.now();
    for (const [token, h] of held) if (now - h.at >= UNDO_TTL_MS) held.delete(token);
  };

  const first = async (filter: Filter, keepRows: boolean) => {
    const g = ++gen;
    for (const h of held.values()) h.removed = null; // a token of another filter or an older page must not put rows back
    update((s) => (keepRows ? { ...s, filter, loading: 'refresh', error: null } : { ...initial(), filter, loading: 'first' }));
    try {
      const f: Feed = await api.feed({ filter });
      if (g !== gen) return;
      baseUnread = f.unread;
      snapMax = f.max;
      lastNow = null; // a count from before this page would be counted against the new baseline
      update((s) => ({ ...s, sections: f.sections, next: f.next, loading: 'idle', fresh: 0, open: s.open, unread: f.unread, categories: f.categories }));
    } catch (e) {
      if (g === gen) update((s) => ({ ...s, loading: 'idle', error: errorOf(e) }));
    }
  };

  /** a selection by filter, bounded to the page's snapshot: entries that arrived since (the pill) are not touched */
  const bounded = (sel: Selection): Selection => (sel.category === undefined || sel.max !== undefined || snapMax <= 0 ? sel : { ...sel, max: snapMax });
  const removeGroups = (sel: Selection): Removed[] => {
    const out: Removed[] = [];
    state.sections.forEach((sec, sectionIndex) => sec.groups.forEach((group, index) => { if (hits(group, sel)) out.push({ group, section: sec.key, index, sectionIndex }); }));
    if (!out.length) return out;
    const gone = new Set(out.map((r) => r.group.id));
    update((s) => ({ ...s, sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.filter((g) => !gone.has(g.id)) })).filter((x) => x.groups.length) }));
    return out;
  };
  const restore = (removed: Removed[]) =>
    update((s) => {
      const sections = copy(s.sections);
      // ascending original positions put each group back at its own index
      for (const r of [...removed].sort((a, b) => a.sectionIndex - b.sectionIndex || a.index - b.index)) {
        let sec = sections.find((x) => x.key === r.section);
        if (!sec) { sec = { key: r.section, groups: [] }; sections.splice(Math.min(r.sectionIndex, sections.length), 0, sec); }
        if (!sec.groups.some((g) => g.id === r.group.id)) sec.groups.splice(Math.min(r.index, sec.groups.length), 0, r.group);
      }
      return { ...s, sections };
    });

  return {
    subscribe,
    load: (filter) => first(filter, false),
    reset() { gen++; epoch++; baseUnread = 0; lastNow = null; snapMax = 0; held.clear(); set(initial()); },
    refresh: () => first(state.filter, true),
    async more() {
      if (!state.next || state.loading !== 'idle') return;
      const g = gen;
      const { filter, next } = state;
      update((s) => ({ ...s, loading: 'more', error: null }));
      try {
        const f = await api.feed({ filter, cursor: next });
        if (g !== gen) return;
        update((s) => {
          const sections = copy(s.sections);
          for (const sec of f.sections) {
            const last = sections[sections.length - 1];
            if (last && last.key === sec.key) last.groups.push(...sec.groups.filter((x) => !last.groups.some((y) => y.id === x.id)));
            else sections.push({ key: sec.key, groups: sec.groups });
          }
          return { ...s, sections, next: f.next, loading: 'idle' };
        });
      } catch (e) {
        if (g === gen) update((s) => ({ ...s, loading: 'idle', error: errorOf(e) }));
      }
    },
    noteFresh: (unreadNow) => { lastNow = unreadNow; update((s) => ({ ...s, fresh: freshOf(baseUnread) })); },
    toggle: (id) => update((s) => { const open = new Set(s.open); if (!open.delete(id)) open.add(id); return { ...s, open }; }),
    async read(sel = {}) {
      const all = everything(sel);
      const sent = bounded(sel);
      /** the groups this call flipped, with their unread entries */
      const flipped = new Map<string, number>();
      let lowered = 0;
      update((s) => ({ ...s, sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.map((g) => {
        if (!g.unread || !(all || hits(g, sel))) return g;
        flipped.set(g.id, g.unreadCount);
        lowered += unreadOf(g);
        return { ...g, unread: false, unreadCount: 0 };
      }) })) }));
      const prior = baseUnread;
      setBase(all ? 0 : Math.max(0, baseUnread - lowered));
      const g0 = gen;
      const e0 = epoch;
      try {
        await api.markRead(all ? undefined : sent);
        return true;
      } catch (e) {
        if (e0 !== epoch) return false; // another person's page now
        if (g0 === gen) setBase(prior); // an obsolete page keeps its own baseline
        // only the groups this call flipped come back unread; a page appended meanwhile stays as it is
        update((s) => ({ ...s, error: errorOf(e), sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.map((g) => (flipped.has(g.id) ? { ...g, unread: true, unreadCount: flipped.get(g.id)! } : g)) })) }));
        return false;
      }
    },
    async hide(sel) {
      prune();
      const g0 = gen;
      const e0 = epoch;
      const sent = bounded(sel);
      const removed = removeGroups(sel);
      const lowered = removed.reduce((n, r) => n + unreadOf(r.group), 0);
      setBase(Math.max(0, baseUnread - lowered));
      try {
        const r = await api.hide(sent);
        // the answer time is no earlier than the server's: a token pruned by it is surely dead there
        if (e0 === epoch) held.set(r.undo, { at: Date.now(), removed: g0 === gen ? removed : null });
        void recount(e0); // on its own: the undo toast does not wait for it (an answer for an earlier person is dropped)
        return { undo: r.undo, n: r.n };
      } catch (e) {
        if (g0 === gen) { setBase(baseUnread + lowered); restore(removed); }
        if (e0 === epoch) update((s) => ({ ...s, error: errorOf(e) }));
        return null;
      }
    },
    undoLeft(token) {
      const h = held.get(token);
      return h ? Math.max(0, UNDO_TTL_MS - UNDO_MARGIN_MS - (Date.now() - h.at)) : 0;
    },
    async undo(token) {
      prune();
      const h = held.get(token);
      if (!h) return false; // not this person's (a reset dropped it) or older than the server keeps it
      const { removed } = h;
      const g0 = gen;
      const e0 = epoch;
      try {
        await api.unhide(token);
      } catch (e) {
        if (e0 !== epoch) return false; // another person's page now
        update((s) => ({ ...s, error: errorOf(e) }));
        if (apiCode(e) === 'undo_expired') held.delete(token); // final: the entries stay cleared; any other failure keeps the token for a retry
        return false;
      }
      if (e0 !== epoch) return false; // another person's page now
      held.delete(token);
      if (removed && g0 === gen) {
        setBase(baseUnread + removed.reduce((n, r) => n + unreadOf(r.group), 0));
        restore(removed);
      } else await first(state.filter, true); // the rows are not on this page any more: show what the server has
      await recount(e0);
      return true;
    },
  };
}

/** The shared instance the sheet and the badge use. */
export const feedStore = createFeed();
/**
 * The counts the layout read last (the 60-s poll and `ff-notes`; null after a sign-out or a profile switch). Every answer is a new
 * object, so an open sheet sees each one and shows the entries that arrived since its first page as its *N neu* pill.
 */
export const latestCounts = writable<Counts | null>(null);
