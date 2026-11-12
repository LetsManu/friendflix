// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { evict, fsStore, type Store } from './cache.js';
import type { Log } from './log.js';
import type { StreamInput } from './probe.js';
import type { Encoder } from './system.js';
import { SegmentWindow, type SegmentExt } from './window.js';

/**
 * The shared streams of spec §3.3 (plan rulings 23, 47): one stream per channel for every viewer, started idempotently by the
 * backend (`POST /v1/streams`). A stream is a *driver* (one per mode: passthrough here, remux and transcode in Task 28) feeding
 * one `SegmentWindow` under `<root>/<streamKey>/`. What every mode shares lives here, not in the drivers: the window and its
 * playlist file, the cache cap, the reconnect backoff (2, 4, 8, 15, 30 s, then every 30 s) with its `input_lost` / `input_back`
 * events, the failed state and the safety net (no `/s/` fetch for 180 s → stop). Logs name the channel id only: never the
 * stream key (it is the credential of `/s/`), an input URL or a path.
 */
export type Mode = 'passthrough' | 'remux' | 'transcode';
export interface StartBody { channelId: string; input: StreamInput; mode: Mode; encoder: Encoder; dvrSeconds: number /* 0–7200, ruling 47 */; maxBitrate: number }
export interface StreamView {
  channelId: string;
  streamKey: string /* 32 hex */;
  mode: Mode;
  since: number;
  state: 'starting' | 'running' | 'reconnecting' | 'failed';
  bitrate: number | null;
  errors: Array<{ at: number; code: 'input_lost' | 'input_back'; seconds?: number }>;
  lastSegmentAt: number | null;
}

export const MODES: readonly Mode[] = ['passthrough', 'remux', 'transcode'];
/** spec §3.3: the reconnect delays; the last one repeats */
export const BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** spec §3.3 safety net: a stream nobody fetched from for this long stops by itself */
export const IDLE_STOP_MS = 180_000;
/** the newest events kept per stream */
export const MAX_EVENTS = 50;
const MAX_TIMER = 2 ** 31 - 1;

/** the delay before reconnect attempt `n` (0-based) */
export const backoffDelay = (n: number): number => BACKOFF_MS[Math.min(Math.max(0, n), BACKOFF_MS.length - 1)]!;

export class StreamsError extends Error {
  constructor(readonly code: 'unsupported_mode') { super(code); }
}

/**
 * What a driver gets. A driver runs until `signal` aborts (its promise then settles; files are removed only after that) and
 * reports through the context; it never logs a URL or ffmpeg arguments itself.
 */
export interface DriverContext {
  readonly channelId: string;
  /** `<root>/<streamKey>`: the driver stores its segment files (and `init.mp4`) here, under names it chooses */
  readonly dir: string;
  readonly input: StreamInput;
  readonly mode: Mode;
  readonly encoder: Encoder;
  readonly maxBitrate: number;
  readonly signal: AbortSignal;
  readonly store: Store;
  /** the stream's window, created by the first call (`dvrSeconds` from the start body); later calls answer the same window */
  window(o: { ext: SegmentExt; init?: boolean }): SegmentWindow;
  /**
   * a finished segment, already stored as `dir/file`: adds it to the window (`pdt` defaults to now − duration, ruling 47),
   * rewrites the playlist, applies the cache cap; answers its local number (-1 after a stop)
   */
  segment(s: { file: string; duration: number; bytes: number; discontinuity?: boolean; pdt?: number }): Promise<number>;
  /** the stream's bitrate in bit/s (a variant's BANDWIDTH, an encoder's rate) */
  bitrate(bps: number | null): void;
  /** the input failed: the first failure of an outage records `input_lost`; answers the delay before the next attempt */
  lost(): number;
  /** the input works (again): ends an outage with `input_back` and its seconds, resets the backoff */
  back(): void;
  /** gives up: state `failed` with a fixed code in the log (the stream stays listed until it is stopped) */
  fail(code: string): void;
  /** waits `ms`; false when the stream was stopped meanwhile (the driver ends then) */
  sleep(ms: number): Promise<boolean>;
  /** a log line about this stream; prefixed with the channel id. Fixed texts only. */
  log(msg: string): void;
}
export type Driver = (ctx: DriverContext) => Promise<void>;
export type Drivers = Partial<Record<Mode, Driver>>;

export interface StreamsOptions {
  /** the cache directory (`/cache` in the container) */
  root: string;
  /** LIVETV_CACHE_MAX_GB in bytes */
  maxBytes: number;
  drivers: Drivers;
  store?: Store;
  log?: Log;
  now?: () => number;
}

interface Entry {
  view: StreamView;
  dvrSeconds: number;
  dir: string;
  window: SegmentWindow | null;
  /** files the DVR length dropped, removed after the add */
  dropped: string[];
  ac: AbortController;
  done: Promise<void>;
  lastTouch: number;
  timer: NodeJS.Timeout | null;
  outageAt: number | null;
  attempt: number;
  /** the playlist writes of this stream, one after the other */
  writing: Promise<void>;
}

const TYPES: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/mp4', mp4: 'video/mp4' };

export class Streams {
  private readonly byChannel = new Map<string, Entry>();
  private readonly byKey = new Map<string, Entry>();
  private readonly store: Store;
  private readonly log: Log;
  private readonly now: () => number;

  constructor(private readonly o: StreamsOptions) {
    this.store = o.store ?? fsStore;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  /** idempotent per channel: a running (or starting, reconnecting) stream answers its key; a failed one is replaced */
  start(b: StartBody): { streamKey: string; state: StreamView['state'] } {
    const running = this.byChannel.get(b.channelId);
    if (running && running.view.state !== 'failed') return { streamKey: running.view.streamKey, state: running.view.state };
    const driver = this.o.drivers[b.mode];
    if (!driver) throw new StreamsError('unsupported_mode');
    if (running) void this.stop(b.channelId, 'replaced');
    const streamKey = randomBytes(16).toString('hex');
    const now = this.now();
    const e: Entry = {
      view: { channelId: b.channelId, streamKey, mode: b.mode, since: now, state: 'starting', bitrate: null, errors: [], lastSegmentAt: null },
      dvrSeconds: b.dvrSeconds, dir: join(this.o.root, streamKey), window: null, dropped: [], ac: new AbortController(),
      done: Promise.resolve(), lastTouch: now, timer: null, outageAt: null, attempt: 0, writing: Promise.resolve(),
    };
    this.byChannel.set(b.channelId, e);
    this.byKey.set(streamKey, e);
    this.arm(e, IDLE_STOP_MS);
    const ctx = this.context(e, b);
    e.done = (async () => {
      await this.store.mkdir(e.dir);
      await driver(ctx);
    })().catch(() => { if (!e.ac.signal.aborted) ctx.fail('internal'); });
    this.log(`stream ${b.channelId} started (${b.mode})`);
    return { streamKey, state: 'starting' };
  }

  list(): StreamView[] {
    return [...this.byChannel.values()].map((e) => ({ ...e.view, errors: e.view.errors.map((x) => ({ ...x })) }));
  }

  /** stops the stream (its driver ends) and removes its files; a channel that is not running is fine */
  async stop(channelId: string, reason = 'stopped'): Promise<void> {
    const e = this.byChannel.get(channelId);
    if (!e) return;
    this.byChannel.delete(channelId);
    this.byKey.delete(e.view.streamKey);
    if (e.timer) clearTimeout(e.timer);
    e.ac.abort();
    await e.done;
    await e.writing;
    await this.store.removeDir(e.dir).catch(() => {});
    this.log(`stream ${channelId} stopped${reason === 'stopped' ? '' : ` (${reason})`}`);
  }

  /** every stream stops (shutdown, tests) */
  async close(): Promise<void> {
    await Promise.all([...this.byChannel.keys()].map((id) => this.stop(id, 'shutdown')));
  }

  /** a `/s/` fetch: the safety net starts again */
  touch(streamKey: string): void {
    const e = this.byKey.get(streamKey);
    if (e) e.lastTouch = this.now();
  }

  /** the file behind `/s/<streamKey>/<name>`, null when there is none (the route answers 404) */
  file(streamKey: string, name: string): { path: string; type: string } | null {
    const e = this.byKey.get(streamKey);
    const w = e?.window;
    if (!e || !w || w.length === 0) return null;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    let file: string | null;
    if (name === 'index.m3u8') file = name;
    else if (name === 'init.mp4') file = w.init ? name : null;
    else file = w.find(name);
    return file ? { path: join(e.dir, file), type: TYPES[ext]! } : null;
  }

  private arm(e: Entry, ms: number): void {
    e.timer = setTimeout(() => {
      e.timer = null;
      const idle = this.now() - e.lastTouch;
      if (idle >= IDLE_STOP_MS) void this.stop(e.view.channelId, 'idle');
      else this.arm(e, IDLE_STOP_MS - idle);
    }, ms);
    e.timer.unref?.();
  }

  private context(e: Entry, b: StartBody): DriverContext {
    const signal = e.ac.signal;
    const id = b.channelId;
    const live = () => !signal.aborted;
    return {
      channelId: id, dir: e.dir, input: b.input, mode: b.mode, encoder: b.encoder, maxBitrate: b.maxBitrate, signal, store: this.store,
      window: (o) => {
        e.window ??= new SegmentWindow({ dvrSeconds: e.dvrSeconds, ext: o.ext, init: o.init, onDrop: (f) => e.dropped.push(f) });
        return e.window;
      },
      segment: async (s) => {
        if (!live()) return -1;
        if (!e.window) throw new Error('window');
        const now = this.now();
        const seq = e.window.add({ file: s.file, duration: s.duration, bytes: s.bytes, discontinuity: s.discontinuity, pdt: s.pdt ?? now - s.duration * 1000 });
        e.view.lastSegmentAt = now;
        if (e.view.state === 'starting') e.view.state = 'running';
        const gone = e.dropped.splice(0);
        await Promise.all(gone.map((f) => this.store.remove(join(e.dir, f)).catch(() => {})));
        await this.writePlaylist(e);
        await this.cap();
        return seq;
      },
      bitrate: (bps) => { e.view.bitrate = bps; },
      lost: () => {
        if (e.outageAt === null && live()) {
          e.outageAt = this.now();
          this.event(e, { at: e.outageAt, code: 'input_lost' });
          this.log(`stream ${id} input lost`);
        }
        if (e.view.state !== 'failed') e.view.state = 'reconnecting';
        return backoffDelay(e.attempt++);
      },
      back: () => {
        e.attempt = 0;
        if (e.outageAt === null) return;
        const now = this.now();
        const seconds = Math.round((now - e.outageAt) / 1000);
        e.outageAt = null;
        this.event(e, { at: now, code: 'input_back', seconds });
        this.log(`stream ${id} input back after ${seconds} s`);
        if (e.view.state === 'reconnecting') e.view.state = e.view.lastSegmentAt === null ? 'starting' : 'running';
      },
      fail: (code) => {
        if (!live() || e.view.state === 'failed') return;
        e.view.state = 'failed';
        this.log(`stream ${id} failed (${/^[a-z_]{1,40}$/.test(code) ? code : 'internal'})`);
      },
      sleep: (ms) => new Promise<boolean>((resolve) => {
        if (!live()) { resolve(false); return; }
        const onAbort = () => { clearTimeout(t); resolve(false); };
        const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, Math.min(Math.max(0, ms), MAX_TIMER));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      log: (msg) => this.log(`stream ${id} ${msg}`),
    };
  }

  private event(e: Entry, ev: StreamView['errors'][number]): void {
    e.view.errors.push(ev);
    if (e.view.errors.length > MAX_EVENTS) e.view.errors.splice(0, e.view.errors.length - MAX_EVENTS);
  }

  private writePlaylist(e: Entry): Promise<void> {
    const w = e.window!;
    // chained: two writers (a new segment, another stream's eviction) never share the temporary file; each writes the latest text
    e.writing = e.writing.then(() => this.store.write(join(e.dir, 'index.m3u8'), w.playlist())).then(() => {}, () => {});
    return e.writing;
  }

  /** the cache cap over every stream's window (spec §3.3) */
  private async cap(): Promise<void> {
    const open = [...this.byChannel.values()].filter((x) => x.window);
    const out = evict(open.map((x) => ({ id: x.view.channelId, w: x.window! })), this.o.maxBytes);
    if (out.length === 0) return;
    const touched = new Set<Entry>();
    await Promise.all(out.map(({ id, file }) => {
      const x = this.byChannel.get(id)!;
      touched.add(x);
      return this.store.remove(join(x.dir, file)).catch(() => {});
    }));
    await Promise.all([...touched].map((x) => this.writePlaylist(x)));
  }
}
