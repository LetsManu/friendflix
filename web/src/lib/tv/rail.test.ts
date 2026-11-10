// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { railKey, type RailInput } from './rail';
import { TV_RAIL } from '../menu';

const base: RailInput = { key: 'left', atLeftEdge: false, inRail: false, onHome: false };
const closed = { open: false }, open = { open: true };

describe('railKey', () => {
  it('Left at the left edge of the content opens the rail', () => {
    expect(railKey(closed, { ...base, key: 'left', atLeftEdge: true })).toEqual({ state: { open: true }, action: 'open' });
  });
  it('Left elsewhere does nothing', () => {
    expect(railKey(closed, { ...base, key: 'left', atLeftEdge: false })).toEqual({ state: { open: false }, action: 'none' });
  });
  it('Back from content opens the closed rail', () => {
    expect(railKey(closed, { ...base, key: 'back' })).toEqual({ state: { open: true }, action: 'open' });
  });
  it('Back in the open rail on home asks to exit', () => {
    expect(railKey(open, { ...base, key: 'back', inRail: true, onHome: true })).toEqual({ state: { open: false }, action: 'exitPrompt' });
  });
  it('Back in the open rail elsewhere closes it', () => {
    expect(railKey(open, { ...base, key: 'back', inRail: true })).toEqual({ state: { open: false }, action: 'close' });
  });
  it('Right and OK in the rail', () => {
    expect(railKey(open, { ...base, key: 'right', inRail: true })).toEqual({ state: { open: false }, action: 'close' });
    expect(railKey(open, { ...base, key: 'ok', inRail: true })).toEqual({ state: { open: false }, action: 'navigate' });
  });
  it('Up and Down stay in the open rail', () => {
    for (const key of ['up', 'down'] as const) expect(railKey(open, { ...base, key, inRail: true })).toEqual({ state: { open: true }, action: 'none' });
  });
  it('the pointer opens and closes the rail', () => {
    expect(railKey(closed, { ...base, key: 'pointerenter' })).toEqual({ state: { open: true }, action: 'open' });
    expect(railKey(open, { ...base, key: 'pointerleave', inRail: true })).toEqual({ state: { open: false }, action: 'close' });
    expect(railKey(closed, { ...base, key: 'pointerleave' })).toEqual({ state: { open: false }, action: 'none' });
  });
});

describe('TV_RAIL', () => {
  it('lists search, home, series, movies, new, my list', () => {
    expect(TV_RAIL.map((r) => r[0])).toEqual(['/search', '/', '/browse/series', '/browse/movies', '/new', '/watchlist']);
  });
  it('the new-titles page is a rail destination, so Back opens the rail there', () => {
    expect(TV_RAIL.find((r) => r[0] === '/new')?.[1]).toBe('shell.nav.new');
  });
});
