// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Answer, Route } from '../server.js';
import type { Feed, IngestHub } from '../srtingest.js';
import { CHANNEL_ID_RE } from './streams.js';

/**
 * The signed ingest routes (spec §3.2, §3.5): `PUT /v1/ingest { feeds }` replaces the whole push set at once (a body that fails
 * changes nothing) and answers `{ ok: true, listening }` (the ports that carry a feed); a feed whose port is outside
 * LIVETV_SRT_PORTS is ignored (the backend shows "Port {p} liegt nicht mehr im Bereich"). `GET /v1/ingest` answers
 * `IngestState[]`. Failures are `400 { error: 'invalid', field }` and never echo the body: it holds stream ids and passphrases.
 */
export const MAX_FEEDS = 1000;
/** SRT limits: a stream id of at most 512 bytes, a passphrase of 10–79 characters; printable ASCII only (srtgate's line parser) */
const STREAM_ID_MAX = 512;
const PASS_MIN = 10;
const PASS_MAX = 79;
const PRINTABLE = /^[\x20-\x7e]+$/;

const invalid = (field: string): Answer => ({ status: 400, json: { error: 'invalid', field } });

/** the feed set, or the field that fails */
export function ingestBody(v: unknown): Feed[] | { field: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { field: 'body' };
  const list = (v as Record<string, unknown>).feeds;
  const bad = { field: 'feeds' };
  if (!Array.isArray(list) || list.length > MAX_FEEDS) return bad;
  const out: Feed[] = [];
  const ports = new Set<number>();
  const ids = new Set<string>();
  for (const x of list) {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return bad;
    const { channelId, port, streamId, passphrase } = x as Record<string, unknown>;
    if (typeof channelId !== 'string' || !CHANNEL_ID_RE.test(channelId)) return bad;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return bad;
    if (typeof streamId !== 'string' || streamId.length > STREAM_ID_MAX || !PRINTABLE.test(streamId)) return bad;
    if (typeof passphrase !== 'string' || passphrase.length < PASS_MIN || passphrase.length > PASS_MAX || !PRINTABLE.test(passphrase)) return bad;
    // one port carries one feed, one feed has one port
    if (ports.has(port) || ids.has(channelId)) return bad;
    ports.add(port);
    ids.add(channelId);
    out.push({ channelId, port, streamId, passphrase });
  }
  return out;
}

export function ingestRoutes(hub: Pick<IngestHub, 'setFeeds' | 'state'>, o: { ports: readonly number[] }): Route[] {
  const range = new Set(o.ports);
  return [
    {
      method: 'PUT', path: '/v1/ingest',
      handle: async (c) => {
        const b = ingestBody(c.json);
        if ('field' in b) return invalid(b.field);
        const { listening } = hub.setFeeds(b.filter((f) => range.has(f.port)));
        return { status: 200, json: { ok: true, listening } };
      },
    },
    { method: 'GET', path: '/v1/ingest', handle: async () => ({ status: 200, json: hub.state() }) },
  ];
}
