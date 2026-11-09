// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { dropLayers, registerLayer } from './backlayer';

describe('back layers', () => {
  it('nothing registered: resolves at once', async () => {
    await expect(dropLayers()).resolves.toBeUndefined();
  });

  it('drops every registered layer and waits for each pop', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((r) => { release = () => { order.push('slow'); r(); }; }));
    const fast = vi.fn(async () => { order.push('fast'); });
    const offSlow = registerLayer(slow), offFast = registerLayer(fast);
    let done = false;
    const p = dropLayers().then(() => { done = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(done).toBe(false); // the slow layer's back is still on its way
    release();
    await p;
    expect(done).toBe(true);
    expect(order).toEqual(['fast', 'slow']);
    offSlow(); offFast();
  });

  it('an unregistered layer is no longer dropped', async () => {
    const drop = vi.fn(async () => {});
    const off = registerLayer(drop);
    off();
    off(); // twice is harmless
    await dropLayers();
    expect(drop).not.toHaveBeenCalled();
  });

  it('the same drop registered twice counts once', async () => {
    const drop = vi.fn(async () => {});
    const off1 = registerLayer(drop), off2 = registerLayer(drop);
    await dropLayers();
    expect(drop).toHaveBeenCalledTimes(1);
    off1(); off2();
  });

  it('a failing drop rejects', async () => {
    const off = registerLayer(() => Promise.reject(new Error('gone')));
    await expect(dropLayers()).rejects.toThrow('gone');
    off();
  });
});
