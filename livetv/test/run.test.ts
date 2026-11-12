// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeRun, nodeFs } from '../src/run.js';

// The real process runner, with node standing in for ffmpeg (tests never need a real ffmpeg).
const run = makeRun({ ffmpeg: process.execPath, ffprobe: process.execPath });

describe('makeRun', () => {
  it('runs the program without a shell and collects stdout, stderr and the exit code', async () => {
    const r = await run('ffmpeg', ['-e', 'process.stdout.write("out;" + process.argv.slice(1).join(",")); process.stderr.write("err"); process.exit(3)', '$HOME', 'a b'], { timeoutMs: 5_000 });
    expect(r).toEqual({ code: 3, stdout: Buffer.from('out;$HOME,a b'), stderr: 'err' });
  });

  it('the child sees none of our environment (the secret stays here)', async () => {
    process.env.FF_RUN_TEST_SECRET = 'do-not-pass';
    try {
      const r = await run('ffprobe', ['-e', 'process.stdout.write(String(process.env.FF_RUN_TEST_SECRET) + ";" + String(process.env.INTERNAL_SECRET))'], { timeoutMs: 5_000 });
      expect(r.stdout.toString()).toBe('undefined;undefined');
    } finally {
      delete process.env.FF_RUN_TEST_SECRET;
    }
  });

  it('pipes stdin and streams stdout to onStdout instead of collecting it', async () => {
    const chunks: Buffer[] = [];
    async function* input() { yield Buffer.from('hello '); yield Buffer.from('world'); }
    const r = await run('ffmpeg', ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: input(), timeoutMs: 5_000, onStdout: (c) => chunks.push(c) });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('kills a program that runs past its time and reports a failure', async () => {
    const t = Date.now();
    const r = await run('ffmpeg', ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(Date.now() - t).toBeLessThan(4_000);
  });

  it('a missing program is exit code 127, not an exception', async () => {
    const missing = makeRun({ ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' });
    expect((await missing('ffprobe', [], { timeoutMs: 1_000 })).code).toBe(127);
  });

  it('keeps only the tail of a long stderr', async () => {
    const r = await run('ffmpeg', ['-e', 'process.stderr.write("a".repeat(100000) + "END")'], { timeoutMs: 5_000 });
    expect(r.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.stderr.endsWith('END')).toBe(true);
  });
});

describe('nodeFs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-livetv-fs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists, reads links and files, checks access', () => {
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'f'), 'text');
    symlinkSync('../../drivers/i915', join(dir, 'link'));
    expect(nodeFs.readdir(join(dir, 'd'))).toEqual(['f']);
    expect(nodeFs.readlink(join(dir, 'link'))).toBe('../../drivers/i915');
    expect(nodeFs.readFile(join(dir, 'd', 'f'))).toBe('text');
    expect(nodeFs.canAccess(join(dir, 'd', 'f'), constants.R_OK | constants.W_OK)).toBe(true);
    expect(nodeFs.canAccess(join(dir, 'missing'), constants.R_OK)).toBe(false);
    expect(() => nodeFs.readdir(join(dir, 'missing'))).toThrow();
  });
});
