// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { LiveChannel } from './api';
import { createSwitcher } from './switcher';

const ch = (id: string, number: number, name: string): LiveChannel => ({ id, number, name, logo: null, groupId: 'g-allg', running: true, epg: 'none', favourite: false });
const ORDER = [ch('ch-nord', 1, 'Nordlicht TV'), ch('ch-hafen', 4, 'Hafenkanal'), ch('ch-berg', 7, 'Bergblick Sport'), ch('ch-kinder', 12, 'Kinderinsel')];

function rig() {
  let now = 0;
  let seq = 0;
  let pending: Array<{ at: number; fn: () => void; h: number }> = [];
  const timers = {
    set: (fn: () => void, ms: number) => { pending.push({ at: now + ms, fn, h: ++seq }); return seq; },
    clear: (h: unknown) => { pending = pending.filter((p) => p.h !== h); },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = pending.filter((p) => p.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      pending = pending.filter((p) => p !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  let current = 'ch-nord';
  const cards: string[] = [];
  const commits: string[] = [];
  const sw = createSwitcher({
    delayMs: 400,
    order: () => ORDER,
    current: () => current,
    onCard: (c) => cards.push(c.name),
    onCommit: (c) => { commits.push(c.id); current = c.id; },
    timers,
  });
  return { sw, cards, commits, advance, pendingCount: () => pending.length };
}

describe('createSwitcher', () => {
  it('three presses within 400 ms → three banners, one commit', () => {
    const { sw, cards, commits, advance } = rig();
    sw.press(1); advance(150);
    sw.press(1); advance(150);
    sw.press(1);
    expect(cards).toEqual(['Hafenkanal', 'Bergblick Sport', 'Kinderinsel']);
    advance(399);
    expect(commits).toEqual([]);
    advance(1);
    expect(commits).toEqual(['ch-kinder']);
    advance(5000);
    expect(commits).toEqual(['ch-kinder']);
  });
  it('each press restarts the 400 ms', () => {
    const { sw, commits, advance } = rig();
    sw.press(1); advance(399);
    sw.press(1); advance(399);
    expect(commits).toEqual([]);
    advance(1);
    expect(commits).toEqual(['ch-berg']);
  });
  it('down wraps around to the end of the order', () => {
    const { sw, cards, commits, advance } = rig();
    sw.press(-1);
    expect(cards).toEqual(['Kinderinsel']);
    advance(400);
    expect(commits).toEqual(['ch-kinder']);
  });
  it('presses that end on the playing channel commit nothing', () => {
    const { sw, cards, commits, advance } = rig();
    sw.press(1); sw.press(-1);
    expect(cards).toEqual(['Hafenkanal', 'Nordlicht TV']);
    advance(1000);
    expect(commits).toEqual([]);
  });
  it('the next press after a commit starts from the committed channel', () => {
    const { sw, commits, advance } = rig();
    sw.press(1); advance(400);
    sw.press(1); advance(400);
    expect(commits).toEqual(['ch-hafen', 'ch-berg']);
  });
  it('jump shows the card and commits at once, dropping a pending press', () => {
    const { sw, cards, commits, advance } = rig();
    sw.press(1);
    sw.jump(ORDER[3]!);
    expect(cards).toEqual(['Hafenkanal', 'Kinderinsel']);
    expect(commits).toEqual(['ch-kinder']);
    advance(1000);
    expect(commits).toEqual(['ch-kinder']);
  });
  it('dispose drops a pending commit and its timer', () => {
    const { sw, commits, advance, pendingCount } = rig();
    sw.press(1);
    sw.dispose();
    expect(pendingCount()).toBe(0);
    advance(1000);
    expect(commits).toEqual([]);
  });
});
