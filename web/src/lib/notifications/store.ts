// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable, type Readable } from 'svelte/store';
import { apiCode } from '#lib/api';
import { defaultApi, type NotesApi } from './api';
import type { Feed, FeedGroup, Filter, Section, Selection } from './types';

export interface FeedState {
  filter: Filter;
  sections: Section[];
  next: string | null;
  loading: 'idle' | 'first' | 'refresh' | 'more';
  error: string | null;
  /** unread entries that arrived since the first page was loaded (shown as a pill; never inserted as rows) */
  fresh: number;
  open: Set<string>;
}

export interface FeedStore extends Readable<FeedState> {
  load(filter: Filter): Promise<void>;
  /** back to the empty state (logout, profile switch): nothing of the previous person stays in memory */
  reset(): void;
  more(): Promise<void>;
  refresh(): Promise<void>;
  noteFresh(unreadNow: number): void;
  toggle(groupId: string): void;
  read(sel?: Selection): Promise<void>;
  hide(sel: Selection): Promise<string | null>;
  undo(token: string): Promise<void>;
}

interface Removed { group: FeedGroup; section: string; index: number; sectionIndex: number }

const errorOf = (e: unknown) => apiCode(e) ?? 'error';
const copy = (s: Section[]): Section[] => s.map((x) => ({ key: x.key, groups: [...x.groups] }));
const hits = (g: FeedGroup, sel: Selection) =>
  !!sel.groups?.includes(g.id) ||
  (sel.category !== undefined && (sel.category === 'all' || (sel.category === 'unread' ? g.unread : g.category === sel.category))) ||
  // only when every row of the group is known (count === items.length); else the next refresh corrects it
  (!!sel.ids?.length && g.count === g.items.length && g.items.length > 0 && g.items.every((i) => sel.ids!.includes(i.id)));
/** unread entries a group stands for (its count while it is unread) */
const unreadOf = (g: FeedGroup) => (g.unread ? g.count : 0);
const everything = (sel: Selection) => !sel.ids?.length && !sel.groups?.length && sel.category === undefined;

export function createFeed(api: NotesApi = defaultApi): FeedStore {
  const initial = (): FeedState => ({ filter: 'all', sections: [], next: null, loading: 'idle', error: null, fresh: 0, open: new Set() });
  const { subscribe, update, set } = writable<FeedState>(initial());
  let state!: FeedState;
  subscribe((s) => (state = s));
  let gen = 0; // a newer load / refresh makes older answers obsolete
  let baseUnread = 0;
  const undoable = new Map<string, Removed[]>();
  /** every undo token handed out since the last reset() (this person), also those whose rows are no longer on this page */
  const issued = new Set<string>();
  let epoch = 0;

  const first = async (filter: Filter, keepRows: boolean) => {
    const g = ++gen;
    undoable.clear(); // a token of another filter or an older page must not put rows back
    update((s) => (keepRows ? { ...s, filter, loading: 'refresh', error: null } : { ...initial(), filter, loading: 'first' }));
    try {
      const f: Feed = await api.feed({ filter });
      if (g !== gen) return;
      baseUnread = f.unread;
      update((s) => ({ ...s, sections: f.sections, next: f.next, loading: 'idle', fresh: 0, open: s.open }));
    } catch (e) {
      if (g === gen) update((s) => ({ ...s, loading: 'idle', error: errorOf(e) }));
    }
  };

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
    reset() { gen++; epoch++; baseUnread = 0; undoable.clear(); issued.clear(); set(initial()); },
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
    noteFresh: (unreadNow) => update((s) => ({ ...s, fresh: Math.max(0, unreadNow - baseUnread) })),
    toggle: (id) => update((s) => { const open = new Set(s.open); if (!open.delete(id)) open.add(id); return { ...s, open }; }),
    async read(sel = {}) {
      const all = everything(sel);
      const flipped = new Set<string>();
      let lowered = 0;
      update((s) => ({ ...s, sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.map((g) => {
        if (!g.unread || !(all || hits(g, sel))) return g;
        flipped.add(g.id);
        lowered += unreadOf(g);
        return { ...g, unread: false };
      }) })) }));
      const prior = baseUnread;
      baseUnread = all ? 0 : Math.max(0, baseUnread - lowered);
      const g0 = gen;
      try {
        await api.markRead(all ? undefined : sel);
      } catch (e) {
        if (g0 === gen) baseUnread = prior; // an obsolete page keeps its own baseline
        // only the groups this call flipped come back unread; a page appended meanwhile stays as it is
        update((s) => ({ ...s, error: errorOf(e), sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.map((g) => (flipped.has(g.id) ? { ...g, unread: true } : g)) })) }));
      }
    },
    async hide(sel) {
      const g0 = gen;
      const e0 = epoch;
      const removed = removeGroups(sel);
      const lowered = removed.reduce((n, r) => n + unreadOf(r.group), 0);
      baseUnread = Math.max(0, baseUnread - lowered);
      try {
        const r = await api.hide(sel);
        if (e0 === epoch) issued.add(r.undo);
        if (g0 === gen) undoable.set(r.undo, removed);
        return r.undo;
      } catch (e) {
        if (g0 === gen) { baseUnread += lowered; restore(removed); }
        update((s) => ({ ...s, error: errorOf(e) }));
        return null;
      }
    },
    async undo(token) {
      const removed = undoable.get(token);
      if (!removed && !issued.has(token)) return; // not this person's (a reset dropped it)
      const g0 = gen;
      const e0 = epoch;
      try {
        await api.unhide(token);
      } catch (e) {
        update((s) => ({ ...s, error: errorOf(e) }));
        if (apiCode(e) === 'undo_expired') { undoable.delete(token); issued.delete(token); } // final: the entries stay cleared; any other failure keeps the token for a retry
        return;
      }
      if (e0 !== epoch) return; // another person's page now
      undoable.delete(token);
      issued.delete(token);
      if (removed && g0 === gen) {
        baseUnread += removed.reduce((n, r) => n + unreadOf(r.group), 0);
        restore(removed);
      } else await first(state.filter, true); // the rows are not on this page any more: show what the server has
    },
  };
}

/** The shared instance the sheet and the badge use. */
export const feedStore = createFeed();
