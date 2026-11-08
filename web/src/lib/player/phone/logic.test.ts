// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PANEL_GAP, PANEL_MAX_W, creditsOn, growOrigin, moreExtras, panelAnchor, panelBox, phoneOrient, phonePlayer, phoneSub, phoneTools } from './logic';

const all = { next: true, episodes: true, tracks: true, speed: true };
const tf = ((k: string, p?: Record<string, unknown>) => `${k}${p ? JSON.stringify(p) : ''}`) as never;

describe('gates', () => {
  it('phone player: coarse pointer, not TV, not kids', () => {
    expect(phonePlayer({ coarse: true, tv: false, kids: false })).toBe(true);
    expect(phonePlayer({ coarse: true, tv: true, kids: false })).toBe(false);
    expect(phonePlayer({ coarse: true, tv: false, kids: true })).toBe(false);
    expect(phonePlayer({ coarse: false, tv: false, kids: false })).toBe(false);
  });
  it('credits sequence on TV, desktop and phones, never for kids', () => {
    expect(creditsOn({ kids: false, tv: false, desk: false, phone: true })).toBe(true);
    expect(creditsOn({ kids: false, tv: true, desk: false, phone: false })).toBe(true);
    expect(creditsOn({ kids: false, tv: false, desk: true, phone: false })).toBe(true);
    expect(creditsOn({ kids: true, tv: false, desk: false, phone: true })).toBe(false);
    expect(creditsOn({ kids: false, tv: false, desk: false, phone: false })).toBe(false);
  });
});
describe('orientation and tools', () => {
  it('portrait only when taller than wide', () => {
    expect(phoneOrient(390, 844)).toBe('portrait');
    expect(phoneOrient(844, 390)).toBe('landscape');
    expect(phoneOrient(500, 500)).toBe('landscape');
  });
  it('landscape: next, episodes, tracks, speed, more; portrait: episodes, tracks, more', () => {
    expect(phoneTools('landscape', all)).toEqual(['next', 'episodes', 'tracks', 'speed', 'more']);
    expect(phoneTools('portrait', all)).toEqual(['episodes', 'tracks', 'more']);
  });
  it('missing features drop their button; more always stays', () => {
    const film = { next: false, episodes: false, tracks: true, speed: true };
    expect(phoneTools('landscape', film)).toEqual(['tracks', 'speed', 'more']);
    expect(phoneTools('portrait', { next: false, episodes: false, tracks: false, speed: false })).toEqual(['more']);
  });
  it('portrait moves speed and next into More', () => {
    expect(moreExtras('portrait', all)).toEqual(['speed', 'next']);
    expect(moreExtras('portrait', { ...all, speed: false, next: false })).toEqual([]);
    expect(moreExtras('landscape', all)).toEqual([]);
  });
});
describe('panels', () => {
  it('anchor: full width in portrait, the pill side in landscape', () => {
    expect(panelAnchor('portrait', 'end')).toBe('full');
    expect(panelAnchor('landscape', 'end')).toBe('end');
    expect(panelAnchor('landscape', 'start')).toBe('start');
  });
  it('bottom edge 8 px above the timeline row, height up to the top bar', () => {
    expect(PANEL_GAP).toBe(8); expect(PANEL_MAX_W).toBe(380);
    expect(panelBox({ stageH: 390, tlTop: 290, topBottom: 60 })).toEqual({ bottom: 108, maxH: 214 });
    expect(panelBox({ stageH: 390, tlTop: 60, topBottom: 60 }).maxH).toBe(0);
  });
  it('grows from the button corner', () => {
    expect(growOrigin({ anchor: 'end', btnX: 0, left: 0, width: 0 })).toBe('bottom right');
    expect(growOrigin({ anchor: 'start', btnX: 0, left: 0, width: 0 })).toBe('bottom left');
    expect(growOrigin({ anchor: 'full', btnX: 300, left: 16, width: 358 })).toBe('79% 100%');
    expect(growOrigin({ anchor: 'full', btnX: 900, left: 16, width: 358 })).toBe('100% 100%');
    expect(growOrigin({ anchor: 'full', btnX: 5, left: 16, width: 0 })).toBe('50% 100%');
  });
  it('clamps below the panel too', () => {
    expect(growOrigin({ anchor: 'full', btnX: 0, left: 16, width: 358 })).toBe('0% 100%');
  });
});
describe('phoneSub', () => {
  it('episode line, with and without a season, without a number', () => {
    const ep = { type: 'Episode', name: 'Der lange Winter', seriesName: 'Nordlicht', parentIndexNumber: 2, indexNumber: 5 };
    expect(phoneSub(ep, tf)).toBe('player.phone.episodeLine{"s":2,"e":5,"name":"Der lange Winter"}');
    expect(phoneSub({ ...ep, parentIndexNumber: null }, tf)).toBe('player.episodeOnly{"e":5} · Der lange Winter');
    expect(phoneSub({ ...ep, indexNumber: null }, tf)).toBe('Der lange Winter');
  });
  it('film: year · length; parts left out when unknown', () => {
    expect(phoneSub({ type: 'Movie', name: 'Inkwell', year: 2021 }, tf)).toBe('2021');
    expect(phoneSub({ type: 'Movie', name: 'Inkwell' }, tf)).toBe('');
    expect(phoneSub({ type: 'Movie', name: 'Inkwell', year: 2021, runtimeTicks: 112 * 600_000_000 })).toMatch(/^2021 · .+/);
    expect(phoneSub(null, tf)).toBe('');
  });
});
