// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { scrubLine } from './ffmpeg.js';
import type { Log } from './log.js';

/**
 * The two seams to the host that livetv's pure code takes as parameters, so tests never need a real ffmpeg or GPU: `Run` (the
 * only programs livetv starts) and `FsLike` (the few sysfs / devfs reads of the GPU check). Task 14 added the optional `stdin` and
 * `onStdout` options; Task 28 adds `signal` (a stream stop kills its ffmpeg) and `stderrLog`: stderr lines are logged through
 * `scrubLine`, with the run's data arguments, absolute paths and any stream key replaced, named by the channel id only. Without
 * `stderrLog` stderr is kept, never logged.
 */
export type Cmd = 'ffmpeg' | 'ffprobe';
/**
 * code: the program's exit code; -1 = killed at `timeoutMs` (never an exit code of ffmpeg, so a caller can answer `timeout`);
 * 127 = it could not be started; 1 = killed by another signal (or `signal` was already aborted). `truncated`: stdout went past
 * 16 MB, the rest was dropped.
 */
export type RunResult = { code: number; stdout: Buffer; stderr: string; truncated?: true };
/**
 * `stdin`: piped into the child chunk by chunk (with backpressure); its end, or its failure, closes the child's stdin. When the
 * child exits or closes its stdin first, the input is no longer pulled (its `return()` is called). Without `stdin` the child's
 * stdin is not a pipe (it reads EOF at once).
 * `onStdout`: sees each stdout chunk as it arrives (a throwing listener is ignored); stdout is still collected as usual.
 * `signal`: its abort kills the child (SIGKILL).
 * `stderrLog`: each stderr line, scrubbed, goes to `log` as `stream <channelId> ffmpeg: <line>` (at most 50 per run).
 */
export type RunOptions = {
  timeoutMs: number;
  stdin?: AsyncIterable<Uint8Array>;
  onStdout?(chunk: Buffer): void;
  signal?: AbortSignal;
  stderrLog?: { channelId: string; log: Log };
};
export type Run = (cmd: Cmd, args: string[], o: RunOptions) => Promise<RunResult>;
/** what gpuInfo (system.ts) reads; tests pass a fake */
export type FsLike = Pick<typeof import('node:fs'), 'readdirSync' | 'readFileSync' | 'accessSync' | 'readlinkSync'>;

/** jellyfin-ffmpeg's install directory (the Debian package of the Jellyfin repository) */
export const FFMPEG_DIR = '/usr/lib/jellyfin-ffmpeg';
export const TIMEOUT_CODE = -1;
export const STDERR_LOG_MAX_LINES = 50;
const STDOUT_MAX = 16 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;
/** what a child sees of the environment: never livetv's own (it holds INTERNAL_SECRET) */
const CHILD_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' };
const BINS: Record<Cmd, string> = { ffmpeg: `${FFMPEG_DIR}/ffmpeg`, ffprobe: `${FFMPEG_DIR}/ffprobe` };

/**
 * One stderr line as it may be logged (R4: no raw paths, stream keys, URLs or ffmpeg arguments): the run's own data arguments
 * (input URLs, paths, filter values: at least 8 characters with `/`, `:` or `=`) become `<arg>`, then `scrubLine`, then every
 * absolute path (a segment ffmpeg expanded from `<dir>/%d.ts`, a device node) `<path>`, then any 32-hex run `<key>`.
 */
export function stderrLine(line: string, args: readonly string[]): string {
  let s = line;
  const data = args.filter((a) => a.length >= 8 && /[/:=]/.test(a)).sort((a, b) => b.length - a.length);
  for (const a of data) s = s.split(a).join('<arg>');
  return scrubLine(s)
    .replace(/(^|[\s'"([=,:])\/[^\s'"]*/g, '$1<path>')
    .replace(/[0-9a-f]{32}/gi, '<key>');
}

/**
 * The runner: spawn without a shell, the child gets CHILD_ENV only, stdin closed unless `o.stdin` is given; stdout collected (up to 16 MB), stderr
 * keeps its last 64 KB; at `timeoutMs` the process is killed (SIGKILL) and the result has code -1. `bins` only replaces the
 * program paths (tests run node in their place).
 */
export function createRun(bins: Partial<Record<Cmd, string>> = {}): Run {
  return (cmd, args, o) => new Promise((resolve) => {
    if (o.signal?.aborted) { resolve({ code: 1, stdout: Buffer.alloc(0), stderr: '' }); return; }
    const child = spawn(bins[cmd] ?? BINS[cmd], args, { env: CHILD_ENV, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let truncated = false;
    let err = '';
    let errLine = '';
    let logged = 0;
    let timedOut = false;
    let done = false;
    const logLine = (raw: string) => {
      const sink = o.stderrLog;
      const line = raw.trim();
      if (!sink || line === '' || logged > STDERR_LOG_MAX_LINES) return;
      logged++;
      sink.log(logged > STDERR_LOG_MAX_LINES
        ? `stream ${sink.channelId} ffmpeg: further error lines dropped`
        : `stream ${sink.channelId} ffmpeg: ${stderrLine(line, args)}`);
    };
    const onAbort = () => { child.kill('SIGKILL'); };
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (errLine) { logLine(errLine); errLine = ''; }
      resolve({ code: timedOut ? TIMEOUT_CODE : code, stdout: Buffer.concat(out), stderr: err, ...(truncated ? { truncated: true as const } : {}) });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    // stdout and stderr are always pipes here
    child.stdout!.on('data', (c: Buffer) => {
      if (o.onStdout) try { o.onStdout(c); } catch { /* a listener's bug never breaks the run */ }
      const room = STDOUT_MAX - outLen;
      if (c.length > room) truncated = true;
      if (room <= 0) return;
      const part = c.length > room ? c.subarray(0, room) : c;
      out.push(part);
      outLen += part.length;
    });
    child.stderr!.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      err = (err + s).slice(-STDERR_TAIL);
      if (!o.stderrLog) return;
      errLine += s;
      const lines = errLine.split(/\r?\n|\r/);
      errLine = lines.pop()!;
      for (const l of lines) logLine(l);
      if (errLine.length > STDERR_TAIL) { logLine(errLine); errLine = ''; }
    });
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    if (o.stdin && child.stdin) void pump(o.stdin, child.stdin);
  });
}

/**
 * Feed `input` into a child's stdin. Stops pulling as soon as the pipe is gone (the child exited or closed it: EPIPE and other
 * errors are swallowed here, they never reach the process), then ends stdin; an input that fails also just ends stdin.
 */
async function pump(input: AsyncIterable<Uint8Array>, stdin: Writable): Promise<void> {
  let gone = false;
  let wake = () => {};
  const stop = () => { gone = true; wake(); };
  stdin.on('error', stop);
  stdin.once('close', stop);
  const it = input[Symbol.asyncIterator]();
  try {
    while (!gone) {
      const r = await it.next();
      if (r.done) break;
      if (gone) break;
      if (!stdin.write(r.value)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          stdin.once('drain', resolve);
          if (gone) resolve();
        });
        stdin.off('drain', wake);
        wake = () => {};
      }
    }
  } catch {
    // the input failed: the child sees EOF
  } finally {
    if (!stdin.destroyed) stdin.end();
    try { await it.return?.(); } catch { /* already finished or failed */ }
  }
}
