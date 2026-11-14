// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServiceHealth } from '../../health.js';
import { runProbe } from '../../settings/probes.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckId, type CheckLine } from '../types.js';
import { levelToStatus, service } from './core.js';

/**
 * Medien: the media server, the request service, the TMDB/OMDb keys, the nightly playback check and the transcoding advice, from the health
 * snapshot. Only a request service that reads as down is probed again (to tell a refused key from an unreachable service).
 */
const msOf = (h: ServiceHealth) => (h.ms !== undefined ? { ms: h.ms } : {});

function serverLine(env: CheckEnv, h: ServiceHealth | undefined): CheckLine {
  const id = 'media.server';
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const settingKey = env.ctx.cfg.MEDIA_SERVER === 'plex' ? 'PLEX_URL' : 'JELLYFIN_URL';
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', msOf(h));
  if (status === 'problem') return bad(id, status, 'media_down', { ...msOf(h), settingKey });
  if (status === 'warning') return bad(id, status, 'media_slow', { ...msOf(h), settingKey });
  return bad(id, 'unknown', 'check_unavailable');
}

async function requestsLine(env: CheckEnv, h: ServiceHealth | undefined): Promise<CheckLine> {
  const id = 'media.requests';
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', msOf(h));
  if (status === 'not_set_up') return bad(id, status, 'requests_not_set', { settingKey: 'REQUESTS_URL' });
  if (status === 'unknown') return bad(id, status, 'check_unavailable');
  // down (only ever a warning: wishes stop, nothing else): a refused key is a different fix than an unreachable service
  const r = await runProbe(env.ctx, 'requests', env.ctx.cfg, { timeoutMs: Math.max(500, env.timeoutMs - 1_000) });
  if (r.ok) return line(id, 'ok');
  return r.code === 'unauthorized'
    ? bad(id, 'warning', 'requests_key_invalid', { settingKey: 'REQUESTS_API_KEY' })
    : bad(id, 'warning', 'requests_down', { ...msOf(h), settingKey: 'REQUESTS_URL' });
}

function sourceLine(id: CheckId, h: ServiceHealth | undefined, settingKey: 'TMDB_API_KEY' | 'OMDB_API_KEY'): CheckLine {
  if (!h) return bad(id, 'unknown', 'check_unavailable');
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok');
  if (status === 'not_set_up') return bad(id, status, 'source_not_set', { settingKey });
  switch (h.reason) {
    case 'invalid_key': return bad(id, status, 'source_key_invalid', { settingKey });
    case 'paused': return bad(id, status, 'source_paused');
    case 'budget': return bad(id, status, 'source_budget', { params: { pct: h.detail?.pct, n: h.detail?.n } });
    default: return bad(id, 'unknown', 'check_unavailable');
  }
}

function playbackLine(h: ServiceHealth | undefined): CheckLine {
  const id = 'media.playback';
  const href = '/admin/playback';
  if (!h) return bad(id, 'unknown', 'check_unavailable', { href });
  if (h.level === 'off') return bad(id, 'unknown', h.reason === 'unavailable' ? 'check_unavailable' : 'playback_never', { href });
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok');
  // every title failed: the media server, not a file, is broken
  return bad(id, status, h.reason === 'empty_media' ? 'playback_empty' : 'playback_failed', { params: { n: h.detail?.n }, href });
}

function encoderLine(h: ServiceHealth | undefined): CheckLine {
  const id = 'media.encoder';
  // a media server without readable transcoding settings (Plex) has no row: neutral, never red
  if (!h) return bad(id, 'not_set_up', 'encoder_unsupported');
  const hevc = h.hevc ? { hevc: h.hevc.state, speed: h.hevc.speed } : {};
  const status = levelToStatus(h.level, h.reason);
  if (status === 'ok') return line(id, 'ok', { params: hevc });
  if (status !== 'warning' || !h.advice?.length) return bad(id, 'unknown', 'check_unavailable');
  // advice only, most important first: the first is the cause, all of them go to the UI as codes
  const cause = h.advice[0]!;
  return bad(id, status, cause, { params: { advice: h.advice.join(','), ...hevc }, ...(cause.startsWith('hevc_') ? { settingKey: 'HEVC_STREAMS' } : {}) });
}

export const mediaCheck: GroupCheck = {
  group: 'media',
  ids: ['media.server', 'media.requests', 'media.tmdb', 'media.omdb', 'media.playback', 'media.encoder'],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    const s = await env.snapshot();
    return [
      serverLine(env, service(s, 'media')),
      await requestsLine(env, service(s, 'requests')),
      sourceLine('media.tmdb', service(s, 'tmdb'), 'TMDB_API_KEY'),
      sourceLine('media.omdb', service(s, 'omdb'), 'OMDB_API_KEY'),
      playbackLine(service(s, 'playbackCheck')),
      encoderLine(service(s, 'encoder')),
    ];
  },
};
