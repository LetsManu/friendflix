// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Log } from './log.js';
import type { SegmentInfo, Streams } from './streams.js';

/**
 * The recorder (spec §15.2, plan Phase 3 Task 2): a recording taps the channel's shared live stream (the stream fetches the input once for
 * every viewer and recording) and copies each finished segment (and each new init file) from the DVR cache into `/recordings/<dir>/`,
 * where it keeps its own `EVENT` playlist (`#EXT-X-PROGRAM-DATE-TIME` per segment, `#EXT-X-MAP` per init, `#EXT-X-ENDLIST` at the end).
 * The backend starts the stream first (budget kind `record`) and then `POST /v1/recordings`; the recorder keeps the stream alive
 * (`keepAlive`, like a `/s/` fetch). Stream outages (the stream stopped, or no segment for 3 target durations) become gaps; the next
 * segment carries a discontinuity. A restart of livetv (or the backend) resumes the same folder: numbering continues after the last
 * segment, a discontinuity and the outage as a gap. ENOSPC ends a recording with `storage_full` and a closed playlist.
 *
 * Logs name the recording id and fixed codes only: never a path, a stream key, a channel's input or a title (livetv never knows one).
 */
export const FREE_MIN_BYTES = 2 * 1024 ** 3;
export const FINISHED_KEEP_MS = 3_600_000;
/** a segment missing for this many target durations is an outage */
export const GAP_TARGETS = 3;
export const RECORDER_TICK_MS = 1_000;
export const DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYLIST = 'index.m3u8';
const DEFAULT_TARGET_S = 6;

export type RecError = 'storage_full' | 'write_failed' | 'stream_gone';
export interface Gap { from: number; to: number }
/** an item of `GET /v1/recordings` */
export interface RecordingView {
  id: string;
  channelId: string;
  state: 'recording' | 'done' | 'failed';
  segments: 'ts' | 'fmp4' | null;
  bytes: number;
  durationS: number;
  gaps: Gap[];
  error: RecError | null;
  since: number;
}
export interface StartRecording { id: string; channelId: string; dir: string; endAt: number }
export type StartResult = { ok: true; state: 'recording'; segments: 'ts' | 'fmp4' | null } | { ok: false; status: 409 | 507; error: 'stream_not_running' | 'storage_full' | 'invalid_dir' };

/** the file operations of the recorder (tests wrap them to fail with ENOSPC) */
export interface RecFs {
  /** answers the size; refuses an existing destination (a planted link included) */
  copy(src: string, dest: string): Promise<number>;
  /** the whole text under a temporary name, opened without following a link, renamed into place */
  writeAtomic(path: string, text: string): Promise<void>;
  /** null when there is no such file */
  read(path: string): Promise<string | null>;
  size(path: string): Promise<number>;
  /** free bytes of the file system holding `dir`; null = unknown */
  free(dir: string): Promise<number | null>;
}

const code = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

export const nodeRecFs: RecFs = {
  async copy(src, dest) {
    try {
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    } catch (e) {
      // a file of a crash between its copy and the playlist write: a plain file is replaced, anything else (a link) is refused
      if (code(e) !== 'EEXIST' || !(await lstat(dest)).isFile()) throw e;
      await rm(dest);
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    }
    return (await lstat(dest)).size;
  },
  async writeAtomic(path, text) {
    const tmp = `${path}.tmp`;
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  },
  async read(path) {
    try {
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return await fh.readFile('utf8'); } finally { await fh.close(); }
    } catch (e) {
      if (code(e) === 'ENOENT') return null;
      throw e;
    }
  },
  size: async (path) => (await lstat(path)).size,
  async free(dir) {
    try {
      const s = await statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  },
};

interface Entry { seq: number; ext: 'ts' | 'm4s'; duration: number; pdt: number; disc: boolean; init: number | null }
interface Rec {
  id: string;
  channelId: string;
  dir: string;
  path: string;
  endAt: number;
  state: RecordingView['state'];
  error: RecError | null;
  since: number;
  finishedAt: number | null;
  entries: Entry[];
  nextSeq: number;
  /** the stream's init file (its path, unique per stream) -> the local init number */
  inits: Map<string, number>;
  nextInit: number;
  bytes: number;
  gaps: Gap[];
  /** when the last segment arrived (the gap watchdog) */
  lastArrival: number;
  /** an outage is open since (epoch ms of the last segment's end) */
  gapFrom: number | null;
  /** the next segment starts with a discontinuity (resume, outage) */
  pendingDisc: boolean;
  /** the playlist carries its ENDLIST */
  closed: boolean;
  queue: Promise<void>;
}

export interface RecorderOptions {
  /** `/recordings` */
  root: string;
  streams: Pick<Streams, 'view' | 'keepAlive'>;
  fs?: RecFs;
  log?: Log;
  now?: () => number;
  /** how often `tick` runs by itself; 0 = never (tests call it) */
  tickMs?: number;
}

const segName = (e: Pick<Entry, 'seq' | 'ext'>) => `${e.seq}.${e.ext}`;
const initFile = (n: number) => `init-${n}.mp4`;
const targetOf = (entries: readonly Entry[]) => entries.reduce((m, e) => Math.max(m, Math.ceil(e.duration - 1e-6)), 1);

/** the EVENT playlist of a recording; ENDLIST once it is finished */
export function recordingPlaylist(entries: readonly Entry[], ended: boolean): string {
  const fmp4 = entries.some((e) => e.ext === 'm4s');
  const out = ['#EXTM3U', `#EXT-X-VERSION:${fmp4 ? 7 : 6}`, `#EXT-X-TARGETDURATION:${entries.length ? targetOf(entries) : DEFAULT_TARGET_S}`, '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MEDIA-SEQUENCE:0'];
  let mapped: number | null = null;
  entries.forEach((e, i) => {
    if (e.disc && i > 0) out.push('#EXT-X-DISCONTINUITY');
    if (e.init !== null && e.init !== mapped) out.push(`#EXT-X-MAP:URI="${initFile(e.init)}"`);
    mapped = e.init;
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(e.pdt).toISOString()}`, `#EXTINF:${e.duration.toFixed(3)},`, segName(e));
  });
  if (ended) out.push('#EXT-X-ENDLIST');
  return `${out.join('\n')}\n`;
}

/** a playlist this recorder wrote, read back for a resume (anything it would not write is ignored) */
export function parseRecordingPlaylist(text: string): Entry[] {
  const out: Entry[] = [];
  let disc = false;
  let init: number | null = null;
  let pdt: number | null = null;
  let duration: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (line === '#EXT-X-DISCONTINUITY') disc = true;
    else if ((m = /^#EXT-X-MAP:URI="init-([0-9]{1,4})\.mp4"$/.exec(line))) init = Number(m[1]);
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if ((m = /^#EXTINF:([0-9]{1,6}(?:\.[0-9]{1,6})?),/.exec(line))) duration = Number(m[1]);
    else if ((m = /^([0-9]{1,10})\.(ts|m4s)$/.exec(line)) && duration !== null && pdt !== null && Number.isFinite(pdt)) {
      out.push({ seq: Number(m[1]), ext: m[2] as Entry['ext'], duration, pdt, disc: disc && out.length > 0, init: m[2] === 'm4s' ? init : null });
      disc = false;
      pdt = null;
      duration = null;
    }
  }
  return out;
}

const writeCode = (e: unknown): RecError => (code(e) === 'ENOSPC' || code(e) === 'EDQUOT' ? 'storage_full' : 'write_failed');

export class Recorder {
  private readonly recs = new Map<string, Rec>();
  private readonly starting = new Map<string, Promise<StartResult>>();
  private readonly fs: RecFs;
  private readonly log: Log;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: RecorderOptions) {
    this.fs = o.fs ?? nodeRecFs;
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    const every = o.tickMs ?? RECORDER_TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => this.tick(), every);
      this.timer.unref?.();
    }
  }

  /** free bytes of the recordings volume (null = unknown) */
  free(): Promise<number | null> {
    return this.fs.free(this.o.root);
  }

  /** `POST /v1/recordings`: idempotent per id; a folder with a playlist is resumed */
  start(b: StartRecording): Promise<StartResult> {
    const cur = this.recs.get(b.id);
    if (cur?.state === 'recording') return Promise.resolve({ ok: true, state: 'recording', segments: this.segmentsOf(cur) });
    const running = this.starting.get(b.id);
    if (running) return running;
    const p = this.begin(b).finally(() => this.starting.delete(b.id));
    this.starting.set(b.id, p);
    return p;
  }

  private segmentsOf(r: Rec): 'ts' | 'fmp4' | null {
    const v = this.o.streams.view(r.channelId);
    if (v?.segments) return v.segments;
    const last = r.entries.at(-1);
    return last ? (last.ext === 'm4s' ? 'fmp4' : 'ts') : null;
  }

  private async begin(b: StartRecording): Promise<StartResult> {
    const stream = this.o.streams.view(b.channelId);
    if (!stream || stream.state === 'failed') return { ok: false, status: 409, error: 'stream_not_running' };
    const free = await this.fs.free(this.o.root);
    if (free !== null && free < FREE_MIN_BYTES) return { ok: false, status: 507, error: 'storage_full' };
    // another recording already writes this folder: refused (never two writers in one folder)
    for (const r of this.recs.values()) if (r.dir === b.dir && r.id !== b.id && r.state === 'recording') return { ok: false, status: 409, error: 'invalid_dir' };
    const path = join(this.o.root, b.dir);
    if (!(await this.ensureDir(b.dir))) return { ok: false, status: 409, error: 'invalid_dir' };
    const now = this.now();
    let entries: Entry[] = [];
    let bytes = 0;
    try {
      const text = await this.fs.read(join(path, PLAYLIST));
      if (text !== null) {
        entries = parseRecordingPlaylist(text);
        for (const e of entries) bytes += await this.fs.size(join(path, segName(e))).catch(() => 0);
        for (const n of new Set(entries.flatMap((e) => (e.init === null ? [] : [e.init])))) bytes += await this.fs.size(join(path, initFile(n))).catch(() => 0);
      }
    } catch {
      return { ok: false, status: 409, error: 'invalid_dir' };
    }
    const last = entries.at(-1);
    const prev = this.recs.get(b.id);
    const r: Rec = {
      id: b.id, channelId: b.channelId, dir: b.dir, path, endAt: b.endAt, state: 'recording', error: null, since: now, finishedAt: null, entries,
      nextSeq: last ? last.seq + 1 : 0, inits: new Map(), nextInit: entries.reduce((m, e) => Math.max(m, (e.init ?? -1) + 1), 0), bytes,
      gaps: prev?.dir === b.dir ? [...prev.gaps] : [], lastArrival: now, gapFrom: last ? last.pdt + last.duration * 1000 : null, pendingDisc: last !== undefined,
      closed: false, queue: Promise.resolve(),
    };
    this.recs.set(b.id, r);
    this.o.streams.keepAlive(b.channelId);
    this.log(`recording ${b.id} ${last ? 'resumed' : 'started'}`);
    return { ok: true, state: 'recording', segments: this.segmentsOf(r) };
  }

  /** the recording's folder below the root: created when missing; an existing one must be a real folder whose real path stays below the root */
  private async ensureDir(dir: string): Promise<boolean> {
    if (!DIR_RE.test(dir)) return false;
    const path = join(this.o.root, dir);
    try {
      const st = await lstat(path).catch((e: unknown) => (code(e) === 'ENOENT' ? null : Promise.reject(e)));
      if (st === null) await mkdir(path, { mode: 0o755 });
      else if (!st.isDirectory()) return false;
      return (await realpath(path)) === join(await realpath(this.o.root), dir);
    } catch {
      return false;
    }
  }

  /** `PATCH /v1/recordings/:id`: a new end (a running recording only) */
  setEnd(id: string, endAt: number): boolean {
    const r = this.recs.get(id);
    if (!r || r.state !== 'recording') return false;
    r.endAt = endAt;
    return true;
  }

  /** `DELETE /v1/recordings/:id`: stops now (ENDLIST); false = unknown */
  async stop(id: string): Promise<boolean> {
    const r = this.recs.get(id);
    if (!r) return false;
    if (r.state === 'recording') await this.finish(r, this.now());
    else await r.queue;
    // a failure whose closing write failed (a full disk) is closed now, if it can be
    if (!r.closed && r.entries.length) await this.writeEnd(r).catch(() => undefined);
    return true;
  }

  private async writeEnd(r: Rec): Promise<void> {
    await this.fs.writeAtomic(join(r.path, PLAYLIST), recordingPlaylist(r.entries, true));
    r.closed = true;
  }

  list(): RecordingView[] {
    return [...this.recs.values()].map((r) => ({
      id: r.id, channelId: r.channelId, state: r.state, segments: r.entries.length ? (r.entries.at(-1)!.ext === 'm4s' ? 'fmp4' : 'ts') : null,
      bytes: r.bytes, durationS: Math.round(r.entries.reduce((n, e) => n + e.duration, 0)), gaps: r.gaps.map((g) => ({ ...g })), error: r.error, since: r.since,
    }));
  }

  /**
   * `POST /v1/recordings/:id/delete`: stops the recorder of this id (or of this folder), then removes `/recordings/<dir>`. The folder must
   * be a real directory (never a link) whose real path is `<root>/<dir>`; `not_found` when it is gone already.
   */
  async remove(id: string, dir: string): Promise<'ok' | 'not_found' | 'not_a_folder'> {
    if (!DIR_RE.test(dir)) return 'not_a_folder';
    for (const r of [...this.recs.values()]) {
      if (r.id !== id && r.dir !== dir) continue;
      if (r.state === 'recording') await this.finish(r, this.now());
      await r.queue;
      this.recs.delete(r.id);
    }
    const path = join(this.o.root, dir);
    const st = await lstat(path).catch(() => null);
    if (!st) return 'not_found';
    if (st.isSymbolicLink() || !st.isDirectory()) return 'not_a_folder';
    if ((await realpath(path)) !== join(await realpath(this.o.root), dir)) return 'not_a_folder';
    await rm(path, { recursive: true, force: true });
    this.log(`recording ${id} files removed`);
    return 'ok';
  }

  /** the streams' onSegment hook: every running recording of the channel copies the segment */
  segment(channelId: string, info: SegmentInfo): void {
    for (const r of this.recs.values()) {
      if (r.channelId !== channelId || r.state !== 'recording') continue;
      r.queue = r.queue.then(() => this.add(r, info));
    }
  }

  /** the streams' onStop hook: an outage starts for every running recording of the channel */
  streamStopped(channelId: string): void {
    for (const r of this.recs.values()) if (r.channelId === channelId && r.state === 'recording') this.openGap(r);
  }

  /** ends recordings at their end, opens gaps after 3 target durations without a segment, keeps the streams alive, forgets old entries */
  tick(): void {
    const now = this.now();
    for (const r of [...this.recs.values()]) {
      if (r.state !== 'recording') {
        if (r.finishedAt !== null && now - r.finishedAt >= FINISHED_KEEP_MS) this.recs.delete(r.id);
        continue;
      }
      if (now >= r.endAt) { void this.finish(r, r.endAt); continue; }
      this.o.streams.keepAlive(r.channelId);
      if (r.entries.length && r.gapFrom === null && now - r.lastArrival >= GAP_TARGETS * targetOf(r.entries) * 1000) this.openGap(r);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private openGap(r: Rec): void {
    if (r.gapFrom !== null) return;
    const last = r.entries.at(-1);
    r.gapFrom = last ? last.pdt + last.duration * 1000 : this.now();
    r.pendingDisc = true;
  }

  private async add(r: Rec, info: SegmentInfo): Promise<void> {
    if (r.state !== 'recording' || info.pdt >= r.endAt) return;
    const ext: Entry['ext'] = info.file.endsWith('.m4s') ? 'm4s' : 'ts';
    try {
      let init: number | null = null;
      if (info.init !== null && info.initPath) {
        init = r.inits.get(info.initPath) ?? null;
        if (init === null) {
          init = r.nextInit;
          r.bytes += await this.fs.copy(info.initPath, join(r.path, initFile(init)));
          r.nextInit++;
          r.inits.set(info.initPath, init);
        }
      }
      const seq = r.nextSeq;
      let size: number;
      try {
        size = await this.fs.copy(info.path, join(r.path, segName({ seq, ext })));
      } catch (e) {
        // the cache dropped the segment before it was copied (a long queue): an outage, not a write error, while the folder is there
        if (code(e) === 'ENOENT' && (await lstat(r.path).then((s) => s.isDirectory(), () => false))) { this.openGap(r); return; }
        throw e;
      }
      r.nextSeq++;
      const prev = r.entries.at(-1);
      const disc = info.discontinuity || r.pendingDisc || (prev !== undefined && prev.init !== init);
      if (r.gapFrom !== null) {
        r.gaps.push({ from: r.gapFrom, to: Math.max(r.gapFrom, info.pdt) });
        r.gapFrom = null;
      }
      r.entries.push({ seq, ext, duration: info.duration, pdt: info.pdt, disc, init });
      r.bytes += size;
      r.lastArrival = this.now();
      r.pendingDisc = false;
      await this.fs.writeAtomic(join(r.path, PLAYLIST), recordingPlaylist(r.entries, false));
      this.o.streams.keepAlive(r.channelId);
    } catch (e) {
      await this.fail(r, writeCode(e));
    }
  }

  private finish(r: Rec, at: number): Promise<void> {
    r.queue = r.queue.then(async () => {
      if (r.state !== 'recording') return;
      if (r.gapFrom !== null) {
        r.gaps.push({ from: r.gapFrom, to: Math.max(r.gapFrom, at) });
        r.gapFrom = null;
      }
      if (!r.entries.length) {
        await this.fail(r, 'stream_gone');
        return;
      }
      r.state = 'done';
      r.finishedAt = this.now();
      try {
        await this.writeEnd(r);
      } catch (e) {
        r.state = 'failed';
        r.error = writeCode(e);
      }
      this.log(`recording ${r.id} ${r.state === 'done' ? 'done' : `failed (${r.error})`}`);
    });
    return r.queue;
  }

  /** ends the recording with a fixed code; the playlist is closed with what it has (best effort: the disk may be full) */
  private async fail(r: Rec, err: RecError): Promise<void> {
    if (r.state !== 'recording') return;
    r.state = 'failed';
    r.error = err;
    r.finishedAt = this.now();
    if (r.entries.length) await this.writeEnd(r).catch(() => undefined);
    this.log(`recording ${r.id} failed (${err})`);
  }
}
