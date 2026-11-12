// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { classify, hintKeys, noteKey, seenKeys, type SeenKey } from './keyhints';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const boom = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: (): void => { throw new Error('blocked'); } };

describe('classify', () => {
  it('sorts keys into the four classes', () => {
    for (const k of ['ChannelUp', 'ChannelDown', 'PageUp', 'PageDown']) expect(classify(k)).toBe('channel');
    for (const k of ['0', '5', '9']) expect(classify(k)).toBe('digit');
    for (const k of ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']) expect(classify(k)).toBe('colour');
    expect(classify('Info')).toBe('info');
  });
  it('ignores everything else', () => { for (const k of ['Enter', 'ArrowUp', 'a', '10', '']) expect(classify(k)).toBeNull(); });
});

describe('keyhints', () => {
  it('fresh storage: the list shows OK and long OK only', () => {
    expect(hintKeys('list', seenKeys(mem()))).toEqual(['live.tvHint.ok', 'live.tvHintFav']);
  });
  it('after a ChannelDown the channel jump shows, also for a new read of the same storage', () => {
    const s = mem();
    expect(hintKeys('list', noteKey('ChannelDown', s))).toEqual(['live.tvHint.ok', 'live.tvHintFav', 'live.tvHint.chJump']);
    expect(hintKeys('list', seenKeys(s))).toEqual(['live.tvHint.ok', 'live.tvHintFav', 'live.tvHint.chJump']);
    expect(JSON.parse(s.m.get('ff-live-keys-seen')!)).toEqual(['channel']);
  });
  it('a digit adds the last-channel hint after the jump hint', () => {
    const s = mem();
    noteKey('3', s); noteKey('PageUp', s);
    expect(hintKeys('list', seenKeys(s))).toEqual(['live.tvHint.ok', 'live.tvHintFav', 'live.tvHint.chJump', 'live.tvHint.zeroLast']);
  });
  it('colour and info keys are remembered but add no list hint; keys that classify to nothing are not stored', () => {
    const s = mem();
    noteKey('Info', s); noteKey('ColorF0Red', s); noteKey('Enter', s);
    expect([...seenKeys(s)].sort()).toEqual(['colour', 'info']);
    expect(hintKeys('list', seenKeys(s))).toEqual(['live.tvHint.ok', 'live.tvHintFav']);
  });
  it('the player shows the long OK hint always', () => {
    expect(hintKeys('player', new Set<SeenKey>())).toEqual(['live.tvHint.longOkList']);
    expect(hintKeys('player', new Set<SeenKey>(['channel', 'digit']))).toEqual(['live.tvHint.longOkList']);
  });
  it('a throwing storage gives D-pad hints and never throws', () => {
    expect(() => noteKey('ChannelUp', boom)).not.toThrow();
    expect(hintKeys('list', seenKeys(boom))).toEqual(['live.tvHint.ok', 'live.tvHintFav']);
  });
  it('garbage in storage is ignored', () => {
    const s = mem();
    s.setItem('ff-live-keys-seen', '{"x":1}'); expect(seenKeys(s).size).toBe(0);
    s.setItem('ff-live-keys-seen', '["channel","bogus",3]'); expect([...seenKeys(s)]).toEqual(['channel']);
    s.setItem('ff-live-keys-seen', 'not json'); expect(seenKeys(s).size).toBe(0);
  });
  it('without any storage (Node) it works in memory only', () => {
    expect(seenKeys().size).toBe(0);
    expect(() => noteKey('0')).not.toThrow();
  });
});
