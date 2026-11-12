// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';

const dir = mkdtempSync(join(tmpdir(), 'ff-livetv-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SECRET = 'config-test-secret-0123456789';

describe('loadConfig', () => {
  it('defaults: port 8090, 6 GB cache, SRT 9000-9009, no version', () => {
    const c = loadConfig({ INTERNAL_SECRET: SECRET });
    expect(c).toEqual({ port: 8090, secret: SECRET, cacheDir: '/cache', cacheMaxBytes: 6 * 1024 ** 3, srtPorts: [9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009], version: null });
  });

  it('reads every value and checks it', () => {
    const c = loadConfig({ INTERNAL_SECRET: SECRET, PORT: '18090', LIVETV_CACHE_MAX_GB: '2.5', LIVETV_SRT_PORTS: '9100', APP_VERSION: '3.4.0' });
    expect(c).toMatchObject({ port: 18090, cacheMaxBytes: Math.floor(2.5 * 1024 ** 3), srtPorts: [9100], version: '3.4.0' });
    expect(loadConfig({ INTERNAL_SECRET: SECRET, APP_VERSION: 'dev' }).version).toBeNull();
    expect(() => loadConfig({ INTERNAL_SECRET: SECRET, PORT: '80' })).toThrow(/PORT/);
    expect(() => loadConfig({ INTERNAL_SECRET: SECRET, PORT: 'x' })).toThrow(/PORT/);
    for (const gb of ['0', '-1', 'abc', '1e3', '100001']) expect(() => loadConfig({ INTERNAL_SECRET: SECRET, LIVETV_CACHE_MAX_GB: gb }), gb).toThrow(/LIVETV_CACHE_MAX_GB/);
    expect(() => loadConfig({ INTERNAL_SECRET: SECRET, LIVETV_SRT_PORTS: '9000-9200' })).toThrow(/LIVETV_SRT_PORTS/);
  });

  it('INTERNAL_SECRET: env, INTERNAL_SECRET_FILE, else the gateway copy in the bootstrap volume (the gateway/src/env.ts rule)', () => {
    writeFileSync(join(dir, 'file-secret'), `${SECRET}-file\n`);
    expect(loadConfig({ INTERNAL_SECRET_FILE: join(dir, 'file-secret'), INTERNAL_SECRET: 'ignored' }).secret).toBe(`${SECRET}-file`);
    writeFileSync(join(dir, 'internal_secret'), `${SECRET}-volume\n\n`);
    expect(loadConfig({ FF_GATEWAY_BOOTSTRAP_DIR: dir }).secret).toBe(`${SECRET}-volume`);
    expect(loadConfig({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: SECRET }).secret).toBe(SECRET);
  });

  it('refuses to start without a secret or with a short one, never echoing it', () => {
    const empty = mkdtempSync(join(dir, 'empty-'));
    expect(() => loadConfig({ FF_GATEWAY_BOOTSTRAP_DIR: empty })).toThrow(/missing INTERNAL_SECRET/);
    let msg = '';
    try { loadConfig({ INTERNAL_SECRET: 'short-one' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/INTERNAL_SECRET/);
    expect(msg).not.toContain('short-one');
    // a directory where the file should be: not readable -> a clear error, not a crash elsewhere
    const odd = mkdtempSync(join(dir, 'odd-'));
    writeFileSync(join(odd, 'x'), '');
    expect(() => loadConfig({ FF_GATEWAY_BOOTSTRAP_DIR: join(odd, 'x') })).toThrow(/not readable/);
  });
});

describe('log', () => {
  it('one line with a timestamp and the service name', () => {
    const lines: string[] = [];
    createLog((l) => lines.push(l), () => new Date('2026-11-12T10:00:00.000Z'))('listening on :8090');
    expect(lines).toEqual(['2026-11-12T10:00:00.000Z livetv: listening on :8090']);
  });

  it('cuts long messages and drops control characters (one line per entry)', () => {
    const lines: string[] = [];
    createLog((l) => lines.push(l), () => new Date(0))(`a\nb\u001b[31m${'x'.repeat(600)}`);
    expect(lines[0]).not.toMatch(/[\n\u001b]/);
    expect(lines[0]!.length).toBeLessThanOrEqual('1970-01-01T00:00:00.000Z livetv: '.length + 500);
  });
});
