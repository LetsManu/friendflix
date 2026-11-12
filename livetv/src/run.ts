// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

/**
 * The two seams to the host that livetv's pure code takes as parameters, so tests never need a real ffmpeg or GPU: `Run` (the
 * only programs livetv starts) and `FsLike` (the few sysfs / devfs reads of the GPU check). Task 14 adds the optional `stdin` and
 * `onStdout` options; Task 28 passes stderr through `scrubLine`. Until then stderr is kept, never logged.
 */
export type Cmd = 'ffmpeg' | 'ffprobe';
/**
 * code: the program's exit code; -1 = killed at `timeoutMs` (never an exit code of ffmpeg, so a caller can answer `timeout`);
 * 127 = it could not be started; 1 = killed by another signal. `truncated`: stdout went past 16 MB, the rest was dropped.
 */
export type RunResult = { code: number; stdout: Buffer; stderr: string; truncated?: true };
/**
 * `stdin`: piped into the child chunk by chunk (with backpressure); its end, or its failure, closes the child's stdin. When the
 * child exits or closes its stdin first, the input is no longer pulled (its `return()` is called). Without `stdin` the child's
 * stdin is not a pipe (it reads EOF at once).
 * `onStdout`: sees each stdout chunk as it arrives (a throwing listener is ignored); stdout is still collected as usual.
 */
export type RunOptions = { timeoutMs: number; stdin?: AsyncIterable<Uint8Array>; onStdout?(chunk: Buffer): void };
export type Run = (cmd: Cmd, args: string[], o: RunOptions) => Promise<RunResult>;
/** what gpuInfo (system.ts) reads; tests pass a fake */
export type FsLike = Pick<typeof import('node:fs'), 'readdirSync' | 'readFileSync' | 'accessSync' | 'readlinkSync'>;

/** jellyfin-ffmpeg's install directory (the Debian package of the Jellyfin repository) */
export const FFMPEG_DIR = '/usr/lib/jellyfin-ffmpeg';
export const TIMEOUT_CODE = -1;
const STDOUT_MAX = 16 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;
/** what a child sees of the environment: never livetv's own (it holds INTERNAL_SECRET) */
const CHILD_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' };
const BINS: Record<Cmd, string> = { ffmpeg: `${FFMPEG_DIR}/ffmpeg`, ffprobe: `${FFMPEG_DIR}/ffprobe` };

/**
 * The runner: spawn without a shell, the child gets CHILD_ENV only, stdin closed unless `o.stdin` is given; stdout collected (up to 16 MB), stderr
 * keeps its last 64 KB; at `timeoutMs` the process is killed (SIGKILL) and the result has code -1. `bins` only replaces the
 * program paths (tests run node in their place).
 */
export function createRun(bins: Partial<Record<Cmd, string>> = {}): Run {
  return (cmd, args, o) => new Promise((resolve) => {
    const child = spawn(bins[cmd] ?? BINS[cmd], args, { env: CHILD_ENV, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let truncated = false;
    let err = '';
    let timedOut = false;
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? TIMEOUT_CODE : code, stdout: Buffer.concat(out), stderr: err, ...(truncated ? { truncated: true as const } : {}) });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs);
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
    child.stderr!.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-STDERR_TAIL); });
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
