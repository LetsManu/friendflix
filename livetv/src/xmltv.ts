// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { FetchError } from './fetch.js';

/**
 * The XMLTV reader of `/v1/fetch/xmltv` (spec §3.4, plan ruling 4): an in-house streaming tokenizer for the XMLTV subset, no
 * dependency. Guide files are hostile input: gzip is recognised by its magic bytes and capped at 1 GB decompressed with a 20:1
 * ratio guard (`ratio`); any `<!DOCTYPE` / `<!ENTITY` refuses the document (`doctype`), and so does any entity other than the
 * five predefined and numeric ones (`invalid`), so no DTD, entity expansion or external reference can ever happen. A single token
 * (tag, text run, comment) is capped at 1 MB. Errors are fixed codes only, never input text.
 */
export type XmlItem =
  | { t: 'channel'; id: string; names: string[]; icon?: string /* first <icon src>, http(s) only */ }
  | {
    t: 'prog'; ch: string; start: number; end: number; title: string; subtitle?: string; desc?: string; cats?: string[]; episode?: string;
    seriesId?: string; isNew?: boolean; prevShown?: boolean; rating?: string;
  };

export type XmltvErrorCode = 'doctype' | 'invalid' | 'ratio' | 'too_big';
export class XmltvError extends Error {
  constructor(readonly code: XmltvErrorCode) {
    super(code);
    this.name = 'XmltvError';
  }
}

export const MAX_DECOMPRESSED = 1024 ** 3;
export const MAX_RATIO = 20;
/** below this much output the ratio is not judged (a tiny file cannot be a bomb) */
const RATIO_FLOOR = 64 * 1024;
const MAX_TOKEN = 1024 * 1024;
const MAX_DEPTH = 32;
const CUT = { title: 200, subtitle: 200, desc: 2000, name: 200, cat: 100, episode: 100, rating: 50, id: 500, icon: 2048 } as const;
const MAX_NAMES = 20;
const MAX_CATS = 20;

/** the bytes, decompressed when they start with the gzip magic; capped at `maxBytes` and (gzip) the ratio guard */
async function* plainBytes(bytes: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  const it = bytes[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let headLen = 0;
  let ended = false;
  while (headLen < 2) {
    const r = await it.next();
    if (r.done) { ended = true; break; }
    head.push(r.value);
    headLen += r.value.length;
  }
  let inBytes = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      for (const c of head) { inBytes += c.length; yield c; }
      while (!ended) {
        const r = await it.next();
        if (r.done) return;
        inBytes += r.value.length;
        yield r.value;
      }
    } finally {
      await it.return?.();
    }
  }
  const first = Buffer.concat(head);
  if (!(first[0] === 0x1f && first[1] === 0x8b)) {
    let n = 0;
    for await (const c of source()) {
      n += c.length;
      if (n > maxBytes) throw new XmltvError('too_big');
      yield c;
    }
    return;
  }
  const src = Readable.from(source());
  const gz = createGunzip();
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  let out = 0;
  try {
    for await (const c of gz as AsyncIterable<Buffer>) {
      out += c.length;
      if (out > maxBytes) throw new XmltvError('too_big');
      if (out > RATIO_FLOOR && out > MAX_RATIO * inBytes) throw new XmltvError('ratio');
      yield c;
    }
  } catch (e) {
    throw e instanceof XmltvError || e instanceof FetchError ? e : new XmltvError('invalid');
  } finally {
    src.destroy();
    gz.destroy();
  }
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** the five predefined and numeric references; any other named reference refuses the document; a bare `&` stays text */
function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (_m, ref: string) => {
    if (ref[0] !== '#') {
      const v = PREDEFINED[ref];
      if (v === undefined) throw new XmltvError('invalid');
      return v;
    }
    const hex = ref[1] === 'x' || ref[1] === 'X';
    const digits = ref.slice(hex ? 2 : 1);
    const cp = digits.length > 8 ? Infinity : parseInt(digits, hex ? 16 : 10);
    if (!(cp >= 1 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) throw new XmltvError('invalid');
    return String.fromCodePoint(cp);
  });
}

type Token = { k: 'open'; name: string; attrs: Map<string, string>; self: boolean } | { k: 'close'; name: string } | { k: 'text'; s: string };
const NAME = /^[A-Za-z_:][-\w.:]*/;
const ATTR = /\s*([A-Za-z_:][-\w.:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function parseTag(raw: string): Token {
  if (raw[0] === '/') {
    const name = raw.slice(1).trim();
    if (!NAME.test(name) || NAME.exec(name)![0] !== name) throw new XmltvError('invalid');
    return { k: 'close', name };
  }
  const self = raw.endsWith('/');
  const body = self ? raw.slice(0, -1) : raw;
  const m = NAME.exec(body);
  if (!m) throw new XmltvError('invalid');
  const attrs = new Map<string, string>();
  let i = m[0].length;
  while (i < body.length) {
    ATTR.lastIndex = i;
    const a = ATTR.exec(body);
    if (!a) {
      if (body.slice(i).trim() !== '') throw new XmltvError('invalid');
      break;
    }
    if (!attrs.has(a[1]!)) attrs.set(a[1]!, decode(a[2] ?? a[3] ?? ''));
    i = ATTR.lastIndex;
  }
  return { k: 'open', name: m[0], attrs, self };
}

/** the streaming tokenizer: `push` text, then `drain` the complete tokens (at the end with `final`) */
class Tokenizer {
  private buf = '';
  push(s: string): void { this.buf += s; }
  *drain(final: boolean): Generator<Token> {
    const b = this.buf;
    let pos = 0;
    try {
      while (pos < b.length) {
        const lt = b.indexOf('<', pos);
        if (lt === -1) {
          if (!final) break;
          if (b.length - pos > MAX_TOKEN) throw new XmltvError('invalid');
          yield { k: 'text', s: decode(b.slice(pos)) };
          pos = b.length;
          break;
        }
        if (lt > pos) {
          if (lt - pos > MAX_TOKEN) throw new XmltvError('invalid');
          yield { k: 'text', s: decode(b.slice(pos, lt)) };
          pos = lt;
          continue;
        }
        const rest = b.length - pos;
        if (b.startsWith('<!', pos) || b.startsWith('<?', pos)) {
          if (rest < 9 && !final) break;
          if (b.startsWith('<!--', pos)) {
            const end = b.indexOf('-->', pos + 4);
            if (end === -1) break;
            pos = end + 3;
          } else if (b.startsWith('<![CDATA[', pos)) {
            const end = b.indexOf(']]>', pos + 9);
            if (end === -1) break;
            if (end - pos > MAX_TOKEN) throw new XmltvError('invalid');
            yield { k: 'text', s: b.slice(pos + 9, end) };
            pos = end + 3;
          } else if (b.startsWith('<?', pos)) {
            const end = b.indexOf('?>', pos + 2);
            if (end === -1) break;
            pos = end + 2;
          } else if (/^<!(DOCTYPE|ENTITY)/i.test(b.slice(pos, pos + 9))) {
            throw new XmltvError('doctype');
          } else {
            throw new XmltvError('invalid');
          }
          continue;
        }
        // a tag: its end is the first '>' outside quotes
        let q = '';
        let end = -1;
        for (let j = pos + 1; j < b.length; j++) {
          const c = b[j];
          if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') { end = j; break; }
        }
        if (end === -1) break;
        if (end - pos > MAX_TOKEN) throw new XmltvError('invalid');
        yield parseTag(b.slice(pos + 1, end));
        pos = end + 1;
      }
    } finally {
      this.buf = b.slice(pos);
    }
    if (this.buf.length > MAX_TOKEN || (final && this.buf.length > 0)) throw new XmltvError('invalid');
  }
}

/** `YYYYMMDDHHmm[ss] [±HHMM]` → epoch ms (no offset: UTC); anything else → null */
function parseTime(raw: string | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?$/.exec(raw?.trim() ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, s = 0] = m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || h! > 23 || mi! > 59 || s! > 59) return null;
  const day = Date.UTC(y!, mo! - 1, d!);
  if (new Date(day).getUTCDate() !== d) return null;
  let off = 0;
  if (m[7]) {
    const oh = Number(m[8]);
    const om = Number(m[9]);
    if (oh > 14 || om > 59) return null;
    off = (m[7] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return day + ((h! * 60 + mi!) * 60 + s!) * 1000 - off;
}

/** trimmed and cut to `n` characters (code points); empty → undefined */
function cut(s: string, n: number): string | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (t.length <= n) return t;
  return Array.from(t).slice(0, n).join('');
}

/** `xmltv_ns` `season.episode.part` (zero-based, `/total` allowed) → `S<s+1>E<e+1>` / `E<e+1>` */
function xmltvNs(s: string): string | undefined {
  const [a = '', b = ''] = s.split('.');
  const num = (x: string) => { const v = /^\s*(\d{1,4})\s*(?:\/\s*\d*\s*)?$/.exec(x); return v ? Number(v[1]) + 1 : null; };
  const se = num(a);
  const ep = num(b);
  if (ep === null) return undefined;
  return se === null ? `E${ep}` : `S${se}E${ep}`;
}

type Prog = {
  ch?: string; start: number | null; end: number | null; title?: string; subtitle?: string; desc?: string; cats: string[];
  onscreen?: string; ns?: string; progid?: string; seriesId?: string; isNew?: boolean; prevShown?: boolean; rating?: string;
};
type Capture = { field: string; text: string; limit: number; depth: number };

/**
 * Stream the items of an XMLTV document: a channel when its `</channel>` closes, a programme when its `</programme>` closes.
 * Programmes without a valid start/stop, channel or title, or outside `[from, to]`, are skipped; `channels` keeps only those
 * channels and their programmes; after `maxProgrammes` programmes the source is closed and the stream ends. Fails with
 * `XmltvError` (or the source's `FetchError`); items already yielded stay valid.
 */
export async function* parseXmltv(
  bytes: AsyncIterable<Uint8Array>,
  o: { from: number; to: number; channels?: Set<string>; maxProgrammes: number; maxBytes?: number },
): AsyncGenerator<XmlItem> {
  const tok = new Tokenizer();
  const decoder = new TextDecoder('utf-8');
  const stack: string[] = [];
  let rootDone = false;
  let progs = 0;
  let channel: { id?: string; names: string[]; icon?: string } | null = null;
  let prog: Prog | null = null;
  let cap: Capture | null = null;
  let ratingSeen = false;
  const wanted = (id: string) => !o.channels || o.channels.has(id);

  const open = (t: Extract<Token, { k: 'open' }>): void => {
    if (rootDone || (stack.length === 0 && t.name !== 'tv')) throw new XmltvError('invalid');
    if (stack.length >= MAX_DEPTH) throw new XmltvError('invalid');
    const depth = stack.length; // the new element's parent depth (tv = 0)
    const parent = stack[stack.length - 1];
    if (depth === 1 && t.name === 'channel') channel = { id: cut(t.attrs.get('id') ?? '', CUT.id), names: [] };
    else if (depth === 1 && t.name === 'programme') {
      prog = { ch: cut(t.attrs.get('channel') ?? '', CUT.id), start: parseTime(t.attrs.get('start')), end: parseTime(t.attrs.get('stop')), cats: [] };
      ratingSeen = false;
    } else if (depth === 2 && channel && parent === 'channel') {
      if (t.name === 'display-name') cap = { field: 'name', text: '', limit: CUT.name, depth };
      else if (t.name === 'icon' && channel.icon === undefined) {
        const src = t.attrs.get('src') ?? '';
        if (/^https?:\/\//i.test(src) && src.length <= CUT.icon) channel.icon = src;
      }
    } else if (depth === 2 && prog && parent === 'programme') {
      const field = { title: 'title', 'sub-title': 'subtitle', desc: 'desc', category: 'cat', 'series-id': 'seriesId' }[t.name];
      if (field) cap = { field, text: '', limit: CUT[field === 'cat' ? 'cat' : field === 'seriesId' ? 'id' : (field as 'title' | 'subtitle' | 'desc')], depth };
      else if (t.name === 'episode-num') {
        const sys = t.attrs.get('system') ?? 'xmltv_ns';
        cap = { field: sys === 'onscreen' ? 'onscreen' : sys === 'dd_progid' ? 'progid' : sys === 'xmltv_ns' ? 'ns' : 'ignore', text: '', limit: CUT.episode, depth };
      } else if (t.name === 'new') prog.isNew = true;
      else if (t.name === 'previously-shown') prog.prevShown = true;
    } else if (depth === 3 && prog && parent === 'rating' && t.name === 'value' && !ratingSeen) {
      cap = { field: 'rating', text: '', limit: CUT.rating, depth };
    }
    if (t.self) closeCapture(depth);
    else stack.push(t.name);
    if (t.self && depth === 1) finish(t.name);
  };

  function closeCapture(depth: number): void {
    const c = cap;
    if (!c || c.depth !== depth) return;
    cap = null;
    const v = cut(c.text, c.limit);
    if (c.field === 'rating') ratingSeen = true;
    if (v === undefined) return;
    if (c.field === 'name') { if (channel && channel.names.length < MAX_NAMES) channel.names.push(v); return; }
    const p = prog;
    if (!p) return;
    if (c.field === 'cat') { if (p.cats.length < MAX_CATS) p.cats.push(v); return; }
    const key = c.field as 'title' | 'subtitle' | 'desc' | 'onscreen' | 'ns' | 'progid' | 'seriesId' | 'rating';
    if (c.field !== 'ignore' && p[key] === undefined) p[key] = v;
  }

  let ready: XmlItem | null = null;
  function finish(name: string): void {
    if (name === 'channel' && channel) {
      const ch = channel;
      channel = null;
      if (ch.id && wanted(ch.id)) ready = { t: 'channel', id: ch.id, names: ch.names, ...(ch.icon ? { icon: ch.icon } : {}) };
    } else if (name === 'programme' && prog) {
      const p: Prog = prog;
      prog = null;
      if (!p.ch || !p.title || p.start === null || p.end === null || p.end <= p.start || !wanted(p.ch)) return;
      if (p.end < o.from || p.start > o.to) return;
      const episode = p.onscreen ?? (p.ns ? xmltvNs(p.ns) : undefined);
      const seriesId = p.progid ? cut(p.progid.split('.')[0]!, CUT.id) : p.seriesId;
      ready = {
        t: 'prog', ch: p.ch, start: p.start, end: p.end, title: p.title,
        ...(p.subtitle ? { subtitle: p.subtitle } : {}), ...(p.desc ? { desc: p.desc } : {}), ...(p.cats.length ? { cats: p.cats } : {}),
        ...(episode ? { episode } : {}), ...(seriesId ? { seriesId } : {}), ...(p.isNew ? { isNew: true } : {}),
        ...(p.prevShown ? { prevShown: true } : {}), ...(p.rating ? { rating: p.rating } : {}),
      };
    }
  }

  const handle = (t: Token): XmlItem | null => {
    ready = null;
    if (t.k === 'text') {
      if (stack.length === 0) { if (t.s.trim() !== '') throw new XmltvError('invalid'); return null; }
      if (cap && cap.text.length < cap.limit * 2 + 64) cap.text += t.s;
    } else if (t.k === 'open') {
      open(t);
    } else {
      if (stack[stack.length - 1] !== t.name) throw new XmltvError('invalid');
      stack.pop();
      closeCapture(stack.length);
      if (t.name === 'rating' && stack.length === 2) ratingSeen = true;
      if (stack.length === 1) finish(t.name);
      if (stack.length === 0) rootDone = true;
    }
    return ready;
  };

  try {
    for await (const chunk of plainBytes(bytes, o.maxBytes ?? MAX_DECOMPRESSED)) {
      tok.push(decoder.decode(chunk, { stream: true }));
      for (const t of tok.drain(false)) {
        const item = handle(t);
        if (!item) continue;
        yield item;
        if (item.t === 'prog' && ++progs >= o.maxProgrammes) return;
      }
    }
    tok.push(decoder.decode());
    for (const t of tok.drain(true)) {
      const item = handle(t);
      if (!item) continue;
      yield item;
      if (item.t === 'prog' && ++progs >= o.maxProgrammes) return;
    }
    if (!rootDone) throw new XmltvError('invalid');
  } catch (e) {
    throw e instanceof XmltvError || e instanceof FetchError ? e : new XmltvError('invalid');
  }
}
