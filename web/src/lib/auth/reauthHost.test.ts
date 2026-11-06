// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// ReauthHost's logic: the dialog chunk loads on first use (once), a failed load answers the request with false, navigation gives it up.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('#lib/auth/flow', () => ({ flowConfig: async () => ({ mode: 'app', recovery: false, enroll: false }) }));

import { reauthenticate, reauthRequest, registerReauthHost } from '#lib/account/reauth';
import { dialogLoader, navigatedAway } from './reauthHost';

let off: (() => void) | undefined;
afterEach(() => { off?.(); off = undefined; vi.unstubAllGlobals(); });

async function open(next = '/admin/settings') {
  vi.stubGlobal('location', { pathname: next, href: '' });
  off ??= registerReauthHost();
  const p = reauthenticate(next);
  await vi.waitFor(() => expect(get(reauthRequest)).not.toBeNull());
  return { p }; // wrapped: an async function would wait for it
}

describe('dialogLoader', () => {
  it('loads on first use only, then keeps the module', async () => {
    const load = vi.fn(async () => ({ default: 'Dialog' }));
    const get1 = dialogLoader(load);
    expect(load).not.toHaveBeenCalled();
    expect(await get1()).toEqual({ default: 'Dialog' });
    expect(await get1()).toEqual({ default: 'Dialog' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a chunk that cannot load answers the open request with false; the next request tries again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('chunk')).mockResolvedValueOnce({ default: 'Dialog' });
    const getDialog = dialogLoader(load);
    const { p } = await open();
    expect(await getDialog()).toBeNull();
    expect(await p).toBe(false);
    expect(get(reauthRequest)).toBeNull();
    void open();
    expect(await getDialog()).toEqual({ default: 'Dialog' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('navigatedAway', () => {
  it('an in-app navigation gives the open request up (false): the page is gone', async () => {
    const { p } = await open();
    navigatedAway({ willUnload: false });
    expect(await p).toBe(false);
  });

  it('a navigation that unloads the page (the classic redirect) leaves the request alone', async () => {
    const { p } = await open();
    navigatedAway({ willUnload: true });
    expect(get(reauthRequest)).not.toBeNull();
    const settled = await Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    navigatedAway({ willUnload: false });
    expect(await p).toBe(false);
  });

  it('nothing open: nothing happens', () => {
    expect(() => navigatedAway({ willUnload: false })).not.toThrow();
  });
});
