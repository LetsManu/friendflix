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

  it('stdin is piped and closed: every chunk reaches the child, its end is the child\'s EOF', async () => {
    async function* input(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('Nordlicht ');
      yield new Uint8Array(Buffer.from('TV'));
      yield Buffer.alloc(200_000, 0x41);
    }
    const r = await run('ffprobe', ['-e', 'let n = 0, head = ""; process.stdin.on("data", (c) => { if (n < 12) head += c.toString().slice(0, 12 - n); n += c.length; }); process.stdin.on("end", () => process.stdout.write(head + ":" + n))'], { timeoutMs: 5_000, stdin: input() });
    expect(r).toEqual({ code: 0, stdout: Buffer.from('Nordlicht TV:200012'), stderr: '' });
  });

  it('without stdin the child reads EOF at once (stdin is not piped)', async () => {
    const r = await run('ffprobe', ['-e', 'let n = 0; process.stdin.on("data", (c) => { n += c.length; }); process.stdin.on("end", () => process.stdout.write("eof:" + n))'], { timeoutMs: 5_000 });
    expect(r.stdout.toString()).toBe('eof:0');
  });

  it('onStdout sees each chunk as it arrives; stdout is still collected', async () => {
    const seen: string[] = [];
    const r = await run('ffmpeg', ['-e', 'process.stdout.write("a"); setTimeout(() => process.stdout.write("b"), 100)'], { timeoutMs: 5_000, onStdout: (c) => seen.push(c.toString()) });
    expect(seen).toEqual(['a', 'b']);
    expect(r.stdout.toString()).toBe('ab');
    const throwing = await run('ffmpeg', ['-e', 'process.stdout.write("x")'], { timeoutMs: 5_000, onStdout: () => { throw new Error('listener bug'); } });
    expect(throwing).toEqual({ code: 0, stdout: Buffer.from('x'), stderr: '' });
  });

  it('a child that exits early (or closes stdin) does not crash livetv and stops pulling the input', async () => {
    let pulled = 0;
    let closed = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) { pulled++; yield Buffer.alloc(64 * 1024, 0x47); }
      } finally { closed++; }
    }
    const r = await run('ffmpeg', ['-e', 'process.stdin.once("data", () => process.exit(4))'], { timeoutMs: 5_000, stdin: endless() });
    expect(r.code).toBe(4);
    await new Promise((res) => setTimeout(res, 100));
    expect(closed).toBe(1);
    const after = pulled;
    await new Promise((res) => setTimeout(res, 100));
    expect(pulled).toBe(after);
    const shut = await run('ffmpeg', ['-e', 'process.stdin.destroy(); setTimeout(() => process.stdout.write("done"), 300)'], { timeoutMs: 5_000, stdin: endless() });
    expect(shut).toEqual({ code: 0, stdout: Buffer.from('done'), stderr: '' });
    await new Promise((res) => setTimeout(res, 100));
    expect(closed).toBe(2);
  });

  it('a failing input ends stdin (the child sees EOF); a missing program with stdin is still 127', async () => {
    async function* failing(): AsyncGenerator<Uint8Array> { yield Buffer.from('abc'); throw new Error('source gone'); }
    const r = await run('ffprobe', ['-e', 'let n = 0; process.stdin.on("data", (c) => { n += c.length; }); process.stdin.on("end", () => process.stdout.write("eof:" + n))'], { timeoutMs: 5_000, stdin: failing() });
    expect(r.stdout.toString()).toBe('eof:3');
    const missing = createRun({ ffprobe: '/nonexistent/ffprobe' });
    expect((await missing('ffprobe', [], { timeoutMs: 1_000, stdin: failing() })).code).toBe(127);
  });

  it('a child killed at the timeout while reading stdin is code -1', async () => {
    async function* slow(): AsyncGenerator<Uint8Array> { for (;;) { yield Buffer.from('x'); await new Promise((r) => setTimeout(r, 50)); } }
    const r = await run('ffprobe', ['-e', 'process.stdin.resume()'], { timeoutMs: 300, stdin: slow() });
    expect(r.code).toBe(-1);
  });
});
