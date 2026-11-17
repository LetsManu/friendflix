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
  loading: 'idle' | 'first' | 'more';
  error: string | null;
  /** unread entries that arrived since the first page was loaded (shown as a pill; never inserted as rows) */
  fresh: number;
  open: Set<string>;
}

export interface FeedStore extends Readable<FeedState> {
  load(filter: Filter): Promise<void>;
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
  (!!sel.ids?.length && g.items.length > 0 && g.items.every((i) => sel.ids!.includes(i.id)));
const everything = (sel: Selection) => !sel.ids?.length && !sel.groups?.length && sel.category === undefined;

export function createFeed(api: NotesApi = defaultApi): FeedStore {
  const { subscribe, update } = writable<FeedState>({ filter: 'all', sections: [], next: null, loading: 'idle', error: null, fresh: 0, open: new Set() });
  let state!: FeedState;
  subscribe((s) => (state = s));
  let gen = 0; // a newer load / refresh makes older answers obsolete
  let baseUnread = 0;
  const undoable = new Map<string, Removed[]>();

  const first = async (filter: Filter, keepOpen: boolean) => {
    const g = ++gen;
    update((s) => ({ ...s, filter, loading: 'first', error: null }));
    try {
      const f: Feed = await api.feed({ filter });
      if (g !== gen) return;
      baseUnread = f.unread;
      update((s) => ({ ...s, sections: f.sections, next: f.next, loading: 'idle', fresh: 0, open: keepOpen ? s.open : new Set() }));
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
      const before = state.sections;
      update((s) => ({ ...s, sections: s.sections.map((x) => ({ key: x.key, groups: x.groups.map((g) => (g.unread && (everything(sel) || hits(g, sel)) ? { ...g, unread: false } : g)) })) }));
      try {
        await api.markRead(everything(sel) ? undefined : sel);
      } catch (e) {
        update((s) => ({ ...s, sections: before, error: errorOf(e) }));
      }
    },
    async hide(sel) {
      const removed = removeGroups(sel);
      try {
        const r = await api.hide(sel);
        undoable.set(r.undo, removed);
        return r.undo;
      } catch (e) {
        restore(removed);
        update((s) => ({ ...s, error: errorOf(e) }));
        return null;
      }
    },
    async undo(token) {
      const removed = undoable.get(token);
      try {
        await api.unhide(token);
      } catch (e) {
        update((s) => ({ ...s, error: errorOf(e) })); // undo_expired: the entries stay cleared
        undoable.delete(token);
        return;
      }
      undoable.delete(token);
      if (removed) restore(removed);
      else await first(state.filter, true);
    },
  };
}

/** The shared instance the sheet and the badge use. */
export const feedStore = createFeed();
