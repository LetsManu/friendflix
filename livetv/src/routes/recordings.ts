// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { LibraryError, type Library } from '../library.js';
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

const LIBRARY_STATUS: Record<LibraryError['code'], number> = {
  no_library: 404, not_found: 404, invalid: 400, library_not_writable: 409, library_not_dedicated: 409, storage_full: 507, write_failed: 409,
  export_failed: 502, verify_failed: 502, busy: 409,
};
const libraryError = (e: unknown): Answer => {
  if (!(e instanceof LibraryError)) throw e;
  return e.code === 'invalid' ? invalid('path') : { status: LIBRARY_STATUS[e.code], json: { error: e.code } };
};

export function recordingRoutes(rec: Recorder, o: { now?: () => number; library?: Library } = {}): Route[] {
  const now = o.now ?? Date.now;
  const library = o.library;
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
    {
      // finalise a recording (B-I2): a running one ends now; a folder whose recorder livetv lost (a restart after its end) gets its ENDLIST
      // and answers its facts read from the playlist
      method: 'POST', path: new RegExp(`^/v1/recordings/${ID}/close$`),
      handle: async (c) => {
        const b = obj(c.json);
        if (!b || typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) return invalid('dir');
        const r = await rec.closeFolder(c.params[0]!, b.dir);
        return r ? { status: 200, json: r } : notFound;
      },
    },
    {
      // the library mode (Task 6): one file in the Jellyfin library folder, concatenated without re-encoding (a running recording never)
      method: 'POST', path: new RegExp(`^/v1/recordings/${ID}/export$`),
      handle: async (c) => {
        const b = obj(c.json);
        if (!b || typeof b.dir !== 'string' || !DIR_RE.test(b.dir)) return invalid('dir');
        if (typeof b.folder !== 'string' || b.folder.length > 400) return invalid('folder');
        if (typeof b.file !== 'string' || b.file.length > 400) return invalid('file');
        if (rec.list().some((r) => r.id === c.params[0] && r.state === 'recording')) return { status: 409, json: { error: 'recording' } };
        if (!library) return { status: 404, json: { error: 'no_library' } };
        try {
          return { status: 200, json: await library.export(c.params[0]!, { dir: b.dir, folder: b.folder, file: b.file }) };
        } catch (e) {
          return libraryError(e);
        }
      },
    },
    {
      method: 'POST', path: new RegExp(`^/v1/recordings/${ID}/library-delete$`),
      handle: async (c) => {
        const b = obj(c.json);
        if (!b || typeof b.path !== 'string' || b.path.length > 400) return invalid('path');
        if (!library) return { status: 404, json: { error: 'no_library' } };
        try {
          await library.remove(c.params[0]!, b.path);
          return { status: 204 };
        } catch (e) {
          return libraryError(e);
        }
      },
    },
  ];
}
