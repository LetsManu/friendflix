// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardDeps } from '../src/fetch.js';
import { probe } from '../src/probe.js';
import { deriveKey, sign } from '../src/protocol.js';
import { remuxDriver } from '../src/remux.js';
import { ingestRoutes } from '../src/routes/ingest.js';
import type { Run, RunOptions, RunResult } from '../src/run.js';
import { start, type Route, type RouteCall } from '../src/server.js';
import { IngestHub, type Feed, type IngestState } from '../src/srtingest.js';
import { Streams } from '../src/streams.js';
import { flush, memoryStore } from './streams-helpers.js';

/**
 * Task 29: the SRT push ingest. `IngestHub` runs against `fake-srtgate.mjs` (a real child process speaking srtgate's frame
 * protocol, no libsrt, no network); its clock is the fake `now`, timers and pipes are real. The remux driver and the probe take a
 * stub ingest under fake timers. The per-address ban lives in srtgate and is covered by `srtgate --selftest` (image build).
 */
const NOW = Date.parse('2026-11-12T20:15:00.000Z');
const MIN = 60_000;
const FAKE = fileURLToPath(new URL('./fake-srtgate.mjs', import.meta.url));
const PORTS = Array.from({ length: 10 }, (_, i) => 9000 + i);
const PEER = '192.0.2.77';

const NORD: Feed = { channelId: 'ch-nordlicht', port: 9000, streamId: 'ff-AB2CD3EF4GH5JK6L', passphrase: 'nB7kQ2xLmP9vR4tW6yZ1aC3eF5gH8jK0' };
const HAFEN: Feed = { channelId: 'ch-hafenkanal', port: 9001, streamId: 'ff-MN7PQ2RS3TU4VW5X', passphrase: 'Zx_9wV-8uT7sR6qP5oN4mL3kJ2iH1gF0' };
const STERN: Feed = { channelId: 'ch-sternwarte', port: 9050, streamId: 'ff-YZ2AB3CD4EF5GH6J', passphrase: 'Sternwarte-24-passphrase-0000000' };

/** the line srtgate gets for a set: port, stream id and passphrase only, in this key order, never the channel id */
const feedsLine = (feeds: Feed[]) => JSON.stringify({ t: 'feeds', feeds: feeds.map((f) => ({ port: f.port, streamId: f.streamId, passphrase: f.passphrase })) });
const idle = (f: Feed): IngestState => ({ channelId: f.channelId, port: f.port, state: 'idle', since: null, bitrate: null, rejected1h: 0 });

type Step = Record<string, unknown>;
const accepted = (port: number): Step => ({ event: { t: 'accepted', port } });
const closed = (port: number): Step => ({ event: { t: 'closed', port } });
const rejected = (port: number, reason: string): Step => ({ event: { t: 'rejected', port, reason } });
const data = (port: number, fill: number, bytes = 1316, split = false): Step => ({ data: port, bytes, fill, ...(split ? { split: true } : {}) });
const eventHex = (text: string) => {
  const j = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(5);
  h[0] = 0x02;
  h.writeUInt32BE(j.length, 1);
  return Buffer.concat([h, j]).toString('hex');
};

interface Harness {
  hub: IngestHub;
  children: ChildProcess[];
  logs: string[];
  clock: { t: number };
  /** the feeds lines child `i` received, as written */
  lines(i: number): string[];
  /** runs fake steps in child `i` (default: the newest) */
  do(steps: Step[], i?: number): void;
}

const made: Array<{ hub: IngestHub; children: ChildProcess[]; dir: string }> = [];

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ff-srtgate-'));
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const clock = { t: NOW };
  const recordOf = (i: number) => join(dir, `feeds-${i}.jsonl`);
  const hub = new IngestHub({
    spawn: () => {
      const c = spawn(process.execPath, [FAKE, '--ports', '9000-9009', '--record', recordOf(children.length)], { stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(c);
      return c;
    },
    now: () => clock.t,
    log: (m) => { logs.push(m); },
  });
  made.push({ hub, children, dir });
  return {
    hub, children, logs, clock,
    lines: (i) => (existsSync(recordOf(i)) ? readFileSync(recordOf(i), 'utf8').split('\n').filter((l) => l !== '') : []),
    do: (steps, i) => { children[i ?? children.length - 1]!.stdin!.write(`${JSON.stringify({ t: '_do', steps })}\n`); },
  };
}

afterEach(() => {
  for (const m of made.splice(0)) {
    m.hub.close();
    for (const c of m.children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(m.dir, { recursive: true, force: true });
  }
});

const stateOf = (hub: IngestHub, id: string) => hub.state().find((s) => s.channelId === id);

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error('timed out')), ms); })]).finally(() => clearTimeout(t));
}

/** reads a byte stream by count, whatever its chunking */
function bytes(src: AsyncIterable<Uint8Array>) {
  const it = src[Symbol.asyncIterator]();
  let left = Buffer.alloc(0);
  return {
    async read(n: number): Promise<Buffer> {
      while (left.length < n) {
        const r = await within(it.next(), 5_000);
        if (r.done) throw new Error(`ended after ${left.length} of ${n} bytes`);
        left = Buffer.concat([left, Buffer.from(r.value)]);
      }
      const out = Buffer.from(left.subarray(0, n));
      left = left.subarray(n);
      return out;
    },
    async ended(): Promise<boolean> {
      if (left.length > 0) return false;
      return (await within(it.next(), 5_000)).done === true;
    },
  };
}

describe('IngestHub', () => {
  it('setFeeds writes the exact JSON line', async () => {
    const h = harness();
    expect(h.hub.setFeeds([NORD, HAFEN])).toEqual({ listening: [9000, 9001] });
    await vi.waitFor(() => expect(h.lines(0)).toHaveLength(1));
    expect(h.lines(0)[0]).toBe(
      '{"t":"feeds","feeds":[' +
      `{"port":9000,"streamId":"${NORD.streamId}","passphrase":"${NORD.passphrase}"},` +
      `{"port":9001,"streamId":"${HAFEN.streamId}","passphrase":"${HAFEN.passphrase}"}]}`,
    );
    expect(h.hub.state()).toEqual([idle(NORD), idle(HAFEN)]);
    // every call sends the whole set again (a replace, never a diff); an empty set leaves srtgate accepting nothing
    expect(h.hub.setFeeds([HAFEN])).toEqual({ listening: [9001] });
    expect(h.hub.setFeeds([])).toEqual({ listening: [] });
    await vi.waitFor(() => expect(h.lines(0)).toHaveLength(3));
    expect(h.lines(0).slice(1)).toEqual([feedsLine([HAFEN]), '{"t":"feeds","feeds":[]}']);
    expect(h.hub.state()).toEqual([]);
    // one helper for every set
    expect(h.children).toHaveLength(1);
  });

  it('receiving within 5 s of data, idle after 5 s without (fake clock)', async () => {
    const h = harness();
    h.hub.setFeeds([NORD, HAFEN]);
    h.do([accepted(9000), data(9000, 1)]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(true));
    expect(h.hub.receiving(HAFEN.channelId)).toBe(false);
    expect(h.hub.receiving('ch-unbekannt')).toBe(false);
    const s = stateOf(h.hub, NORD.channelId)!;
    expect(s).toMatchObject({ channelId: NORD.channelId, port: 9000, state: 'receiving', since: NOW, rejected1h: 0 });
    expect(Number.isFinite(s.bitrate) && s.bitrate! > 0).toBe(true);
    expect(stateOf(h.hub, HAFEN.channelId)).toEqual(idle(HAFEN));

    h.clock.t = NOW + 4_999;
    expect(h.hub.receiving(NORD.channelId)).toBe(true);
    // no data for more than 5 s: idle, while the connection is still open
    h.clock.t = NOW + 5_001;
    expect(h.hub.receiving(NORD.channelId)).toBe(false);
    expect(stateOf(h.hub, NORD.channelId)).toEqual(idle(NORD));

    // data again: receiving since then
    h.clock.t = NOW + 6_000;
    h.do([data(9000, 2)]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(true));
    expect(stateOf(h.hub, NORD.channelId)).toMatchObject({ state: 'receiving', since: NOW + 6_000 });

    // the sender closes: idle at once, recent data or not
    h.do([closed(9000)]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(false));
    expect(stateOf(h.hub, NORD.channelId)).toEqual(idle(NORD));
  });

  it('the reader yields the last 4 s', async () => {
    const h = harness();
    h.hub.setFeeds([NORD]);
    // a channel without a feed has nothing to read
    expect(await bytes(h.hub.reader('ch-unbekannt')).ended()).toBe(true);

    h.do([accepted(9000), data(9000, 1, 1_000)]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(true));
    // a reader opened now starts with the ring so far, then sees every frame as it arrives
    const live = bytes(h.hub.reader(NORD.channelId));
    expect(await live.read(1_000)).toEqual(Buffer.alloc(1_000, 1));
    const frames: Array<[number, number]> = [[2, 1_500], [3, 3_000], [4, 4_500], [5, 6_000]];
    for (const [fill, at] of frames) {
      h.clock.t = NOW + at;
      // frame 3 reaches livetv in three pieces
      h.do([data(9000, fill, 1_000, fill === 3)]);
      expect(await live.read(1_000)).toEqual(Buffer.alloc(1_000, fill));
    }

    // at 6 s a new reader starts with the oldest frame of the last 4 s (the one of 3 s); those of 0 and 1.5 s are gone
    const late = bytes(h.hub.reader(NORD.channelId));
    expect(await late.read(3_000)).toEqual(Buffer.concat([3, 4, 5].map((f) => Buffer.alloc(1_000, f))));
    // then both go on with new data
    h.clock.t = NOW + 7_000;
    h.do([data(9000, 6, 1_000)]);
    expect(await late.read(1_000)).toEqual(Buffer.alloc(1_000, 6));
    expect(await live.read(1_000)).toEqual(Buffer.alloc(1_000, 6));

    // the sender closes: every reader ends (ffmpeg sees EOF, the driver's reconnect takes over)
    h.do([closed(9000)]);
    expect(await late.ended()).toBe(true);
    expect(await live.ended()).toBe(true);
  });

  it('rejections count per feed for one hour', async () => {
    const h = harness();
    h.hub.setFeeds([NORD, HAFEN]);
    const counts = () => Object.fromEntries(h.hub.state().map((s) => [s.channelId, s.rejected1h]));
    h.do([rejected(9000, 'forbidden'), rejected(9000, 'passphrase')]);
    await vi.waitFor(() => expect(counts()).toEqual({ [NORD.channelId]: 2, [HAFEN.channelId]: 0 }));

    h.clock.t = NOW + 30 * MIN;
    // a conflict does NOT count: it is a second sender with the right stream id while one is connected — no credential was
    // judged, and it is what the owner's own encoder gets while it reconnects before srtgate let go of the old connection
    // (counting it would raise a "falsche Kennung oder Passphrase" event for a working feed; srtgate keeps it out of the
    // per-address ban for the same reason). A rejection on a port without a feed counts for nobody.
    h.do([rejected(9000, 'conflict'), rejected(9000, 'conflict'), rejected(9001, 'forbidden'), rejected(9005, 'forbidden')]);
    await vi.waitFor(() => expect(counts()).toEqual({ [NORD.channelId]: 2, [HAFEN.channelId]: 1 }));
    expect(h.hub.state()).toHaveLength(2);

    // new credentials for the same feed (*Zugangsdaten neu erzeugen*) keep its count
    h.hub.setFeeds([{ ...NORD, passphrase: 'aNewPassphraseFor-Nordlicht-2026' }, HAFEN]);
    expect(counts()).toEqual({ [NORD.channelId]: 2, [HAFEN.channelId]: 1 });

    // the two of 20:15 leave the hour, the one of 20:45 stays
    h.clock.t = NOW + 60 * MIN + 1;
    expect(counts()).toEqual({ [NORD.channelId]: 0, [HAFEN.channelId]: 1 });
    h.clock.t = NOW + 90 * MIN + 1;
    expect(counts()).toEqual({ [NORD.channelId]: 0, [HAFEN.channelId]: 0 });
  });

  it('a crashed helper is respawned and gets the set again', async () => {
    const h = harness();
    h.hub.setFeeds([NORD, HAFEN]);
    await vi.waitFor(() => expect(h.lines(0)).toEqual([feedsLine([NORD, HAFEN])]));
    h.do([accepted(9000), data(9000, 1)]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(true));

    h.children[0]!.kill('SIGKILL');
    await vi.waitFor(() => expect(h.lines(1)).toEqual([feedsLine([NORD, HAFEN])]), { timeout: 10_000, interval: 20 });
    expect(h.children).toHaveLength(2);
    // the connection went with the helper
    expect(h.hub.receiving(NORD.channelId)).toBe(false);
    expect(stateOf(h.hub, NORD.channelId)).toEqual(idle(NORD));

    // the new helper is the one in use: a new set goes to it, its data counts
    h.hub.setFeeds([HAFEN]);
    await vi.waitFor(() => expect(h.lines(1)).toEqual([feedsLine([NORD, HAFEN]), feedsLine([HAFEN])]));
    h.do([accepted(9001), data(9001, 2)]);
    await vi.waitFor(() => expect(h.hub.receiving(HAFEN.channelId)).toBe(true));

    // a helper that exits by itself is respawned too, with the newest set
    h.do([{ exit: 3 }]);
    await vi.waitFor(() => expect(h.lines(2)).toEqual([feedsLine([HAFEN])]), { timeout: 10_000, interval: 20 });
    expect(h.hub.receiving(HAFEN.channelId)).toBe(false);
    expect(h.children).toHaveLength(3);
  }, 30_000);

  it('a frame the protocol does not allow restarts the helper', async () => {
    const h = harness();
    h.hub.setFeeds([NORD]);
    await vi.waitFor(() => expect(h.lines(0)).toHaveLength(1));
    // an event that claims 2 GB is never buffered: the helper is replaced
    h.do([{ raw: '027fffffff7b' }]);
    await vi.waitFor(() => expect(h.lines(1)).toEqual([feedsLine([NORD])]), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(h.children[0]!.exitCode !== null || h.children[0]!.signalCode !== null).toBe(true));
  }, 30_000);

  it('no log line contains a passphrase, a stream id or an address', async () => {
    const h = harness();
    h.hub.setFeeds([NORD, HAFEN]);
    // srtgate frames never carry these; a helper that did anyway (or its stderr) must not reach the log
    h.do([
      { stderr: `srt: handshake from ${PEER}:50123 streamid=${NORD.streamId} passphrase=${NORD.passphrase}\n` },
      { event: { t: 'accepted', port: 9000, peer: `${PEER}:50123`, streamId: NORD.streamId } },
      data(9000, 1),
    ]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(true));
    h.do([
      { event: { t: 'rejected', port: 9001, reason: 'passphrase', peer: PEER, streamId: HAFEN.streamId, passphrase: HAFEN.passphrase } },
      { event: { t: 'rejected', port: 9000, reason: `forbidden ${NORD.streamId} ${PEER}` } },
      { event: { t: `x-${NORD.passphrase}`, port: 9000, note: HAFEN.streamId } },
      { raw: eventHex(`{not json ${NORD.streamId} ${PEER}`) },
      data(9005, 9, 10),
      { event: { t: 'closed', port: 9000, peer: PEER } },
    ]);
    await vi.waitFor(() => expect(h.hub.receiving(NORD.channelId)).toBe(false));
    expect(stateOf(h.hub, HAFEN.channelId)!.rejected1h).toBe(1);
    // a frame type the protocol does not know: the helper is replaced (and that is logged, without its bytes)
    h.do([{ raw: Buffer.concat([Buffer.from([0x07]), Buffer.from(`${NORD.streamId} ${PEER}`)]).toString('hex') }]);
    await vi.waitFor(() => expect(h.lines(1)).toEqual([feedsLine([NORD, HAFEN])]), { timeout: 10_000, interval: 20 });

    const text = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const secret of [NORD.streamId, NORD.passphrase, HAFEN.streamId, HAFEN.passphrase, PEER, '50123']) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
    expect(text).not.toMatch(/ff-[A-Z2-7]{6}/);
    expect(JSON.stringify(h.hub.state())).not.toMatch(/ff-|192\.0\.2|streamId|passphrase/);
  }, 30_000);
});

describe('PUT /v1/ingest, GET /v1/ingest', () => {
  const routeOf = (routes: Route[], method: string) => routes.find((r) => r.method === method && r.path === '/v1/ingest')!;
  const call = (r: Route, json: unknown = null) => r.handle({ json, params: [] } as unknown as RouteCall);

  it('PUT replaces the set', async () => {
    const h = harness();
    const routes = ingestRoutes(h.hub, { ports: PORTS });
    const put = routeOf(routes, 'PUT');
    const get = routeOf(routes, 'GET');
    expect(await call(get)).toEqual({ status: 200, json: [] });

    // a port outside LIVETV_SRT_PORTS is ignored (the backend shows "Port {p} liegt nicht mehr im Bereich")
    expect(await call(put, { feeds: [NORD, HAFEN, STERN] })).toEqual({ status: 200, json: { ok: true, listening: [9000, 9001] } });
    expect(await call(get)).toEqual({ status: 200, json: [idle(NORD), idle(HAFEN)] });
    await vi.waitFor(() => expect(h.lines(0)).toEqual([feedsLine([NORD, HAFEN])]));

    // a removed feed disappears
    expect(await call(put, { feeds: [HAFEN] })).toEqual({ status: 200, json: { ok: true, listening: [9001] } });
    expect(await call(get)).toEqual({ status: 200, json: [idle(HAFEN)] });
    await vi.waitFor(() => expect(h.lines(0)).toEqual([feedsLine([NORD, HAFEN]), feedsLine([HAFEN])]));

    // a broken body changes nothing (the replace is atomic) and is never echoed
    for (const bad of [null, [], 'feeds']) expect(await call(put, bad)).toEqual({ status: 400, json: { error: 'invalid', field: 'body' } });
    const broken: unknown[] = [
      {}, { feeds: {} }, { feeds: [null] },
      { feeds: [{ ...NORD, channelId: 'ch nordlicht' }] },
      { feeds: [{ ...NORD, port: 9000.5 }] }, { feeds: [{ ...NORD, port: '9000' }] }, { feeds: [{ ...NORD, port: 0 }] }, { feeds: [{ ...NORD, port: 70_000 }] },
      { feeds: [{ ...NORD, streamId: '' }] }, { feeds: [{ ...NORD, streamId: 'f'.repeat(513) }] }, { feeds: [{ ...NORD, streamId: 'ff-\u0000AB' }] },
      { feeds: [{ ...NORD, passphrase: 'kurz' }] }, { feeds: [{ ...NORD, passphrase: 'p'.repeat(80) }] }, { feeds: [{ ...NORD, passphrase: 42 }] },
      // one port carries one feed; one feed has one port
      { feeds: [NORD, { ...HAFEN, port: 9000 }] }, { feeds: [NORD, { ...HAFEN, channelId: NORD.channelId }] },
    ];
    for (const bad of broken) expect([bad, await call(put, bad)]).toEqual([bad, { status: 400, json: { error: 'invalid', field: 'feeds' } }]);
    expect(await call(get)).toEqual({ status: 200, json: [idle(HAFEN)] });
    expect(h.lines(0)).toHaveLength(2);
  });

  it('start registers the ingest routes (no srtgate binary here: the hub copes)', async () => {
    const free = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => r(n)); }); });
    const secret = 'start-ingest-secret-0123456789ab';
    const logs: string[] = [];
    const s = await start({ PORT: String(free), INTERNAL_SECRET: secret, LIVETV_SRT_PORTS: '9000-9001' }, { log: (m) => { logs.push(m); }, host: '127.0.0.1' });
    const k = deriveKey(secret);
    const req = (method: string, path: string, b?: unknown) => {
      const text = b === undefined ? '' : JSON.stringify(b);
      return fetch(`http://127.0.0.1:${free}${path}`, { method, ...(text ? { body: text } : {}), headers: { ...sign(k, method, path, text), ...(text ? { 'content-type': 'application/json' } : {}) } });
    };
    try {
      const p = await req('PUT', '/v1/ingest', { feeds: [NORD, { ...HAFEN, port: 9005 }] });
      expect([p.status, await p.json()]).toEqual([200, { ok: true, listening: [9000] }]);
      const g = await req('GET', '/v1/ingest');
      expect([g.status, await g.json()]).toEqual([200, [idle(NORD)]]);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    const text = logs.join('\n');
    for (const secret of [NORD.streamId, NORD.passphrase, HAFEN.streamId, HAFEN.passphrase]) expect(text).not.toContain(secret);
  });
});

// ---- the push input in the driver and the probe: a stub ingest ----

const ROOT = '/cache';
const TS = Buffer.alloc(376, 0x47);
/** what the ring holds: two chunks */
const RING = Buffer.concat([Buffer.alloc(700, 0x47), Buffer.alloc(616, 0x48)]);
const H264_JSON = JSON.stringify({ streams: [
  { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
  { codec_type: 'audio', codec_name: 'aac', channels: 2 },
] });

const has = (args: readonly string[], part: readonly string[]): boolean =>
  part.length > 0 && args.some((_, i) => part.every((p, j) => args[i + j] === p));

/** a guard whose lookup must never run: a push input connects nowhere (ruling 3) */
function guard(): GuardDeps & { lookup: ReturnType<typeof vi.fn> } {
  return { own: [], lookup: vi.fn(async () => ['192.0.2.40']) };
}

/**
 * The ingest as the driver and the probe see it: each reader yields RING in two chunks, then waits for more until it is closed
 * (`return()`); `closed()` counts distinct readers that were closed.
 */
function stubIngest(receiving: () => boolean = () => true) {
  const readers: string[] = [];
  const closedIds = new Set<number>();
  const ingest = {
    receiving: (_id: string) => receiving(),
    reader: (id: string): AsyncIterable<Uint8Array> => {
      const n = readers.push(id);
      const chunks = [RING.subarray(0, 700), RING.subarray(700)];
      let wake: (() => void) | null = null;
      let ended = false;
      const it: AsyncIterator<Uint8Array> = {
        next: () => {
          if (chunks.length > 0) return Promise.resolve({ done: false, value: chunks.shift()! });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((r) => { wake = () => r({ done: true, value: undefined }); });
        },
        return: () => {
          ended = true;
          closedIds.add(n);
          wake?.();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
      return { [Symbol.asyncIterator]: () => it };
    },
  };
  return { ingest, readers, closed: () => closedIds.size };
}

type RunCall = { cmd: string; args: string[]; o: RunOptions; stdin: Buffer };
/**
 * ffprobe reads RING from stdin and answers H.264 + AAC; ffmpeg reads RING, writes one segment and reports it, then runs until its
 * signal aborts. Without stdin both fail at once.
 */
function fakeRun(files: Map<string, Buffer>): { run: Run; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = (async (cmd, args, o): Promise<RunResult> => {
    const call: RunCall = { cmd, args, o, stdin: Buffer.alloc(0) };
    calls.push(call);
    if (!o.stdin) return { code: 1, stdout: Buffer.alloc(0), stderr: '' };
    const it = o.stdin[Symbol.asyncIterator]();
    while (call.stdin.length < RING.length) {
      const r = await it.next();
      if (r.done) break;
      call.stdin = Buffer.concat([call.stdin, Buffer.from(r.value)]);
    }
    if (cmd === 'ffprobe') {
      await it.return?.();
      return { code: 0, stdout: Buffer.from(H264_JSON), stderr: '' };
    }
    files.set(join(dirname(args.at(-1)!), '0.ts'), TS);
    o.onStdout?.(Buffer.from('0.ts,0.000000,4.000000\n'));
    await new Promise<void>((r) => {
      if (o.signal?.aborted) r();
      else o.signal?.addEventListener('abort', () => r(), { once: true });
    });
    await it.return?.();
    return { code: 255, stdout: Buffer.alloc(0), stderr: '' };
  }) as Run;
  return { run, calls };
}

describe('a push input', () => {
  let mem: ReturnType<typeof memoryStore>;
  let current: Streams | null = null;
  const logs: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mem = memoryStore();
    logs.length = 0;
  });
  afterEach(async () => {
    await current?.close();
    current = null;
    vi.useRealTimers();
  });

  function setup(receiving?: () => boolean) {
    const s = stubIngest(receiving);
    const { run, calls } = fakeRun(mem.files);
    const g = guard();
    const log = (m: string) => { logs.push(m); };
    const driver = remuxDriver({ run, guard: g, ingest: s.ingest, log, size: async (p: string) => mem.files.get(p)?.length ?? 0 });
    const streams = new Streams({ root: ROOT, maxBytes: 1024 ** 3, drivers: { remux: driver, transcode: driver }, store: mem.store, log });
    current = streams;
    return { s, calls, g, streams };
  }
  const startPush = (streams: Streams) => streams.start({
    channelId: NORD.channelId, input: { push: NORD.channelId }, mode: 'remux', encoder: 'libx264', dvrSeconds: 600, maxBitrate: 10_000_000,
  });
  const viewOf = (streams: Streams) => streams.list().find((v) => v.channelId === NORD.channelId)!;

  it('a push input feeds ffmpeg through stdin', async () => {
    const { s, calls, g, streams } = setup();
    const { streamKey } = startPush(streams);
    await flush();
    // the start probe and ffmpeg both read the feed's ring on stdin; neither gets a URL or an address
    expect(calls.map((c) => c.cmd)).toEqual(['ffprobe', 'ffmpeg']);
    for (const c of calls) {
      expect(has(c.args, ['-protocol_whitelist', 'pipe'])).toBe(true);
      expect(has(c.args, ['-i', 'pipe:0'])).toBe(true);
      expect(c.args.some((a) => /srt:|udp|ff-|:\/\//.test(a))).toBe(false);
      expect(c.stdin).toEqual(RING);
    }
    expect(s.readers).toEqual([NORD.channelId, NORD.channelId]);
    expect(g.lookup).not.toHaveBeenCalled();
    expect(viewOf(streams)).toMatchObject({ mode: 'remux', state: 'running', errors: [], lastSegmentAt: NOW });
    expect(mem.files.get(`${ROOT}/${streamKey}/index.m3u8`)?.toString('utf8')).toContain('0.ts');
    // a stop closes every reader it opened (the probe's at once, ffmpeg's with the stop)
    await streams.stop(NORD.channelId);
    expect(s.closed()).toBe(s.readers.length);
  });

  it('a push feed that is not receiving starts ffmpeg only once data comes', async () => {
    let on = false;
    const { s, calls, streams } = setup(() => on);
    startPush(streams);
    await flush();
    // nothing to read: neither ffprobe nor ffmpeg waits on an empty ring; the stream is in its input-lost state
    expect(calls).toEqual([]);
    expect(s.readers).toEqual([]);
    expect(viewOf(streams).errors.map((e) => e.code)).toEqual(['input_lost']);
    on = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const ff = calls.filter((c) => c.cmd === 'ffmpeg');
    expect(ff).toHaveLength(1);
    expect(ff[0]!.stdin).toEqual(RING);
    expect(viewOf(streams).errors.map((e) => e.code)).toEqual(['input_lost', 'input_back']);
  });
});

describe('probe of a push input', () => {
  it('ffprobe reads the ring on stdin; a feed that is not receiving is unreachable', async () => {
    const s = stubIngest();
    const { run, calls } = fakeRun(new Map());
    const g = guard();
    expect(await probe({ push: NORD.channelId }, { run, guard: g, ingest: s.ingest })).toEqual({
      ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('ffprobe');
    expect(has(calls[0]!.args, ['-protocol_whitelist', 'pipe'])).toBe(true);
    expect(has(calls[0]!.args, ['-i', 'pipe:0'])).toBe(true);
    expect(calls[0]!.stdin).toEqual(RING);
    expect(s.closed()).toBe(1);
    expect(g.lookup).not.toHaveBeenCalled();

    const idleFeed = stubIngest(() => false);
    expect(await probe({ push: NORD.channelId }, { run, guard: g, ingest: idleFeed.ingest })).toEqual({ ok: false, needs: 'transcode', error: 'unreachable' });
    expect(calls).toHaveLength(1);
    expect(idleFeed.readers).toEqual([]);
  });
});
