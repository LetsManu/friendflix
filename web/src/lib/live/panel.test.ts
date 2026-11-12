// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { LiveChannel } from './api';
import { backStep, openPanel, panelFilters, panelKey, type PanelState } from './panel';

const ch = (id: string, number: number, groupId: string | null = 'g1'): LiveChannel =>
  ({ id, number, name: id, logo: null, groupId, running: false, epg: 'none', favourite: false });
const list = [ch('nordlicht', 1), ch('hafen', 4), ch('berg', 7, 'g2'), ch('kinder', 12, 'g2'), ch('stern', 21)];
const filters = ['all', 'fav', 'recent', 'g1', 'g2'];
const favourites = ['kinder', 'nordlicht', 'hafen'];
const recentSnapshot = ['hafen', 'kinder'];
const ids = (s: PanelState) => s.rows.map((c) => c.id);
const ctx = (playingId: string) => ({ list, favourites, recentSnapshot, playingId });

describe('openPanel', () => {
  it('opens on the current filter in Favoriten order with the focus on the playing channel', () => {
    const s = openPanel({ list, filter: 'fav', filters, favourites, recentSnapshot, playingId: 'hafen' });
    expect(s.filter).toBe('fav');
    expect(s.filters).toEqual(filters);
    expect(ids(s)).toEqual(['kinder', 'nordlicht', 'hafen']);
    expect(s.focus).toBe(2);
  });
  it('all is by number; a playing channel that is not in the rows focuses row 0', () => {
    expect(ids(openPanel({ list, filter: 'all', filters, favourites, recentSnapshot, playingId: 'berg' }))).toEqual(['nordlicht', 'hafen', 'berg', 'kinder', 'stern']);
    expect(openPanel({ list, filter: 'g1', filters, favourites, recentSnapshot, playingId: 'berg' }).focus).toBe(0);
  });
  it('Zuletzt gesehen walks the snapshot, not the list', () => {
    expect(ids(openPanel({ list, filter: 'recent', filters, favourites, recentSnapshot, playingId: 'kinder' }))).toEqual(['hafen', 'kinder']);
  });
});

describe('panelKey', () => {
  const at = (filter: string, playingId: string) => openPanel({ list, filter, filters, favourites, recentSnapshot, playingId });
  it('▼ moves, ▼ at the end stays; ▲ at the top stays', () => {
    let s = at('all', 'kinder');
    expect(s.focus).toBe(3);
    s = panelKey(s, 'down', ctx('kinder')).state;
    expect(s.focus).toBe(4);
    const end = panelKey(s, 'down', ctx('kinder'));
    expect(end.state.focus).toBe(4);
    expect(end.act).toBeNull();
    let top = at('all', 'nordlicht');
    top = panelKey(top, 'up', ctx('nordlicht')).state;
    expect(top.focus).toBe(0);
  });
  it('▶ from Alle to Favoriten refocuses the playing channel when it is a favourite', () => {
    const r = panelKey(at('all', 'hafen'), 'right', ctx('hafen'));
    expect(r.state.filter).toBe('fav');
    expect(ids(r.state)).toEqual(['kinder', 'nordlicht', 'hafen']);
    expect(r.state.focus).toBe(2);
    expect(r.act).toBeNull();
  });
  it('▶ from Alle to Favoriten focuses row 0 when the playing channel is not a favourite', () => {
    const s = panelKey(at('all', 'berg'), 'down', ctx('berg')).state; // the focus moved away first
    const r = panelKey(s, 'right', ctx('berg'));
    expect(r.state.filter).toBe('fav');
    expect(r.state.focus).toBe(0);
  });
  it('◀ / ▶ stop at the first and the last chip', () => {
    expect(panelKey(at('all', 'hafen'), 'left', ctx('hafen')).state.filter).toBe('all');
    expect(panelKey(at('g2', 'berg'), 'right', ctx('berg')).state.filter).toBe('g2');
    expect(panelKey(at('g2', 'berg'), 'left', ctx('berg')).state.filter).toBe('g1');
  });
  it('a filter with no rows keeps focus 0 and OK there does nothing', () => {
    const empty = openPanel({ list, filter: 'recent', filters, favourites, recentSnapshot: [], playingId: 'hafen' });
    expect(empty.rows).toEqual([]);
    expect(empty.focus).toBe(0);
    expect(panelKey(empty, 'down', ctx('hafen')).state.focus).toBe(0);
    expect(panelKey(empty, 'ok', ctx('hafen')).act).toBeNull();
  });
  it('OK asks to switch to the focused channel', () => {
    const s = panelKey(at('all', 'nordlicht'), 'down', ctx('nordlicht')).state;
    expect(panelKey(s, 'ok', ctx('nordlicht')).act).toEqual({ switchTo: 'hafen' });
  });
  it('Back closes', () => {
    const s = at('all', 'nordlicht');
    const r = panelKey(s, 'back', ctx('nordlicht'));
    expect(r.act).toEqual({ close: true });
    expect(r.state).toBe(s);
  });
  it('does not change the state it is given', () => {
    const s = at('all', 'nordlicht');
    const copy = { ...s, rows: [...s.rows] };
    panelKey(s, 'down', ctx('nordlicht'));
    panelKey(s, 'right', ctx('nordlicht'));
    expect(s).toEqual(copy);
  });
});

describe('panelFilters', () => {
  it('Alle, Favoriten, Zuletzt gesehen (only with a recent channel), then the groups: the chips of the list', () => {
    expect(panelFilters([{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }], true)).toEqual(['all', 'fav', 'recent', 'g1', 'g2']);
    expect(panelFilters([{ id: 'g1', name: 'A' }], false)).toEqual(['all', 'fav', 'g1']);
  });
});

describe('backStep', () => {
  const none = { panel: false, sheet: false, numberOpen: false, controls: false };
  it('panel → sheet → number card → controls → exit', () => {
    expect(backStep({ panel: true, sheet: true, numberOpen: true, controls: true })).toBe('closePanel');
    expect(backStep({ ...none, sheet: true, numberOpen: true, controls: true })).toBe('closeSheet');
    expect(backStep({ ...none, numberOpen: true, controls: true })).toBe('closeNumber');
    expect(backStep({ ...none, controls: true })).toBe('hideControls');
    expect(backStep(none)).toBe('exit');
  });
});
