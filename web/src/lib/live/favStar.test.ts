// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { starSync } from './favStar';

/** a server whose answers are held until released, in request order */
function rig(opts: { fail?: (n: number) => boolean } = {}) {
  const sent: boolean[] = [];
  const shown: boolean[] = [];
  const gates: Array<() => void> = [];
  const sync = starSync({
    send: (_id, on) => {
      sent.push(on);
      const n = sent.length;
      return new Promise<boolean>((res) => gates.push(() => res(!opts.fail?.(n))));
    },
    show: (_id, on) => { shown.push(on); },
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const release = async () => { gates.shift()!(); await settle(); };
  return { sync, sent, shown, release, settle };
}

describe('starSync', () => {
  it('two quick toggles during a held first request end in the second state with exactly 2 requests', async () => {
    const r = rig();
    const a = r.sync.toggle('c', false); // on
    await r.settle();
    const b = r.sync.toggle('c', true); // off again, the first save still runs
    expect(r.shown).toEqual([true, false]);
    expect(r.sent).toEqual([true]);
    await r.release();
    expect(r.sent).toEqual([true, false]);
    await r.release();
    await Promise.all([a, b]);
    expect(r.sent).toEqual([true, false]);
    expect(r.shown[r.shown.length - 1]).toBe(false);
  });
  it('three quick toggles end in the final state with at most 2 requests', async () => {
    const r = rig();
    const a = r.sync.toggle('c', false);
    await r.settle();
    await r.sync.toggle('c', true);
    await r.sync.toggle('c', false);
    expect(r.shown).toEqual([true, false, true]);
    await r.release();
    await a;
    expect(r.sent).toEqual([true]); // the final intent equals what the first request stored: nothing more to send
    expect(r.shown[r.shown.length - 1]).toBe(true);
  });
  it('a toggle back to the stored state sends nothing extra', async () => {
    const r = rig();
    const a = r.sync.toggle('c', false);
    await r.settle();
    await r.sync.toggle('c', true);
    await r.sync.toggle('c', false);
    await r.sync.toggle('c', true); // four presses: off wanted, server is about to hold on
    await r.release();
    await r.release();
    await a;
    expect(r.sent).toEqual([true, false]);
    expect(r.shown[r.shown.length - 1]).toBe(false);
  });
  it('a failure rolls back to the server state', async () => {
    const r = rig({ fail: () => true });
    const a = r.sync.toggle('c', false);
    await r.settle();
    await r.release();
    await a;
    expect(r.sent).toEqual([true]);
    expect(r.shown).toEqual([true, false]);
  });
  it('a failed save with a newer press rolls back and does not resend the lost intent', async () => {
    const r = rig({ fail: (n) => n === 1 });
    const a = r.sync.toggle('c', false);
    await r.settle();
    await r.sync.toggle('c', true); // wants off; server still off
    await r.release();
    await a;
    expect(r.sent).toEqual([true]);
    expect(r.shown[r.shown.length - 1]).toBe(false);
  });
  it('channels are independent', async () => {
    const r = rig();
    const a = r.sync.toggle('c', false);
    const b = r.sync.toggle('d', false);
    await r.settle();
    expect(r.sent).toEqual([true, true]);
    await r.release(); await r.release();
    await Promise.all([a, b]);
  });
});
