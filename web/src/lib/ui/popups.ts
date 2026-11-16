// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** One pop-up at a time: opening a pop-up closes the others, except its own ancestors. */
export interface PopupHandle { readonly id: number; release(): void }

/** Svelte context key; the value is `() => PopupHandle | null`, so nested pop-ups find their parent. */
export const POPUP_CTX = Symbol('popup');

interface Entry { id: number; close: () => void; parent: Entry | null; handle: PopupHandle }

let seq = 0;
let entries: Entry[] = [];

const ancestors = (e: Entry | null): Set<Entry> => {
  const s = new Set<Entry>();
  for (let x = e; x; x = x.parent) s.add(x);
  return s;
};
const depth = (e: Entry): number => ancestors(e).size;
const descendants = (e: Entry): Entry[] => entries.filter((x) => x !== e && ancestors(x).has(e));

function closeEntries(list: Entry[]): void {
  const ordered = [...list].sort((a, b) => depth(b) - depth(a));
  entries = entries.filter((e) => !ordered.includes(e));
  for (const e of ordered) e.close();
}

export function openPopup(close: () => void, parent: PopupHandle | null = null): PopupHandle {
  const p = parent ? entries.find((e) => e.id === parent.id) ?? null : null;
  const keep = ancestors(p);
  closeEntries(entries.filter((e) => !keep.has(e)));
  const id = ++seq;
  const entry: Entry = {
    id,
    close,
    parent: p,
    handle: {
      id,
      release() {
        if (!entries.includes(entry)) return;
        const kids = descendants(entry);
        entries = entries.filter((e) => e !== entry);
        closeEntries(kids);
      },
    },
  };
  entries.push(entry);
  return entry.handle;
}

export function closeAllPopups(): void { closeEntries(entries); }
export function openPopups(): number { return entries.length; }
