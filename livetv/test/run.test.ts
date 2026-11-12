// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TIMEOUT_CODE, createRun } from '../src/run.js';

// The real process runner, with node standing in for ffmpeg / ffprobe (tests never need a real ffmpeg).
const run = createRun({ ffmpeg: process.execPath, ffprobe: process.execPath });

describe('createRun', () => {
  it('no shell: every argument arrives literally; stdout and stderr are collected with the exit code', async () => {
    const r = await run('ffmpeg', ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("err"); process.exit(3)', '; echo x', '$HOME', 'a b', '`id`'], { timeoutMs: 5_000 });
    expect(r).toEqual({ code: 3, stdout: Buffer.from(JSON.stringify(['; echo x', '$HOME', 'a b', '`id`'])), stderr: 'err' });
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

  it('a process over timeoutMs is killed: code -1, which no exit code of ffmpeg can be', async () => {
    const t = Date.now();
    const r = await run('ffmpeg', ['-e', 'process.stdout.write("started"); setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    expect(TIMEOUT_CODE).toBe(-1);
    expect(r).toEqual({ code: -1, stdout: Buffer.from('started'), stderr: '' });
    expect(Date.now() - t).toBeLessThan(4_000);
  });

  it('an error exit 1 stays 1 (told apart from a timeout)', async () => {
    expect((await run('ffmpeg', ['-e', 'process.exit(1)'], { timeoutMs: 5_000 })).code).toBe(1);
  });

  it('a missing program is exit code 127, not an exception', async () => {
    const missing = createRun({ ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' });
    expect(await missing('ffprobe', [], { timeoutMs: 1_000 })).toEqual({ code: 127, stdout: Buffer.alloc(0), stderr: '' });
  });

  it('the default programs are jellyfin-ffmpeg (absent here: 127)', async () => {
    expect((await createRun()('ffmpeg', ['-version'], { timeoutMs: 1_000 })).code).toBe(127);
  });

  it('keeps only the tail of a long stderr', async () => {
    const r = await run('ffmpeg', ['-e', 'process.stderr.write("a".repeat(100000) + "END")'], { timeoutMs: 5_000 });
    expect(r.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.stderr.endsWith('END')).toBe(true);
  });

  it('stdout over 16 MB is cut there and flagged truncated', async () => {
    const r = await run('ffmpeg', ['-e', 'const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 17; i++) process.stdout.write(b)'], { timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(16 * 1024 * 1024);
    expect(r.truncated).toBe(true);
    const small = await run('ffmpeg', ['-e', 'process.stdout.write("x")'], { timeoutMs: 5_000 });
    expect(small.truncated).toBeUndefined();
  });
});
