// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { accessSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * The two seams to the host that livetv's pure code takes as parameters, so tests never need a real ffmpeg or GPU: `Run` (the
 * only programs livetv starts) and `FsLike` (the few sysfs / devfs reads of the GPU check). Task 14 extends the runner (stdin
 * from guarded fetches, progress lines); Task 28 passes stderr through `scrubLine`. Until then stderr is kept, never logged.
 */
export type Cmd = 'ffmpeg' | 'ffprobe';
export type Run = (cmd: Cmd, args: string[], o: { stdin?: AsyncIterable<Uint8Array>; timeoutMs: number; onStdout?(chunk: Buffer): void }) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

/** jellyfin-ffmpeg's install directory (the Debian package of the Jellyfin repository) */
export const FFMPEG_DIR = '/usr/lib/jellyfin-ffmpeg';
const STDERR_TAIL = 64 * 1024;
const STDOUT_MAX = 16 * 1024 * 1024;
/** what a child sees of the environment: never livetv's own (it holds INTERNAL_SECRET) */
const CHILD_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' };

/**
 * spawn without a shell; the child gets CHILD_ENV only. Exit code: the program's, 127 when it cannot be started, 1 when it was
 * killed (timeout: SIGKILL). stdout is collected (up to 16 MB) unless `onStdout` takes it; stderr keeps its last 64 KB.
 */
export function makeRun(bins: Record<Cmd, string> = { ffmpeg: `${FFMPEG_DIR}/ffmpeg`, ffprobe: `${FFMPEG_DIR}/ffprobe` }): Run {
  return (cmd, args, o) => new Promise((resolve) => {
    const child = spawn(bins[cmd], args, { env: CHILD_ENV, stdio: [o.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs);
    child.stdout!.on('data', (c: Buffer) => {
      if (o.onStdout) return o.onStdout(c);
      if (outLen + c.length <= STDOUT_MAX) { out.push(c); outLen += c.length; }
    });
    child.stderr!.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-STDERR_TAIL); });
    if (o.stdin && child.stdin) {
      child.stdin.on('error', () => { /* the program stopped reading (EPIPE): its exit code tells */ });
      const src = Readable.from(o.stdin);
      src.on('error', () => child.stdin!.destroy());
      src.pipe(child.stdin);
    }
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

/** The reads gpuInfo needs (system.ts); each throws when the path is missing, canAccess answers false instead. */
export interface FsLike {
  readdir(path: string): string[];
  readlink(path: string): string;
  readFile(path: string): string;
  /** access(2) with the given mode (fs.constants.R_OK | W_OK ...) */
  canAccess(path: string, mode: number): boolean;
}

export const nodeFs: FsLike = {
  readdir: (p) => readdirSync(p),
  readlink: (p) => readlinkSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
  canAccess: (p, mode) => { try { accessSync(p, mode); return true; } catch { return false; } },
};
