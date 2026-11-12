// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Log } from './log.js';

/**
 * The SRT push ingest (spec §3.5; plan ruling 2, Task 29). `srtgate` (livetv/native/srtgate.c, libsrt `srt_listen_callback`) is a
 * separate process listening on every UDP port of LIVETV_SRT_PORTS; a crash of it ends only that process. It gets the feed set as
 * one JSON line on stdin (`{"t":"feeds","feeds":[{port,streamId,passphrase}]}`, the whole set every time) and answers stdout frames:
 * data `0x01 <u16 port BE> <u32 len BE> <payload>`, event `0x02 <u32 len BE> <json>` (`accepted`, `closed`, `rejected` with a
 * fixed reason; never a stream id, passphrase or address). Stream id comparison, passphrase and the per-address throttle live in
 * srtgate.
 *
 * `IngestHub` keeps the set in memory only (the backend sends it again with `PUT /v1/ingest` after a livetv restart), a 4-s ring
 * per feed, the receiving state (an accepted connection with data in the last 5 s) and the rejections of the last hour (wrong
 * stream id or passphrase; a `conflict`, a second sender while one is connected, is logged but not counted). An exited helper is
 * started again with backoff and gets the current set at once; a frame the protocol does not allow (unknown type, an event over
 * 4 KB, a data frame over 1 MB) replaces the helper. Logs: channel ids, fixed texts and exit codes only; the helper's stderr is
 * never read into a log.
 */
export interface Feed { channelId: string; port: number; streamId: string; passphrase: string }
/** `GET /v1/ingest` items; re-declared field for field in backend/src/livetv/wire.ts (F4) */
export interface IngestState {
  channelId: string;
  port: number;
  state: 'idle' | 'receiving';
  since: number | null;
  bitrate: number | null;
  rejected1h: number;
}
/** what the hub needs of a child process (a `ChildProcess` fits) */
export interface ChildLike {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown;
}
export interface IngestDeps {
  spawn(): ChildLike;
  now(): number;
  log: Log;
}
/** what the remux driver and the probe read: a push input is its feed's ring, never an address (ruling 3) */
export interface IngestReader {
  receiving(channelId: string): boolean;
  reader(channelId: string): AsyncIterable<Uint8Array>;
}

export const SRTGATE_BIN = '/usr/local/bin/srtgate';
/** spec §3.5: the in-memory ring per feed */
export const RING_MS = 4_000;
/** spec §3.5: receiving = data within this long */
export const RECEIVING_MS = 5_000;
/** the delays before starting an exited helper again; a helper that ran a minute starts from the first again */
export const RESPAWN_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const MAX_EVENT_BYTES = 4096;
export const MAX_DATA_BYTES = 1024 * 1024;
const STABLE_MS = 60_000;
const MINUTE_MS = 60_000;
const REJECT_MINUTES = 60;
const REJECT_LOG_MS = 10 * MINUTE_MS;
/** a ring never holds more than this, whatever the bitrate */
const RING_MAX_BYTES = 32 * 1024 * 1024;
/** a reader this far behind (a stuck ffmpeg) is ended instead of buffering without limit */
const READER_MAX_BYTES = 64 * 1024 * 1024;
const REASONS = new Set(['forbidden', 'conflict', 'passphrase']);
const DATA = 0x01;
const EVENT = 0x02;
const EMPTY = Buffer.alloc(0);
const CHILD_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' };

/** the production helper: `srtgate --ports A-B`, its stderr not even piped */
export function srtgateSpawner(ports: readonly number[], bin = SRTGATE_BIN): () => ChildLike {
  const range = ports.length === 1 ? `${ports[0]}` : `${ports[0]}-${ports[ports.length - 1]}`;
  return () => spawn(bin, ['--ports', range], { env: CHILD_ENV, stdio: ['pipe', 'pipe', 'ignore'] });
}

/** one consumer of a feed: starts with the ring, then every new chunk; ends with the connection */
class Reader implements AsyncIterator<Uint8Array> {
  private q: Buffer[] = [];
  private bytes = 0;
  private done = false;
  private wake: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  constructor(private readonly detach: (r: Reader) => void) {}

  push(b: Buffer): void {
    if (this.done) return;
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w({ done: false, value: b });
      return;
    }
    this.q.push(b);
    this.bytes += b.length;
    if (this.bytes > READER_MAX_BYTES) this.end(true);
  }

  /** no more data: what is queued is still read, unless `drop` */
  end(drop = false): void {
    if (this.done) return;
    this.done = true;
    if (drop) { this.q = []; this.bytes = 0; }
    this.detach(this);
    if (this.wake && this.q.length === 0) {
      const w = this.wake;
      this.wake = null;
      w({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const b = this.q.shift();
    if (b) {
      this.bytes -= b.length;
      return Promise.resolve({ done: false, value: b });
    }
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.wake = resolve; });
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    this.end(true);
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return this; }
}

interface Slot {
  feed: Feed;
  connected: boolean;
  lastData: number | null;
  /** the start of the current receiving period */
  since: number | null;
  ring: Array<{ at: number; data: Buffer }>;
  ringBytes: number;
  readers: Set<Reader>;
}

const newSlot = (f: Feed): Slot => ({ feed: { ...f }, connected: false, lastData: null, since: null, ring: [], ringBytes: 0, readers: new Set() });
const nothing: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

export class IngestHub implements IngestReader {
  private slots: Slot[] = [];
  private byPort = new Map<number, Slot>();
  private byChannel = new Map<string, Slot>();
  /** per channel: rejections per minute of the last hour */
  private rejections = new Map<string, Array<{ m: number; n: number }>>();
  private rejectLogged = new Map<string, number>();
  private hasSet = false;
  private child: ChildLike | null = null;
  private broken = false;
  private buf: Buffer = EMPTY;
  private attempt = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: IngestDeps) {
    this.launch();
  }

  /** replaces the whole set; a feed that keeps its channel and port keeps its connection state and its rejection count */
  setFeeds(feeds: Feed[]): { listening: number[] } {
    const next: Slot[] = [];
    const kept = new Set<Slot>();
    for (const f of feeds) {
      const old = this.byChannel.get(f.channelId);
      if (old && old.feed.port === f.port && !kept.has(old)) {
        // new credentials: srtgate drops a running sender itself and reports it `closed`
        old.feed = { ...f };
        kept.add(old);
        next.push(old);
      } else {
        next.push(newSlot(f));
      }
    }
    for (const s of this.slots) if (!kept.has(s)) this.disconnect(s);
    this.slots = next;
    this.byPort = new Map(next.map((s) => [s.feed.port, s]));
    this.byChannel = new Map(next.map((s) => [s.feed.channelId, s]));
    for (const id of [...this.rejections.keys()]) if (!this.byChannel.has(id)) this.rejections.delete(id);
    for (const id of [...this.rejectLogged.keys()]) if (!this.byChannel.has(id)) this.rejectLogged.delete(id);
    this.hasSet = true;
    this.send();
    return { listening: next.map((s) => s.feed.port).sort((a, b) => a - b) };
  }

  state(): IngestState[] {
    const now = this.deps.now();
    return this.slots.map((s): IngestState => {
      const r = this.isReceiving(s, now);
      return {
        channelId: s.feed.channelId, port: s.feed.port, state: r ? 'receiving' : 'idle', since: r ? s.since : null,
        bitrate: r ? this.bitrateOf(s, now) : null, rejected1h: this.rejectedOf(s.feed.channelId, now),
      };
    });
  }

  receiving(channelId: string): boolean {
    const s = this.byChannel.get(channelId);
    return s !== undefined && this.isReceiving(s, this.deps.now());
  }

  /** the feed's bytes from the oldest of the 4-s ring on; ends when the sender goes (or the feed leaves the set) */
  reader(channelId: string): AsyncIterable<Uint8Array> {
    const s = this.byChannel.get(channelId);
    if (!s) return nothing;
    this.trim(s, this.deps.now());
    const r = new Reader((x) => { s.readers.delete(x); });
    for (const e of s.ring) r.push(e.data);
    s.readers.add(r);
    return { [Symbol.asyncIterator]: () => r };
  }

  /** stops the helper for good (shutdown, tests) */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin?.end(); } catch { /* already gone */ }
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    for (const s of this.slots) this.disconnect(s);
  }

  // ---- the helper ----

  private launch(): void {
    this.timer = null;
    if (this.closed) return;
    let child: ChildLike;
    try {
      child = this.deps.spawn();
    } catch {
      this.deps.log('srtgate could not be started');
      this.respawn();
      return;
    }
    this.child = child;
    this.broken = false;
    this.buf = EMPTY;
    this.startedAt = this.deps.now();
    let gone = false;
    const onGone = (code?: unknown, signal?: unknown) => {
      if (gone) return;
      gone = true;
      if (this.child !== child) return;
      this.child = null;
      for (const s of this.slots) this.disconnect(s);
      const how = typeof code === 'number' ? `code ${code}` : typeof signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(signal) ? signal : 'error';
      this.deps.log(`srtgate ended (${how}), starting it again`);
      this.respawn();
    };
    child.on('exit', (code: unknown, signal: unknown) => onGone(code, signal));
    child.on('error', () => {
      onGone();
      try { child.kill('SIGKILL'); } catch { /* never started */ }
    });
    // EPIPE and friends: the exit handler restarts the helper; none of it may reach the process
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stdout?.on('data', (c: Buffer) => { if (this.child === child && !this.broken) this.onChunk(c); });
    child.stderr?.on('error', () => {});
    child.stderr?.resume();
    if (this.hasSet) this.send();
  }

  private respawn(): void {
    if (this.closed || this.timer) return;
    if (this.deps.now() - this.startedAt >= STABLE_MS) this.attempt = 0;
    const ms = RESPAWN_MS[Math.min(this.attempt, RESPAWN_MS.length - 1)]!;
    this.attempt++;
    this.timer = setTimeout(() => this.launch(), ms);
    this.timer.unref?.();
  }

  private send(): void {
    const c = this.child;
    if (!c?.stdin || c.stdin.destroyed) return;
    const line = JSON.stringify({ t: 'feeds', feeds: this.slots.map((s) => ({ port: s.feed.port, streamId: s.feed.streamId, passphrase: s.feed.passphrase })) });
    try {
      c.stdin.write(`${line}\n`);
    } catch {
      // the helper is going: its exit handler starts a new one, which gets the set
    }
  }

  private protocolError(): void {
    this.broken = true;
    this.buf = EMPTY;
    this.deps.log('srtgate broke the frame protocol, starting it again');
    try { this.child?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  private onChunk(c: Buffer): void {
    const buf = this.buf.length > 0 ? Buffer.concat([this.buf, c]) : c;
    let off = 0;
    while (off < buf.length) {
      const type = buf[off];
      if (type === DATA) {
        if (buf.length - off < 7) break;
        const port = buf.readUInt16BE(off + 1);
        const n = buf.readUInt32BE(off + 3);
        if (n > MAX_DATA_BYTES) { this.protocolError(); return; }
        if (buf.length - off < 7 + n) break;
        this.onData(port, Buffer.from(buf.subarray(off + 7, off + 7 + n)));
        off += 7 + n;
      } else if (type === EVENT) {
        if (buf.length - off < 5) break;
        const n = buf.readUInt32BE(off + 1);
        if (n > MAX_EVENT_BYTES) { this.protocolError(); return; }
        if (buf.length - off < 5 + n) break;
        this.onEvent(buf.subarray(off + 5, off + 5 + n));
        off += 5 + n;
      } else {
        this.protocolError();
        return;
      }
    }
    this.buf = off >= buf.length ? EMPTY : Buffer.from(buf.subarray(off));
  }

  private onData(port: number, data: Buffer): void {
    const s = this.byPort.get(port);
    if (!s || data.length === 0) return;
    const now = this.deps.now();
    if (!this.isReceiving(s, now)) s.since = now;
    s.connected = true;
    s.lastData = now;
    s.ring.push({ at: now, data });
    s.ringBytes += data.length;
    this.trim(s, now);
    for (const r of [...s.readers]) r.push(data);
  }

  private onEvent(raw: Buffer): void {
    let e: unknown;
    try {
      e = JSON.parse(raw.toString('utf8'));
    } catch {
      this.deps.log('srtgate sent an unreadable event');
      return;
    }
    if (typeof e !== 'object' || e === null) return;
    const { t, port, reason } = e as Record<string, unknown>;
    if (typeof port !== 'number' || !Number.isInteger(port)) return;
    const s = this.byPort.get(port);
    if (!s) return;
    const id = s.feed.channelId;
    if (t === 'accepted') {
      this.disconnect(s, false);
      s.connected = true;
      this.deps.log(`ingest ${id} sender connected`);
    } else if (t === 'closed') {
      this.disconnect(s);
      this.deps.log(`ingest ${id} sender gone`);
    } else if (t === 'rejected') {
      const now = this.deps.now();
      // `rejected1h` feeds the "falsche Kennung oder Passphrase" event (spec §3.5); a conflict checked no credential (usually the
      // owner's own encoder reconnecting while the old connection is still held), so it is logged but not counted
      if (reason !== 'conflict') this.countRejection(id, now);
      const last = this.rejectLogged.get(id);
      if (last === undefined || now - last >= REJECT_LOG_MS) {
        this.rejectLogged.set(id, now);
        this.deps.log(`ingest ${id} refused a sender (${typeof reason === 'string' && REASONS.has(reason) ? reason : 'other'})`);
      }
    }
  }

  // ---- state ----

  private isReceiving(s: Slot, now: number): boolean {
    return s.connected && s.lastData !== null && now - s.lastData < RECEIVING_MS;
  }

  private trim(s: Slot, now: number): void {
    while (s.ring.length > 0 && (s.ring[0]!.at < now - RING_MS || s.ringBytes > RING_MAX_BYTES)) s.ringBytes -= s.ring.shift()!.data.length;
  }

  /** bit/s over the ring */
  private bitrateOf(s: Slot, now: number): number {
    this.trim(s, now);
    return Math.round((s.ringBytes * 8) / (RING_MS / 1000));
  }

  /** the connection is gone: readers end (after what they queued), the ring is dropped */
  private disconnect(s: Slot, endReaders = true): void {
    s.connected = false;
    s.lastData = null;
    s.since = null;
    s.ring = [];
    s.ringBytes = 0;
    if (endReaders) for (const r of [...s.readers]) r.end();
  }

  private countRejection(id: string, now: number): void {
    const m = Math.floor(now / MINUTE_MS);
    const list = this.rejections.get(id) ?? [];
    const last = list[list.length - 1];
    if (last && last.m === m) last.n++;
    else list.push({ m, n: 1 });
    while (list.length > 0 && list[0]!.m <= m - REJECT_MINUTES) list.shift();
    this.rejections.set(id, list);
  }

  private rejectedOf(id: string, now: number): number {
    const m = Math.floor(now / MINUTE_MS);
    let n = 0;
    for (const e of this.rejections.get(id) ?? []) if (e.m > m - REJECT_MINUTES) n += e.n;
    return n;
  }
}
