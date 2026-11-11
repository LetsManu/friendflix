// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ hangCaps: false, available: true, api: 2, sent: [] as Array<string | null>, release: null as null | (() => void), caps: vi.fn() }));
vi.mock('./bridge', () => ({
  native: {
    get available() { return h.available; },
    sessionChanged: (id: string | null) => { h.sent.push(id); return new Promise<boolean>((r) => { h.release = () => r(true); }); },
  },
}));
vi.mock('./play', () => ({ nativeCaps: async () => { h.caps(); if (h.hangCaps) await new Promise(() => undefined); return { api: h.api, play: true, download: true, cast: true, castBar: true }; } }));

import { tellAppSession } from './sessionSync';

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => { h.hangCaps = false; h.available = true; h.api = 2; h.sent = []; h.release = null; h.caps.mockClear(); });

describe('tellAppSession', () => {
  it('sends the profile id inside the app with API 2', async () => {
    const p = tellAppSession('p2');
    await vi.waitFor(() => expect(h.sent).toEqual(['p2']));
    h.release!();
    await p;
  });
  it('waits for the app answer (logout awaits it)', async () => {
    let done = false;
    const p = tellAppSession(null).then(() => { done = true; });
    await vi.waitFor(() => expect(h.sent).toEqual([null]));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    h.release!();
    await p;
    expect(done).toBe(true);
  });
  it('sends nothing outside the app', async () => {
    h.available = false;
    await tellAppSession('p2');
    expect(h.sent).toEqual([]);
    expect(h.caps).not.toHaveBeenCalled();
  });
  it('sends nothing to an API 1 app (it does not know the method)', async () => {
    h.api = 1;
    await tellAppSession('p2');
    await tellAppSession(null);
    expect(h.sent).toEqual([]);
  });
  it('sends nothing when the app did not answer capabilities (api 0)', async () => {
    h.api = 0;
    await tellAppSession(null);
    expect(h.sent).toEqual([]);
  });
  it('gives up on a hung app after 4 s (the sign-out must not wait longer)', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = tellAppSession(null).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
  });
  it('the 4 s cap covers the capabilities question too', async () => {
    vi.useFakeTimers();
    h.hangCaps = true;
    let done = false;
    const p = tellAppSession('p2').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4100);
    await p;
    expect(done).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
