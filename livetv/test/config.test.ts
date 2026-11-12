// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KEY_FILE, loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';

const dir = mkdtempSync(join(tmpdir(), 'ff-livetv-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** a fictional, obviously fake key (64 hex); what the bootstrap service writes is HMAC-SHA256(INTERNAL_SECRET, 'friendflix-livetv/v1') */
const KEY_HEX = 'fa'.repeat(32);
const keyFile = join(dir, 'livetv_key');
writeFileSync(keyFile, KEY_HEX);
const E = { LIVETV_KEY_FILE: keyFile };

describe('loadConfig', () => {
  it('defaults: port 8090, 6 GB cache, SRT 9000-9009, no version; the key from the file', () => {
    const c = loadConfig(E);
    expect(c).toEqual({ port: 8090, key: Buffer.from(KEY_HEX, 'hex'), cacheDir: '/cache', cacheMaxBytes: 6 * 1024 ** 3, srtPorts: [9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009], version: null });
    expect(KEY_FILE).toBe('/run/friendflix-livetv/livetv_key');
  });

  it('reads every value and checks it', () => {
    const c = loadConfig({ ...E, PORT: '18090', LIVETV_CACHE_MAX_GB: '2.5', LIVETV_SRT_PORTS: '9100', APP_VERSION: '3.4.0' });
    expect(c).toMatchObject({ port: 18090, cacheMaxBytes: Math.floor(2.5 * 1024 ** 3), srtPorts: [9100], version: '3.4.0' });
    expect(loadConfig({ ...E, APP_VERSION: 'dev' }).version).toBeNull();
    expect(() => loadConfig({ ...E, PORT: '80' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...E, PORT: 'x' })).toThrow(/PORT/);
    for (const gb of ['0', '-1', 'abc', '1e3', '100001']) expect(() => loadConfig({ ...E, LIVETV_CACHE_MAX_GB: gb }), gb).toThrow(/LIVETV_CACHE_MAX_GB/);
    expect(() => loadConfig({ ...E, LIVETV_SRT_PORTS: '9000-9200' })).toThrow(/LIVETV_SRT_PORTS/);
  });

  it('the key file may end in newlines (the bootstrap volume contract); nothing else is a key', () => {
    writeFileSync(join(dir, 'nl'), `${KEY_HEX}\r\n\n`);
    expect(loadConfig({ LIVETV_KEY_FILE: join(dir, 'nl') }).key.toString('hex')).toBe(KEY_HEX);
    for (const [name, bad] of [['upper', KEY_HEX.toUpperCase()], ['short', KEY_HEX.slice(2)], ['long', `${KEY_HEX}aa`], ['raw', 'test-internal-secret-livetv-0123456789'], ['space', ` ${KEY_HEX}`], ['empty', '']] as const) {
      writeFileSync(join(dir, name), bad);
      let msg = '';
      try { loadConfig({ LIVETV_KEY_FILE: join(dir, name) }); } catch (e) { msg = (e as Error).message; }
      expect(msg, name).toMatch(/does not hold a 64-hex key/);
      if (bad) expect(msg, name).not.toContain(bad.trim());
    }
  });

  it('never reads INTERNAL_SECRET: without the key file livetv does not start, whatever the environment holds', () => {
    const empty = mkdtempSync(join(dir, 'empty-'));
    const missing = join(empty, 'livetv_key');
    writeFileSync(join(empty, 'internal_secret'), 'test-internal-secret-livetv-0123456789');
    for (const env of [{}, { INTERNAL_SECRET: 'test-internal-secret-livetv-0123456789' }, { INTERNAL_SECRET_FILE: join(empty, 'internal_secret') }, { FF_GATEWAY_BOOTSTRAP_DIR: empty }]) {
      let msg = '';
      try { loadConfig({ ...env, LIVETV_KEY_FILE: missing }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toBe(`missing key file ${missing}: run docker compose up -d once (the bootstrap service writes it)`);
    }
    // the secret next to a valid key file changes nothing
    expect(loadConfig({ ...E, INTERNAL_SECRET: 'test-internal-secret-livetv-0123456789' }).key.toString('hex')).toBe(KEY_HEX);
    expect(Object.keys(loadConfig(E))).not.toContain('secret');
  });

  it('an unreadable key file is a clear error, not a crash elsewhere', () => {
    const odd = mkdtempSync(join(dir, 'odd-'));
    expect(() => loadConfig({ LIVETV_KEY_FILE: odd })).toThrow(/key file .* is not readable \(EISDIR\)/);
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
