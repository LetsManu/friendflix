// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Old TV browsers (Tizen = Chromium 85, webOS = Chromium 87) run the web code: the live files use nothing newer.
 * Scans every file of lib/live and routes/live plus the named TV files. Later tasks add theirs to NAMED:
 * Task 37 routes/tv/+page.svelte, Task 39 lib/player/hls.ts (the live player loads it on TVs, F12), Task 43 lib/tizen/livekeys.ts.
 * A named file that does not exist fails its case (never skipped).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'lib/live/compat.test.ts';
const DIRS = ['lib/live', 'routes/live'];
const NAMED = ['lib/player/hls.ts', 'lib/ui/dragOrder.ts', 'lib/webos/keys.ts', 'routes/tv/+page.svelte'];
const FORBIDDEN = ['structuredClone(', '.at(', 'Object.hasOwn(', '.findLast(', 'aspect-ratio', 'inset:', ':has(', '@container'];

const rel = (abs: string) => relative(SRC, abs).split(sep).join('/');
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isTest = (f: string) => f.endsWith('.test.ts');
const scanned = [...new Set([...DIRS.flatMap((d) => walk(join(SRC, d))).map(rel), ...NAMED])].filter((f) => !isTest(f) && f !== SELF).sort();

describe('Chromium 85 compat scan', () => {
  it('the compat scan skips tests and itself, and holds the named TV files', () => {
    expect(scanned.some(isTest)).toBe(false);
    expect(scanned).not.toContain(SELF);
    for (const n of NAMED) expect(scanned).toContain(n);
    expect(scanned).toContain('lib/live/livekeys.ts');
  });
  it('the live player files of Task 39 are scanned', () => {
    for (const f of ['lib/player/hls.ts', 'lib/live/LivePlayer.svelte', 'lib/live/liveState.ts', 'lib/live/dvr.ts', 'lib/live/banner.ts', 'lib/live/switcher.ts', 'routes/live/watch/[channelId]/+page.svelte']) {
      expect(scanned).toContain(f);
    }
  });
  it.each(scanned)('%s uses nothing newer than Chromium 85', (f) => {
    const abs = join(SRC, f);
    expect(existsSync(abs), `${f}: a named file is missing, the scan cannot check it`).toBe(true);
    const text = readFileSync(abs, 'utf8');
    for (const token of FORBIDDEN) expect(text.includes(token), `${f} uses ${token}`).toBe(false);
  });
});
