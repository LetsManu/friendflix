// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for `livetv/native/srtgate` in tests: no libsrt, no network, Node built-ins only. It speaks srtgate's protocol (plan
 * Task 29): stdin JSON lines, stdout frames — data `0x01 <u16 port BE> <u32 len BE> <payload>`, event `0x02 <u32 len BE> <json>`.
 *
 * - argv `--ports <range>` is accepted and ignored; `--record <file>`: every stdin line whose `t` is `feeds` is appended to <file>
 *   exactly as it arrived (plus `\n`), so a test sees the bytes livetv wrote.
 * - stdin `{"t":"_do","steps":[…]}` (tests only; livetv never writes it) runs the steps in order, each written completely before the
 *   next starts:
 *     `{ "event": {…} }`                       an event frame carrying that JSON
 *     `{ "data": port, "bytes": n, "fill": b }` a data frame of n bytes of value b
 *     `{ "raw": "<hex>" }`                      these bytes on stdout as they are (garbage, a broken frame)
 *     `"split": true` on an event or data step: the frame goes out in three pieces with a short pause between them
 *     `{ "stderr": "text" }`                    text on stderr
 *     `{ "exit": code }`                        exits with that code (after everything before it was written)
 * - stdin EOF: exits 0, like srtgate (its parent is gone).
 */
import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const args = process.argv.slice(2);
const record = args.includes('--record') ? args[args.indexOf('--record') + 1] : null;

const dataFrame = (port, payload) => {
  const h = Buffer.alloc(7);
  h[0] = 0x01;
  h.writeUInt16BE(port, 1);
  h.writeUInt32BE(payload.length, 3);
  return Buffer.concat([h, payload]);
};
const eventFrame = (obj) => {
  const j = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(5);
  h[0] = 0x02;
  h.writeUInt32BE(j.length, 1);
  return Buffer.concat([h, j]);
};
const write = (b) => new Promise((resolve) => { process.stdout.write(b, () => resolve()); });
const pause = () => new Promise((resolve) => { setTimeout(resolve, 5); });

async function perform(steps) {
  for (const s of steps) {
    let frame = null;
    if (s.event !== undefined) frame = eventFrame(s.event);
    else if (s.data !== undefined) frame = dataFrame(s.data, Buffer.alloc(s.bytes, s.fill ?? 0));
    else if (s.raw !== undefined) frame = Buffer.from(s.raw, 'hex');
    else if (s.stderr !== undefined) await new Promise((resolve) => { process.stderr.write(s.stderr, () => resolve()); });
    else if (s.exit !== undefined) process.exit(s.exit);
    if (!frame) continue;
    if (s.split && frame.length >= 3) {
      const a = Math.floor(frame.length / 3);
      const b = Math.floor((2 * frame.length) / 3);
      await write(frame.subarray(0, a));
      await pause();
      await write(frame.subarray(a, b));
      await pause();
      await write(frame.subarray(b));
    } else {
      await write(frame);
    }
  }
}

let chain = Promise.resolve();
function handle(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m === null || typeof m !== 'object') return;
  if (m.t === 'feeds' && record) appendFileSync(record, `${line}\n`);
  else if (m.t === '_do' && Array.isArray(m.steps)) chain = chain.then(() => perform(m.steps));
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  pending += c;
  for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    handle(line);
  }
});
process.stdin.on('end', () => { void chain.then(() => process.exit(0)); });
// livetv may close its end of stdout first (a protocol error): the helper just ends
process.stdout.on('error', () => process.exit(0));
