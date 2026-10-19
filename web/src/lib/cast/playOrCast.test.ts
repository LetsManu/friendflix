// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'svelte/store';

const { session, playOnTv, info, noteInteraction } = vi.hoisted(() => ({ session: { current: null as unknown }, playOnTv: vi.fn(async () => {}), info: vi.fn(), noteInteraction: vi.fn() }));
vi.mock('./engine', async () => {
  const { writable } = await import('svelte/store');
  session.current = writable<{ device: string } | null>(null);
  return { castSession: { subscribe: (session.current as Writable<unknown>).subscribe }, castEngine: { playOnTv } };
});
vi.mock('#lib/ui/toast', () => ({ toast: { info } }));
vi.mock('#lib/stillwatching', () => ({ noteInteraction }));
const nat = vi.hoisted(() => ({ available: false, tryPlay: vi.fn(async (..._a: unknown[]) => true), goto: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock('#lib/native/bridge', () => ({ native: { get available() { return nat.available; } } }));
vi.mock('#lib/native/play', () => ({ tryNativePlay: nat.tryPlay }));
vi.mock('$app/navigation', () => ({ goto: nat.goto }));

import { playOrCast } from './playOrCast';

const ev = (o: Partial<MouseEvent> = {}) => ({ button: 0, defaultPrevented: false, preventDefault: vi.fn(), ...o }) as unknown as MouseEvent;

describe('playOrCast', () => {
  beforeEach(() => { (session.current as Writable<unknown>).set(null); playOnTv.mockClear(); info.mockClear(); noteInteraction.mockClear(); nat.available = false; nat.tryPlay.mockClear(); nat.tryPlay.mockResolvedValue(true); nat.goto.mockClear(); });

  it('does nothing without a session', () => {
    const e = ev();
    expect(playOrCast(e, { id: 'e1' })).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(playOnTv).not.toHaveBeenCalled();
    expect(noteInteraction).not.toHaveBeenCalled();
  });

  it('casts with the resume position and toasts', () => {
    (session.current as Writable<unknown>).set({ device: 'Wohnzimmer-TV' });
    const e = ev();
    expect(playOrCast(e, { id: 'e1', positionTicks: 1_200_000_000 })).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(playOnTv).toHaveBeenCalledWith('e1', 120);
    expect(info).toHaveBeenCalledWith('Läuft auf Wohnzimmer-TV');
    expect(noteInteraction).toHaveBeenCalledTimes(1); // a tap: the viewer is there (still-watching)
  });

  it('no position = server resume', () => {
    (session.current as Writable<unknown>).set({ device: 'TV' });
    playOrCast(ev(), { id: 'e1' });
    expect(playOnTv).toHaveBeenCalledWith('e1', undefined);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])('leaves %o to the browser', (o) => {
    (session.current as Writable<unknown>).set({ device: 'TV' });
    const e = ev(o as Partial<MouseEvent>);
    expect(playOrCast(e, { id: 'e1' })).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(playOnTv).not.toHaveBeenCalled();
  });

  describe('in the app', () => {
    const link = (href: string) => ({ closest: () => ({ getAttribute: () => href }) });
    const tap = (o: Partial<MouseEvent> = {}) => ev({ currentTarget: link('/watch/e1?audio=ger') as unknown as EventTarget, ...o });

    it('hands the title to the native player and stays on the page', async () => {
      nat.available = true;
      const e = tap();
      expect(playOrCast(e, { id: 'e1', positionTicks: 10_000 }, { audio: 'ger' })).toBe(true);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(nat.tryPlay).toHaveBeenCalledWith({ id: 'e1', positionTicks: 10_000 }, { audio: 'ger' });
      await Promise.resolve(); await Promise.resolve();
      expect(nat.goto).not.toHaveBeenCalled();
    });

    it('falls back to the link target (web player) when the app declines', async () => {
      nat.available = true;
      nat.tryPlay.mockResolvedValue(false);
      playOrCast(tap(), { id: 'e1' });
      await vi.waitFor(() => expect(nat.goto).toHaveBeenCalledWith('/watch/e1?audio=ger'));
    });

    it('a cast session wins over the native player', () => {
      nat.available = true;
      (session.current as Writable<unknown>).set({ device: 'TV' });
      playOrCast(tap(), { id: 'e1' });
      expect(playOnTv).toHaveBeenCalled();
      expect(nat.tryPlay).not.toHaveBeenCalled();
    });

    it('modifier clicks stay with the browser', () => {
      nat.available = true;
      const e = tap({ ctrlKey: true });
      expect(playOrCast(e, { id: 'e1' })).toBe(false);
      expect(nat.tryPlay).not.toHaveBeenCalled();
    });
  });
});
