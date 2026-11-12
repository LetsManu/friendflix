// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryKV, RedisKV, type KV } from '../src/kv.js';

// The small self-expiring index the conversion budget keeps its grant keys in (convbudget.ts), so an admission never scans the keyspace.
// MemoryKV always; RedisKV (the Lua scripts) when TEST_REDIS_URL points at a throwaway Redis.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function suite(name: string, make: () => KV) {
  describe(`${name}: indexAdd / indexRemove / indexMembers`, () => {
    it('adds, renews and removes members; an expired member is gone; the index key ends with its last member', async () => {
      const kv = make();
      const key = `t:idx:${randomUUID()}`;
      expect(await kv.indexMembers(key)).toEqual([]);
      await kv.indexAdd(key, 'a', 30);
      await kv.indexAdd(key, 'b', 0.3);
      await kv.indexAdd(key, 'a', 30); // renewed, not doubled
      expect((await kv.indexMembers(key)).sort()).toEqual(['a', 'b']);
      expect(await kv.keys(key)).toEqual([key]); // a key of its own (listed and deleted like one)
      await sleep(450);
      expect(await kv.indexMembers(key)).toEqual(['a']); // b expired
      await kv.indexRemove(key, 'a');
      await kv.indexRemove(key, 'nobody'); // harmless
      expect(await kv.indexMembers(key)).toEqual([]);
      const short = `t:idx:${randomUUID()}`;
      await kv.indexAdd(short, 'x', 0.3);
      await sleep(450);
      expect(await kv.keys(short)).toEqual([]); // no index key outlives its members
    });
    it('a short member does not shorten the index of a longer one', async () => {
      const kv = make();
      const key = `t:idx:${randomUUID()}`;
      await kv.indexAdd(key, 'long', 30);
      await kv.indexAdd(key, 'short', 0.2);
      await sleep(350);
      expect(await kv.indexMembers(key)).toEqual(['long']);
      await kv.del(key);
      expect(await kv.indexMembers(key)).toEqual([]);
    });
  });
}

suite('MemoryKV', () => new MemoryKV());

const url = process.env.TEST_REDIS_URL;
const redis = url ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 }) : null;
afterAll(async () => { await redis?.quit(); });
if (redis) suite('RedisKV', () => new RedisKV(redis));
