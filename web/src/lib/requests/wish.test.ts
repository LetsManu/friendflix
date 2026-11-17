// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { status?: number; json?: unknown };
let routes: Record<string, Reply>;
let calls: Array<{ call: string; body?: unknown }>;
type Mod = typeof import('./wish');
let W: Mod;

beforeEach(async () => {
  routes = {};
  calls = [];
  vi.stubGlobal('location', { pathname: '/', href: '/' });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const call = `${init.method ?? 'GET'} ${path}`;
    calls.push({ call, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[call] ?? { status: 404, json: { error: 'not_found' } };
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
  }));
  vi.resetModules();
  W = await import('./wish');
});
afterEach(() => vi.unstubAllGlobals());

describe('wishView', () => {
  const base = { server: 'none', local: 'idle', wished: false, exhausted: false } as const;
  it('a free title can be wished', () => expect(W.wishView(base)).toBe('none'));
  it('in flight: pending, whatever else is true', () => {
    expect(W.wishView({ ...base, local: 'pending' })).toBe('pending');
    expect(W.wishView({ ...base, local: 'pending', exhausted: true, wished: true })).toBe('pending');
  });
  it('wished in this visit, or already asked on the server: requested / in progress / available', () => {
    expect(W.wishView({ ...base, wished: true })).toBe('requested');
    expect(W.wishView({ ...base, server: 'requested' })).toBe('requested');
    expect(W.wishView({ ...base, server: 'processing' })).toBe('processing');
    expect(W.wishView({ ...base, server: 'available' })).toBe('available');
    expect(W.wishView({ ...base, server: 'requested', exhausted: true })).toBe('requested'); // asked already: the quota is no reason to hide it
  });
  it('a used-up quota blocks only titles that could still be wished', () => {
    expect(W.wishView({ ...base, exhausted: true })).toBe('exhausted');
    expect(W.wishView({ ...base, exhausted: true, local: 'error' })).toBe('exhausted');
  });
  it('a failure shows the error state, a retry (back to idle) leaves it', () => {
    expect(W.wishView({ ...base, local: 'error' })).toBe('error');
    expect(W.wishView(base)).toBe('none');
  });
});

describe('submitWish', () => {
  it('success: requested, the title and the quota follow only after the server said yes', async () => {
    routes['POST /api/requests'] = { json: { ok: true } };
    routes['GET /api/requests/mine'] = { json: { requests: [{ title: 'Lantern Row', mediaType: 'tv', status: 'angefragt', createdAt: '2026-11-10T10:00:00Z' }] } };
    W.quota.set({ limit: 5, used: 1, resetsAt: '2026-12-01T00:00:00Z' });
    expect(get(W.wished).size).toBe(0);
    expect(await W.submitWish('tv', 7)).toEqual({ kind: 'requested' });
    expect(calls[0]).toEqual({ call: 'POST /api/requests', body: { mediaType: 'tv', tmdbId: 7 } });
    expect(get(W.wished).has('tv:7')).toBe(true);
    expect(get(W.quota)?.used).toBe(2);
    await vi.waitFor(() => expect(get(W.mine)).toHaveLength(1));
  });
  it('failure: nothing changes (no optimistic state), the caller gets "failed"', async () => {
    routes['POST /api/requests'] = { status: 500, json: { error: 'boom' } };
    W.quota.set({ limit: 5, used: 1, resetsAt: 'r' });
    expect(await W.submitWish('movie', 3)).toEqual({ kind: 'failed', disabled: false });
    expect(get(W.wished).size).toBe(0);
    expect(get(W.quota)?.used).toBe(1);
  });
  it('a vanished request service is reported as disabled', async () => {
    routes['POST /api/requests'] = { status: 404, json: { error: 'requests_disabled' } };
    expect(await W.submitWish('movie', 3)).toEqual({ kind: 'failed', disabled: true });
  });
  it('409: somebody asked already, that counts as requested and leaves the quota alone', async () => {
    routes['POST /api/requests'] = { status: 409, json: { error: 'already_requested', status: 'angefragt' } };
    W.quota.set({ limit: 5, used: 1, resetsAt: 'r' });
    expect(await W.submitWish('movie', 3)).toEqual({ kind: 'exists' });
    expect(get(W.wished).has('movie:3')).toBe(true);
    expect(get(W.quota)?.used).toBe(1);
  });
  it('429: the quota is used up for every button, with the reset date', async () => {
    routes['POST /api/requests'] = { status: 429, json: { error: 'request_limit', limit: 5, used: 5, resetsAt: '2026-12-01T00:00:00Z' } };
    W.quota.set({ limit: 5, used: 4, resetsAt: '2026-12-01T00:00:00Z' });
    expect(await W.submitWish('movie', 3)).toEqual({ kind: 'limit', resetsAt: '2026-12-01T00:00:00Z' });
    expect(get(W.quota)).toEqual({ limit: 5, used: 5, resetsAt: '2026-12-01T00:00:00Z' });
    expect(get(W.wished).size).toBe(0);
  });
  it('unlimited quota stays unlimited after a wish', async () => {
    routes['POST /api/requests'] = { json: { ok: true } };
    W.quota.set({ limit: null, used: 3, resetsAt: 'r' });
    await W.submitWish('movie', 3);
    expect(get(W.quota)).toMatchObject({ limit: null });
  });
});

describe('chosen seasons and collections', () => {
  it('a season wish sends the seasons and reports which went out; the collection of a movie wish comes back', async () => {
    routes['POST /api/requests'] = { json: { id: 9, status: 'angefragt', seasons: [2, 3] } };
    expect(await W.submitWish('tv', 7001, [3, 2])).toEqual({ kind: 'requested', seasons: [2, 3] });
    expect(calls[0]).toEqual({ call: 'POST /api/requests', body: { mediaType: 'tv', tmdbId: 7001, seasons: [3, 2] } });
    routes['POST /api/requests'] = { json: { id: 10, status: 'angefragt', collection: { id: 900, name: 'Sternwarte 24' } } };
    expect(await W.submitWish('movie', 8002)).toEqual({ kind: 'requested', collection: { id: 900, name: 'Sternwarte 24' } });
  });
  it('400 bad_seasons is a failure, not "requested"', async () => {
    routes['POST /api/requests'] = { status: 400, json: { error: 'bad_seasons' } };
    expect(await W.submitWish('tv', 7001, [9])).toEqual({ kind: 'failed', disabled: false });
    expect(get(W.wished).size).toBe(0);
  });
  it('batch: per-movie results; requested and existing parts count as wished; the quota comes from the answer', async () => {
    routes['POST /api/requests/batch'] = { json: { results: [{ tmdbId: 8002, result: 'requested' }, { tmdbId: 8003, result: 'exists' }, { tmdbId: 8004, result: 'limit' }, { tmdbId: 8006, result: 'failed' }], quota: { limit: 2, used: 2, remaining: 0, resetsAt: 'r' } } };
    const r = await W.submitBatch([8002, 8003, 8004, 8006], 900);
    expect(calls[0]).toEqual({ call: 'POST /api/requests/batch', body: { items: [8002, 8003, 8004, 8006].map((tmdbId) => ({ mediaType: 'movie', tmdbId })), collectionId: 900 } });
    expect(r).toEqual({ kind: 'done', results: [{ tmdbId: 8002, result: 'requested' }, { tmdbId: 8003, result: 'exists' }, { tmdbId: 8004, result: 'limit' }, { tmdbId: 8006, result: 'failed' }], resetsAt: 'r' });
    expect([...get(W.wished)].sort()).toEqual(['movie:8002', 'movie:8003']);
    expect(get(W.quota)).toEqual({ limit: 2, used: 2, resetsAt: 'r' });
  });
  it('batch without a collection id; the whole call failing: failed (disabled when the service is gone), nothing marked', async () => {
    routes['POST /api/requests/batch'] = { status: 502, json: { error: 'seerr' } };
    expect(await W.submitBatch([8002])).toEqual({ kind: 'failed', disabled: false });
    expect(calls[0]!.body).toEqual({ items: [{ mediaType: 'movie', tmdbId: 8002 }] });
    routes['POST /api/requests/batch'] = { status: 404, json: { error: 'requests_disabled' } };
    expect(await W.submitBatch([8002])).toEqual({ kind: 'failed', disabled: true });
    expect(get(W.wished).size).toBe(0);
  });
  it('batch answer without a quota keeps the old one', async () => {
    routes['POST /api/requests/batch'] = { json: { results: [] } };
    W.quota.set({ limit: 5, used: 1, resetsAt: 'x' });
    expect(await W.submitBatch([8002])).toEqual({ kind: 'done', results: [], resetsAt: 'x' });
    expect(get(W.quota)).toEqual({ limit: 5, used: 1, resetsAt: 'x' });
  });
});

describe('loading', () => {
  it('quota and own requests load; a failing call leaves the old value', async () => {
    routes['GET /api/requests/quota'] = { json: { limit: null, used: 2, remaining: null, resetsAt: 'r' } };
    await W.loadQuota();
    expect(get(W.quota)).toEqual({ limit: null, used: 2, resetsAt: 'r' });
    routes['GET /api/requests/quota'] = { status: 500, json: {} };
    await W.loadQuota();
    expect(get(W.quota)?.used).toBe(2);
    expect(await W.loadMine()).toBe(false);
    expect(get(W.mine)).toBeNull();
  });
});
