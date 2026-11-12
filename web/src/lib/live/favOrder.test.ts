// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr, type TKey } from '#lib/i18n';
import { idle, type DragState } from '#lib/ui/dragOrder';
import { orderChanged, tvOrderKey, type TvOrderKey } from './favOrder';

// four favourites: Nordlicht TV, Hafenkanal, Kinderinsel, Bergblick Sport
const NAMES: Record<string, string> = { a: 'Nordlicht TV', b: 'Hafenkanal', c: 'Kinderinsel', d: 'Bergblick Sport' };
const name = (id: string) => NAMES[id] ?? id;
type S = { drag: DragState; focus: number };
const start = (): S => ({ drag: idle(['a', 'b', 'c', 'd']), focus: 0 });
/** the keys one after the other, the state carried on */
function press(s: S, ...keys: TvOrderKey[]) {
  let last = tvOrderKey(s, keys[0]!, name);
  for (const k of keys.slice(1)) last = tvOrderKey(last, k, name);
  return last;
}
const text = (a: { key: TKey; params: Record<string, string | number> } | null) => (a ? tr(a.key, a.params) : null);

describe('tvOrderKey: nothing picked', () => {
  it('▼ and ▲ move the focus, clamped to the list, the order stays', () => {
    const down = tvOrderKey(start(), 'down', name);
    expect(down.focus).toBe(1);
    expect(down.drag.ids).toEqual(['a', 'b', 'c', 'd']);
    expect(down.close).toBe(false);
    expect(down.announce).toBeNull();
    expect(tvOrderKey(start(), 'up', name).focus).toBe(0);
    expect(press(start(), 'down', 'down', 'down', 'down', 'down').focus).toBe(3);
  });
  it('OK picks the focused row up and announces it', () => {
    const r = press(start(), 'down', 'ok');
    expect(r.drag.picked).toBe('b');
    expect(r.drag.origin).toBe(1);
    expect(r.focus).toBe(1);
    expect(r.close).toBe(false);
    expect(r.announce).toEqual({ key: 'live.fav.orderPicked', params: { name: 'Hafenkanal', n: 2, m: 4 } });
    expect(text(r.announce)).toBe('Hafenkanal aufgenommen, Position 2 von 4');
  });
  it('Back closes the sheet', () => {
    const r = tvOrderKey(start(), 'back', name);
    expect(r.close).toBe(true);
    expect(r.announce).toBeNull();
    expect(r.drag.ids).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('tvOrderKey: a row picked', () => {
  it('▲ moves it up and the focus goes with it; "Position 1 von 4"', () => {
    const r = press(start(), 'down', 'ok', 'up');
    expect(r.drag.ids).toEqual(['b', 'a', 'c', 'd']);
    expect(r.drag.picked).toBe('b');
    expect(r.focus).toBe(0);
    expect(r.announce).toEqual({ key: 'live.fav.orderMoved', params: { n: 1, m: 4 } });
    expect(text(r.announce)).toBe('Position 1 von 4');
  });
  it('▼ moves it down', () => {
    const r = press(start(), 'ok', 'down', 'down');
    expect(r.drag.ids).toEqual(['b', 'c', 'a', 'd']);
    expect(r.focus).toBe(2);
    expect(text(r.announce)).toBe('Position 3 von 4');
  });
  it('at an end nothing moves and nothing is announced', () => {
    const r = press(start(), 'ok', 'up');
    expect(r.drag.ids).toEqual(['a', 'b', 'c', 'd']);
    expect(r.drag.picked).toBe('a');
    expect(r.focus).toBe(0);
    expect(r.announce).toBeNull();
  });
  it('OK drops it where it is: "abgelegt auf Position 2"', () => {
    const r = press(start(), 'ok', 'down', 'ok');
    expect(r.drag.ids).toEqual(['b', 'a', 'c', 'd']);
    expect(r.drag.picked).toBeNull();
    expect(r.focus).toBe(1);
    expect(r.close).toBe(false);
    expect(r.announce).toEqual({ key: 'live.fav.orderDropped', params: { name: 'Nordlicht TV', n: 2 } });
    expect(text(r.announce)).toBe('Nordlicht TV abgelegt auf Position 2');
  });
  it('Back cancels the move with one press: the original order, the sheet stays open', () => {
    const r = press(start(), 'down', 'ok', 'down', 'down', 'back');
    expect(r.drag.ids).toEqual(['a', 'b', 'c', 'd']);
    expect(r.drag.picked).toBeNull();
    expect(r.focus).toBe(1);
    expect(r.close).toBe(false);
    expect(r.announce).toEqual({ key: 'live.fav.orderCancelled', params: {} });
    expect(text(r.announce)).toBe('Verschieben abgebrochen');
  });
  it('a Back after that has nothing picked, so it closes', () => {
    const r = press(start(), 'down', 'ok', 'down', 'back', 'back');
    expect(r.close).toBe(true);
    expect(r.drag.ids).toEqual(['a', 'b', 'c', 'd']);
  });
  it('an earlier drop stays when a later move is cancelled', () => {
    // a dropped at place 2 (b a c d); then c is picked, moved up, and the move cancelled: c goes back, a stays
    const r = press(start(), 'ok', 'down', 'ok', 'down', 'ok', 'up', 'back');
    expect(r.close).toBe(false);
    expect(r.drag.picked).toBeNull();
    expect(r.drag.ids).toEqual(['b', 'a', 'c', 'd']);
    expect(r.focus).toBe(2);
  });
  it('never changes the state it is given', () => {
    const s = start();
    const frozen = JSON.stringify(s);
    tvOrderKey(s, 'down', name); tvOrderKey(s, 'ok', name); tvOrderKey(s, 'back', name);
    expect(JSON.stringify(s)).toBe(frozen);
  });
  it('an empty list: every key is harmless, Back closes', () => {
    const e: S = { drag: idle([]), focus: 0 };
    for (const k of ['up', 'down', 'ok'] as const) { const r = tvOrderKey(e, k, name); expect(r.focus).toBe(0); expect(r.drag.picked).toBeNull(); expect(r.announce).toBeNull(); }
    expect(tvOrderKey(e, 'back', name).close).toBe(true);
  });
});

describe('orderChanged', () => {
  it('compares the order, not the lifted state', () => {
    expect(orderChanged(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(orderChanged(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(orderChanged(['a'], ['a', 'b'])).toBe(true);
  });
});
