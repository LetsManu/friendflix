// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DIR_RE, type Recorder } from '../recorder.js';
import type { Answer, Route } from '../server.js';
import { CHANNEL_ID_RE } from './streams.js';

/**
 * The signed recording routes (plan Phase 3 Task 2): `POST /v1/recordings { id, channelId, dir, endAt }` (idempotent per id; 409
 * `stream_not_running` when the backend has not started the channel's stream, 507 `storage_full` under 2 GiB free), `PATCH
 * /v1/recordings/:id { endAt }`, `DELETE /v1/recordings/:id` (stops now, ENDLIST), `GET /v1/recordings` (finished ones stay listed for
 * an hour) and `POST /v1/recordings/:id/delete { dir }` (removes the folder; never a link, never outside `/recordings`). A body outside
 * the schema is `400 { error: 'invalid', field }`, never echoed.
 */
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const invalid = (field: string): Answer => ({ status: 400, json: { error: 'invalid', field } });
const notFound: Answer = { status: 404, json: { error: 'not_found' } };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const epoch = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 8.64e15;

export function recordingRoutes(rec: Recorder, o: { now?: () => number } = {}): Route[] {
  const now = o.now ?? Date.now;
  return [
    {
      method: 'POST', path: '/v1/recordings',
      handle: async (c) => {
        const b = obj(c.json);
        if (!b) return invalid('body');
        if (typeof b.id !== 'string' || !DIR_RE.test(b.id)) return invalid('id');
        if (typeof b.channelId !== 'string' || !CHANNEL_ID_RE.test(b.channelId)) return invalid('channelId');
        if (typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) return invalid('dir');
        if (!epoch(b.endAt) || b.endAt <= now()) return invalid('endAt');
        const r = await rec.start({ id: b.id, channelId: b.channelId, dir: b.dir, endAt: b.endAt });
        if (!r.ok) return { status: r.status, json: { error: r.error } };
        return { status: 200, json: { state: r.state, segments: r.segments } };
      },
    },
    { method: 'GET', path: '/v1/recordings', handle: async () => ({ status: 200, json: rec.list() }) },
    {
      method: 'PATCH', path: new RegExp(`^/v1/recordings/${ID}$`),
      handle: async (c) => {
        const b = obj(c.json);
        if (!b || !epoch(b.endAt)) return invalid('endAt');
        return rec.setEnd(c.params[0]!, b.endAt) ? { status: 200, json: { ok: true } } : notFound;
      },
    },
    {
      method: 'DELETE', path: new RegExp(`^/v1/recordings/${ID}$`),
      handle: async (c) => ((await rec.stop(c.params[0]!)) ? { status: 204 } : notFound),
    },
    {
      method: 'POST', path: new RegExp(`^/v1/recordings/${ID}/delete$`),
      handle: async (c) => {
        const b = obj(c.json);
        if (!b || typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) return invalid('dir');
        const r = await rec.remove(c.params[0]!, b.dir);
        if (r === 'not_found') return notFound;
        if (r === 'not_a_folder') return { status: 409, json: { error: 'not_a_folder' } };
        return { status: 204 };
      },
    },
  ];
}
