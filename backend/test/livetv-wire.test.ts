// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBootstrap } from '../src/bootstrap.js';
import type { Ctx } from '../src/ctx.js';
import { LivetvError, livetvCall, livetvHealth } from '../src/livetv/client.js';

// The whole chain over real HTTP, no fakes in between (1b review I1, I2): the bootstrap service writes livetv's key file from
// INTERNAL_SECRET, the real livetv server starts from that file, and the backend client detects it with a proof of key and then
// calls it signed. The backend never imports livetv/ in src (separate image); this test loads its server by path only.
type Start = (env: NodeJS.ProcessEnv, o: { log?: (m: string) => void; host?: string }) => Promise<Server>;
const { start } = (await import(new URL('../../livetv/src/server.ts', import.meta.url).href)) as { start: Start };

const SECRET = 'wire-test-internal-secret-0123456789';
const root = mkdtempSync(join(tmpdir(), 'ff-livetv-wire-'));
const logs: string[] = [];
let server: Server, base: string;

const freePort = () => new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const ctx = (secret = SECRET, url = base) => ({ cfg: { LIVETV_URL: url, INTERNAL_SECRET: secret }, fetchImpl: fetch }) as unknown as Ctx;
async function startLivetv(keyFile: string): Promise<{ server: Server; base: string }> {
  const port = await freePort();
  const s = await start({ PORT: String(port), LIVETV_KEY_FILE: keyFile, LIVETV_SRT_PORTS: '9000' }, { log: (m) => logs.push(m), host: '127.0.0.1' });
  return { server: s, base: `http://127.0.0.1:${port}` };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

beforeAll(async () => {
  runBootstrap({ dir: join(root, 'b'), gatewayDir: join(root, 'g'), livetvDir: join(root, 'l'), env: { INTERNAL_SECRET: SECRET }, gid: 10001, chown: () => {}, log: () => {} });
  ({ server, base } = await startLivetv(join(root, 'l', 'livetv_key')));
});
afterAll(async () => {
  await close(server);
  rmSync(root, { recursive: true, force: true });
});

describe('backend -> real livetv, keyed by the bootstrap service', () => {
  it('detection proves the key, then signed calls go through', async () => {
    const c = ctx();
    expect(await livetvHealth(c)).toMatchObject({ api: 1, proof: 'ok' });
    const sys = await livetvCall<{ srt: { ports: number[] } }>(c, 'GET', '/v1/system');
    expect(sys.srt.ports).toEqual([9000]);
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('a backend with another INTERNAL_SECRET sees a wrong proof and sends nothing signed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = ctx('another-internal-secret-0123456789');
      expect(await livetvHealth(c)).toMatchObject({ api: 1, proof: 'wrong' });
      await expect(livetvCall(c, 'GET', '/v1/system')).rejects.toEqual(new LivetvError(null, 'unproven'));
    } finally { warn.mockRestore(); }
  });

  it('a livetv handed the raw secret instead of the derived key proves nothing and refuses the backend', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(root, 'raw_key');
    // a 64-hex INTERNAL_SECRET (what bootstrap generates) is shaped like a key, so livetv would start with it
    const rawHex = 'ab'.repeat(32);
    writeFileSync(file, rawHex);
    const raw = await startLivetv(file);
    try {
      expect(await livetvHealth(ctx(rawHex, raw.base))).toMatchObject({ proof: 'wrong' });
      await expect(livetvCall(ctx(rawHex, raw.base), 'GET', '/v1/system')).rejects.toMatchObject({ code: 'unproven' });
    } finally {
      await close(raw.server);
      warn.mockRestore();
    }
  });
});
