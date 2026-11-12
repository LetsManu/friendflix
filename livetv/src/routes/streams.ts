// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Previews } from '../preview.js';
import type { Answer, Route } from '../server.js';
import { MODES, StreamsError, type Mode, type StartBody, type Streams } from '../streams.js';
import { ENCODERS, type Encoder } from '../system.js';
import { DVR_MAX_SECONDS } from '../window.js';
import { streamInput } from './fetch.js';

/**
 * The signed stream routes of spec §3.2: `POST /v1/streams` (idempotent per channel), `GET /v1/streams`, `DELETE
 * /v1/streams/:channelId` (stops and removes the files; a channel that is not running answers the same 204), `GET
 * /v1/streams/:channelId/preview.jpg` (the newest preview; 404 when the channel is not running — not listed, or failed — or has
 * none yet; never starts a stream). A body outside the schema is `400 { error: 'invalid', field }` (never the input echoed); a
 * mode whose driver is not there is `422 unsupported_mode`; a transcode with an encoder `/v1/system` does not list is `400
 * encoder_unavailable`.
 */
export const CHANNEL_ID_RE = /^[\w-]{1,100}$/;
const MAX_BITRATE = 1_000_000_000;

const invalid = (field: string): Answer => ({ status: 400, json: { error: 'invalid', field } });

/** the start body, or the first field that fails */
export function startBody(v: unknown): StartBody | { field: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { field: 'body' };
  const b = v as Record<string, unknown>;
  if (typeof b.channelId !== 'string' || !CHANNEL_ID_RE.test(b.channelId)) return { field: 'channelId' };
  let input: StartBody['input'];
  try {
    input = streamInput(b.input);
  } catch {
    return { field: 'input' };
  }
  if (!MODES.includes(b.mode as Mode)) return { field: 'mode' };
  if (!(ENCODERS as readonly unknown[]).includes(b.encoder)) return { field: 'encoder' };
  const dvr = b.dvrSeconds;
  if (typeof dvr !== 'number' || !Number.isInteger(dvr) || dvr < 0 || dvr > DVR_MAX_SECONDS) return { field: 'dvrSeconds' };
  const rate = b.maxBitrate;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || rate > MAX_BITRATE) return { field: 'maxBitrate' };
  return { channelId: b.channelId, input, mode: b.mode as Mode, encoder: b.encoder as Encoder, dvrSeconds: dvr, maxBitrate: rate };
}

export interface StreamRouteDeps {
  /** the encoders `/v1/system` lists (without it the encoder is not checked) */
  encoders?: () => Promise<Encoder[]>;
  previews?: Pick<Previews, 'get'>;
}

export function streamRoutes(streams: Streams, deps: StreamRouteDeps = {}): Route[] {
  return [
    {
      method: 'POST', path: '/v1/streams',
      handle: async (c) => {
        const b = startBody(c.json);
        if ('field' in b) return invalid(b.field);
        if (b.mode === 'transcode' && deps.encoders && !(await deps.encoders()).includes(b.encoder)) {
          return { status: 400, json: { error: 'encoder_unavailable' } };
        }
        try {
          return { status: 200, json: streams.start(b) };
        } catch (e) {
          if (e instanceof StreamsError) return { status: 422, json: { error: e.code } };
          throw e;
        }
      },
    },
    { method: 'GET', path: '/v1/streams', handle: async () => ({ status: 200, json: streams.list() }) },
    {
      method: 'DELETE', path: /^\/v1\/streams\/([\w-]{1,100})$/,
      handle: async (c) => {
        await streams.stop(c.params[0]!);
        return { status: 204 };
      },
    },
    {
      method: 'GET', path: /^\/v1\/streams\/([\w-]{1,100})\/preview\.jpg$/,
      handle: async (c) => {
        const id = c.params[0]!;
        // a failed stream stays listed until it is stopped, but it is not running: its last image is not served
        const jpeg = streams.running(id) ? deps.previews?.get(id) ?? null : null;
        if (!jpeg) return { status: 404, json: { error: 'not_found' } };
        c.res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length, 'cache-control': 'no-store' });
        c.res.end(jpeg);
      },
    },
  ];
}
