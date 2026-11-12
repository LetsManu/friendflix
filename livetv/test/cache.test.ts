// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearStale, evict, fsStore } from '../src/cache.js';
import { SegmentWindow } from '../src/window.js';

function filled(dvrSeconds: number, n: number, bytes = 1000): SegmentWindow {
  const w = new SegmentWindow({ dvrSeconds, ext: 'ts' });
  for (let i = 0; i < n; i++) w.add({ file: `${i}.ts`, duration: 4, pdt: i * 4000, bytes });
  return w;
}

describe('evict', () => {
  it('windows of 30 and 10 min over the cap: only the 30-min one loses its oldest', () => {
    const long = filled(1800, 450);
    const short = filled(600, 150);
    expect([long.seconds, short.seconds]).toEqual([1800, 600]);
    const total = long.bytes + short.bytes;
    const out = evict([{ id: 'ch-hafenkanal', w: short }, { id: 'ch-nordlicht', w: long }], total - 1500);
    expect(out).toEqual([{ id: 'ch-nordlicht', file: '0.ts' }, { id: 'ch-nordlicht', file: '1.ts' }]);
    expect([long.length, short.length]).toEqual([448, 150]);
  });

  it('under the cap nothing goes', () => {
    const w = filled(1800, 10);
    expect(evict([{ id: 'a', w }], w.bytes)).toEqual([]);
  });

  it('the newest 3 never go, whatever the cap', () => {
    const a = filled(1800, 20);
    const b = filled(600, 5);
    const out = evict([{ id: 'a', w: a }, { id: 'b', w: b }], 0);
    expect(out).toHaveLength(17 + 2);
    expect([a.length, b.length]).toEqual([3, 3]);
    // windows shrink towards each other: the longer one gives first
    expect(out.slice(0, 15).every((x) => x.id === 'a')).toBe(true);
  });
});

describe('fsStore', () => {
  let root = '';
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('writes text and streams atomically, removes files and directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'ltv-cache-'));
    const dir = join(root, 'k');
    await fsStore.mkdir(dir);
    expect(await fsStore.write(join(dir, 'index.m3u8'), '#EXTM3U\n')).toBe(8);
    const body = (async function* () { yield Buffer.from('ab'); yield Buffer.from('cde'); })();
    expect(await fsStore.write(join(dir, '0.ts'), body)).toBe(5);
    expect(await readFile(join(dir, '0.ts'), 'utf8')).toBe('abcde');
    expect((await readdir(dir)).sort()).toEqual(['0.ts', 'index.m3u8']);
    await fsStore.remove(join(dir, '0.ts'));
    await fsStore.remove(join(dir, 'missing.ts'));
    expect(await readdir(dir)).toEqual(['index.m3u8']);
    await fsStore.removeDir(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it('a body that fails leaves no file behind', async () => {
    root = await mkdtemp(join(tmpdir(), 'ltv-cache-'));
    const body = (async function* () { yield Buffer.from('ab'); throw new Error('too_big'); })();
    await expect(fsStore.write(join(root, '1.ts'), body)).rejects.toThrow('too_big');
    expect(await readdir(root)).toEqual([]);
  });

  it('clearStale removes leftover stream directories only', async () => {
    root = await mkdtemp(join(tmpdir(), 'ltv-cache-'));
    await mkdir(join(root, '0123456789abcdef0123456789abcdef'));
    await writeFile(join(root, '0123456789abcdef0123456789abcdef', '0.ts'), 'x');
    await mkdir(join(root, 'previews'));
    await clearStale(root);
    expect(await readdir(root)).toEqual(['previews']);
    await clearStale(join(root, 'missing'));
  });
});
