// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isMigratedTarget, isRel, isTarget } from './paths.js';
import { BACKUP_ID_RE, GPUS, KINDS, type DesiredSpec, type Folder, type Gpu, type Kind, type MediaOp } from './types.js';

const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/;
const PASSWORD_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_FOLDERS = 20;
const CONTAINER_RE = /^[0-9a-f]{64}$/;
const SERVER_ID_RE = /^[0-9a-f]{32}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** the object has exactly these keys */
const exact = (o: Obj, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
};
const id = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
const kind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const gpu = (v: unknown): v is Gpu => typeof v === 'string' && (GPUS as readonly string[]).includes(v);

const hex64 = (v: unknown): v is string => typeof v === 'string' && CONTAINER_RE.test(v);
const hex32 = (v: unknown): v is string => typeof v === 'string' && SERVER_ID_RE.test(v);

function folder(v: unknown): Folder | null {
  if (!isObj(v)) return null;
  const migrated = Object.prototype.hasOwnProperty.call(v, 'migrated');
  if (!exact(v, migrated ? ['rel', 'target', 'migrated'] : ['rel', 'target'])) return null;
  const { rel, target } = v;
  if (typeof rel !== 'string' || typeof target !== 'string') return null;
  // a migrated folder keeps the path the old server saw and may be the whole base (empty rel)
  if (migrated) return v.migrated === true && isRel(rel, 0, 3) && isMigratedTarget(target) ? { rel, target, migrated: true } : null;
  return isRel(rel, 1, 3) && isTarget(target) ? { rel, target } : null;
}

function spec(v: unknown): DesiredSpec | null {
  if (!isObj(v)) return null;
  const migrated = Object.prototype.hasOwnProperty.call(v, 'migrated');
  if (!exact(v, migrated ? ['kind', 'folders', 'uid', 'gid', 'gpu', 'mediaGid', 'egress', 'tz', 'migrated'] : ['kind', 'folders', 'uid', 'gid', 'gpu', 'mediaGid', 'egress', 'tz'])) return null;
  if (migrated && v.migrated !== true) return null;
  const { kind: k, folders, uid, gid, gpu: g, mediaGid, egress, tz } = v;
  if (!kind(k) || !gpu(g) || !id(uid) || !id(gid) || !(mediaGid === null || id(mediaGid)) || typeof egress !== 'boolean') return null;
  if (typeof tz !== 'string' || !TZ_RE.test(tz) || tz.length > 64) return null;
  if (!Array.isArray(folders) || folders.length > MAX_FOLDERS) return null;
  const fs: Folder[] = [];
  for (const f of folders) {
    const p = folder(f);
    if (!p) return null;
    fs.push(p);
  }
  if (new Set(fs.map((f) => f.rel)).size !== fs.length || new Set(fs.map((f) => f.target)).size !== fs.length) return null;
  return { kind: k, folders: fs, uid, gid, gpu: g, mediaGid, egress, tz, ...(migrated ? { migrated: true as const } : {}) };
}

/** The body of POST /v1/mediaserver: exactly the keys of one MediaOp variant, nothing else; null = invalid_body. */
export function parseMediaBody(raw: unknown): MediaOp | null {
  if (!isObj(raw) || typeof raw.op !== 'string') return null;
  switch (raw.op) {
    case 'base-request':
      return exact(raw, ['op', 'path']) && typeof raw.path === 'string' && raw.path.length <= 200 ? { op: 'base-request', path: raw.path } : null;
    case 'base-confirm':
      return exact(raw, ['op', 'code']) && typeof raw.code === 'string' && raw.code.length <= 64 ? { op: 'base-confirm', code: raw.code } : null;
    case 'base-clear': case 'gpu': case 'finish-setup': case 'start': case 'stop': case 'restart': case 'update':
      return exact(raw, ['op']) ? { op: raw.op } : null;
    case 'browse':
      return exact(raw, ['op', 'rel']) && typeof raw.rel === 'string' && isRel(raw.rel, 0, 3) ? { op: 'browse', rel: raw.rel } : null;
    case 'logs':
      return exact(raw, ['op', 'tail']) && typeof raw.tail === 'number' && Number.isInteger(raw.tail) && raw.tail >= 50 && raw.tail <= 500 ? { op: 'logs', tail: raw.tail } : null;
    case 'apply': {
      const hasFirst = Object.prototype.hasOwnProperty.call(raw, 'firstRun');
      if (!exact(raw, hasFirst ? ['op', 'spec', 'firstRun'] : ['op', 'spec'])) return null;
      const s = spec(raw.spec);
      if (!s) return null;
      if (!hasFirst) return { op: 'apply', spec: s };
      const fr = raw.firstRun;
      if (s.kind !== 'ferrofin' || !isObj(fr) || !exact(fr, ['password']) || typeof fr.password !== 'string' || !PASSWORD_RE.test(fr.password)) return null;
      return { op: 'apply', spec: s, firstRun: { password: fr.password } };
    }
    case 'hdr-test':
      return exact(raw, ['op', 'kind']) && kind(raw.kind) ? { op: 'hdr-test', kind: raw.kind } : null;
    case 'backup':
      return exact(raw, ['op', 'trickplay']) && typeof raw.trickplay === 'boolean' ? { op: 'backup', trickplay: raw.trickplay } : null;
    case 'restore':
      return exact(raw, ['op', 'id']) && typeof raw.id === 'string' && BACKUP_ID_RE.test(raw.id) ? { op: 'restore', id: raw.id } : null;
    case 'remove':
      return exact(raw, ['op', 'data']) && typeof raw.data === 'boolean' ? { op: 'remove', data: raw.data } : null;
    case 'migrate-scan': {
      const hasSource = Object.prototype.hasOwnProperty.call(raw, 'source');
      if (!exact(raw, hasSource ? ['op', 'serverId', 'source'] : ['op', 'serverId']) || !hex32(raw.serverId)) return null;
      if (!hasSource) return { op: 'migrate-scan', serverId: raw.serverId };
      return hex64(raw.source) ? { op: 'migrate-scan', serverId: raw.serverId, source: raw.source } : null;
    }
    case 'migrate-done': case 'migrate-abort': case 'source-start':
      return exact(raw, ['op']) ? { op: raw.op } : null;
    case 'migrate':
      if (!exact(raw, ['op', 'source', 'trickplay', 'gpu', 'uid', 'gid', 'tz', 'serverId'])) return null;
      if (!hex64(raw.source) || typeof raw.trickplay !== 'boolean' || !gpu(raw.gpu) || !id(raw.uid) || !id(raw.gid) || !hex32(raw.serverId)) return null;
      if (typeof raw.tz !== 'string' || !TZ_RE.test(raw.tz) || raw.tz.length > 64) return null;
      return { op: 'migrate', source: raw.source, trickplay: raw.trickplay, gpu: raw.gpu, uid: raw.uid, gid: raw.gid, tz: raw.tz, serverId: raw.serverId };
    default:
      return null;
  }
}
