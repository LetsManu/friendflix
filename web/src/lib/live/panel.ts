// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LiveChannel, LiveGroup } from './api';
import { channelOrder, type LiveFilter } from './order';

/**
 * The *Senderliste* panel of the live player (spec §12.2, ruling 51 and 59), pure like `livekeys.ts`: which rows it shows, which one
 * has the focus and what a remote key does in it. The panel component draws the state; the player owns the keys and acts on `act`.
 * Phase 2's mini-guide reuses it unchanged.
 */
export interface PanelState { filter: LiveFilter; filters: LiveFilter[]; rows: LiveChannel[]; focus: number }

export interface PanelCtx { list: LiveChannel[]; favourites: string[]; recentSnapshot: string[]; playingId: string }

export type PanelKey = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';
export type PanelAct = null | { switchTo: string } | { close: true };

/** the filter chips of the list (GroupChips): Alle, Favoriten, Zuletzt gesehen (only with a watched channel), then the groups */
export function panelFilters(groups: LiveGroup[], recent: boolean): LiveFilter[] {
  return ['all', 'fav', ...(recent ? ['recent'] : []), ...groups.map((g) => g.id)];
}

/** the rows of a filter, focused on the playing channel (row 0 when it is not among them) */
function rowsOf(filter: LiveFilter, filters: LiveFilter[], c: PanelCtx): PanelState {
  const rows = channelOrder(c.list, filter, c.favourites, c.recentSnapshot);
  const i = rows.findIndex((x) => x.id === c.playingId);
  return { filter, filters, rows, focus: i < 0 ? 0 : i };
}

/** The panel as it opens: the player's current filter, its zapping order, the focus on the playing channel. */
export function openPanel(o: { list: LiveChannel[]; filter: LiveFilter; filters: LiveFilter[]; favourites: string[]; recentSnapshot: string[]; playingId: string }): PanelState {
  return rowsOf(o.filter, o.filters, o);
}

/**
 * One remote key in the panel. ▲/▼ move the focus and stop at the ends; ◀/▶ change the filter chip (stopping at the first and the
 * last) and refocus: the playing channel when the new rows hold it, else the first row; OK asks the caller to switch to the focused
 * channel (the caller switches, closes the panel and shows the banner); Back asks it to close. The given state is never changed.
 */
export function panelKey(s: PanelState, key: PanelKey, ctx: PanelCtx): { state: PanelState; act: PanelAct } {
  const last = Math.max(0, s.rows.length - 1);
  switch (key) {
    case 'up': return { state: { ...s, focus: Math.max(0, Math.min(last, s.focus - 1)) }, act: null };
    case 'down': return { state: { ...s, focus: Math.min(last, s.focus + 1) }, act: null };
    case 'left':
    case 'right': {
      const i = s.filters.indexOf(s.filter);
      const j = i < 0 ? 0 : Math.max(0, Math.min(s.filters.length - 1, i + (key === 'right' ? 1 : -1)));
      const f = s.filters[j];
      if (f === undefined || f === s.filter) return { state: s, act: null };
      return { state: rowsOf(f, s.filters, ctx), act: null };
    }
    case 'ok': {
      const c = s.rows[s.focus];
      return { state: s, act: c ? { switchTo: c.id } : null };
    }
    case 'back': return { state: s, act: { close: true } };
    default: return { state: s, act: null };
  }
}

/**
 * What Back does in the player (spec §12.3 Close row): the Senderliste panel first, then an open sheet (info panel, a refusal),
 * then the number card, then the controls (TV), then the player closes.
 */
export function backStep(s: { panel: boolean; sheet: boolean; numberOpen: boolean; controls: boolean }): 'closePanel' | 'closeSheet' | 'closeNumber' | 'hideControls' | 'exit' {
  if (s.panel) return 'closePanel';
  if (s.sheet) return 'closeSheet';
  if (s.numberOpen) return 'closeNumber';
  if (s.controls) return 'hideControls';
  return 'exit';
}
