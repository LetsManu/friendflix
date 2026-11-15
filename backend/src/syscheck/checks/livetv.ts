// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { bounded } from '../../health.js';
import { detectLivetv, livetvSystem, readLivetvSystem, type LivetvState } from '../../livetv/detect.js';
import { gpuAdvice, type GpuAdvice } from '../../livetv/gpu.js';
import { EPG_MAX_AGE_MS, REFRESH_INTERVAL_MS } from '../../livetv/refresh.js';
import { readHwAccel } from '../../livetv/status.js';
import type { CheckEnv, GroupCheck } from '../engine.js';
import { bad, line, type LineOpts } from '../line.js';
import { CHECK_TIMEOUT_MS, type CheckId, type CheckLine } from '../types.js';

/**
 * Live-TV: whether the optional livetv container answers (detect.ts), its GPU advice (gpu.ts, the same rule as Admin → Live-TV), and
 * the lists and guides in `livetv_sources`. Live TV that was never turned on is not set up everywhere (never red); turned on but not
 * answering is a problem, and the lines that need it read "not checked" until it answers. Names, URLs and error texts of the lists
 * never leave this file: only counts.
 */
const PAGE = '/admin/livetv';
const DOCS_GPU = 'livetv.md#gpu';
/** a list whose last good refresh is older than twice its interval, but at least this, is stale (one missed nightly run is fine) */
const STALE_MIN_MS = 26 * 3600_000;
/** what is kept back of the group's limit for building the answer */
const SPARE_MS = 300;

/** the GPU advice that is a warning, as line codes (lower case: the engine drops anything else) */
const GPU: Partial<Record<GpuAdvice['key'], LineOpts>> = {
  needsOverlay: { cause: 'gpu_needs_overlay', fix: 'gpu_needs_overlay' },
  needsRenderGid: { cause: 'gpu_needs_render_gid', fix: 'gpu_needs_render_gid' },
  needsNvidia: { cause: 'gpu_needs_nvidia', fix: 'gpu_needs_nvidia' },
};

interface SourceStats { lists: number; listsFailed: number; listsStale: number; guides: number; guidesFailed: number; guidesStale: number }

/** counts over the enabled lists and guides (an own-feeds source has neither a list to fetch nor a guide) */
async function sourceStats(env: CheckEnv): Promise<SourceStats> {
  const r = await env.ctx.db.query<{
    kind: string; refresh: string; has_url: boolean; has_epg: boolean; file_guide: boolean; has_file: boolean;
    last_ok_at: Date | null; last_error: string | null; epg_last_ok_at: Date | null; epg_last_error: string | null;
  }>(`select kind, refresh, url_enc is not null as has_url, epg_url_enc is not null as has_epg,
            (kind = 'guide' and guide_provider = 'xmltv_file') as file_guide, guide_file is not null as has_file,
            last_ok_at, last_error, epg_last_ok_at, epg_last_error
       from livetv_sources where enabled`);
  const now = Date.now();
  const s: SourceStats = { lists: 0, listsFailed: 0, listsStale: 0, guides: 0, guidesFailed: 0, guidesStale: 0 };
  for (const row of r.rows) {
    if (row.kind === 'm3u' && row.has_url) {
      s.lists++;
      if (row.last_error) s.listsFailed++;
      else if (row.refresh !== 'manual' && row.last_ok_at) {
        const every = REFRESH_INTERVAL_MS[row.refresh as keyof typeof REFRESH_INTERVAL_MS] ?? EPG_MAX_AGE_MS;
        if (now - row.last_ok_at.getTime() > Math.max(2 * every, STALE_MIN_MS)) s.listsStale++;
      }
    }
    // a list's own guide, an extra guide by link, or an uploaded guide once its file is stored (refresh.ts hasEpg)
    const guide = row.kind === 'guide' ? (row.file_guide ? row.has_file : row.has_epg) : row.kind === 'm3u' && row.has_epg;
    if (!guide) continue;
    s.guides++;
    if (row.epg_last_error) s.guidesFailed++;
    // an uploaded guide changes only with an upload: never stale on its own
    else if (!row.file_guide && row.epg_last_ok_at && now - row.epg_last_ok_at.getTime() > 2 * EPG_MAX_AGE_MS) s.guidesStale++;
  }
  return s;
}

function containerLine(env: CheckEnv, det: LivetvState): CheckLine {
  const id = 'livetv.container';
  if (det.installed && det.reachable) return line(id, 'ok');
  // turned on (or seen running before) and not answering: down for everyone who watches
  if (env.ctx.cfg.LIVETV_WANTED === 'true' || det.installed) return bad(id, 'problem', 'livetv_down', { href: PAGE, docs: 'livetv.md#troubleshooting' });
  return bad(id, 'not_set_up', 'livetv_not_set', { href: PAGE });
}

async function encoderLine(env: CheckEnv, budgetMs: number): Promise<CheckLine> {
  const id = 'livetv.encoder';
  if (budgetMs < 200) return line(id, 'unknown', { cause: 'check_timeout' });
  const o = await bounded(() => Promise.all([
    env.fresh ? readLivetvSystem(env.ctx).catch(() => null) : livetvSystem(env.ctx),
    readHwAccel(env.ctx),
  ]), budgetMs);
  if (!o.ok) return line(id, 'unknown', { cause: o.timeout ? 'check_timeout' : 'check_failed' });
  const [sys, hw] = o.v;
  if (!sys) return bad(id, 'unknown', 'livetv_no_system', { href: PAGE });
  if (hw === null) {
    // Plex has nothing to compare with: livetv itself answers, so it runs; Jellyfin that did not say (down, slow) is not checked
    return env.ctx.jf.admin.encoderSettings ? line(id, 'unknown', { cause: 'check_unavailable' }) : line(id, 'ok');
  }
  const advice = gpuAdvice(hw, sys);
  const gpu = advice.level === 'warn' ? GPU[advice.key] : undefined;
  return gpu ? line(id, 'warning', { ...gpu, settingKey: 'LIVETV_ENCODER', docs: DOCS_GPU }) : line(id, 'ok');
}

function sourcesLine(s: SourceStats): CheckLine {
  const id = 'livetv.sources';
  if (!s.lists) return bad(id, 'not_set_up', 'sources_none', { href: PAGE });
  if (s.listsFailed) return bad(id, 'warning', 'sources_failed', { href: PAGE, params: { n: s.listsFailed } });
  if (s.listsStale) return bad(id, 'warning', 'sources_stale', { href: PAGE, params: { n: s.listsStale } });
  return line(id, 'ok');
}

function guidesLine(s: SourceStats): CheckLine {
  const id = 'livetv.guides';
  if (!s.guides) return bad(id, 'not_set_up', 'guides_none', { href: PAGE });
  if (s.guidesFailed) return bad(id, 'warning', 'guides_failed', { href: PAGE, params: { n: s.guidesFailed } });
  if (s.guidesStale) return bad(id, 'warning', 'guides_stale', { href: PAGE, params: { n: s.guidesStale } });
  return line(id, 'ok');
}

const DEPENDENT: readonly CheckId[] = ['livetv.encoder', 'livetv.sources', 'livetv.guides'];

export const livetvCheck: GroupCheck = {
  group: 'livetv',
  ids: ['livetv.container', ...DEPENDENT],
  timeoutMs: CHECK_TIMEOUT_MS,
  async run(env) {
    const t0 = performance.now();
    // the lists and guides are read from the start, alongside: a stalled database leaves them unread, never the encoder or the group
    const statsP = bounded(() => sourceStats(env), env.timeoutMs - 2 * SPARE_MS);
    // Jetzt prüfen asks livetv now; a page load takes the detection of the last 10 s (the minute tick keeps it current)
    const container = containerLine(env, await detectLivetv(env.ctx, env.fresh ? 0 : 10_000));
    if (container.status === 'not_set_up') return [container, ...DEPENDENT.map((id) => line(id, 'not_set_up', { cause: 'livetv_off', href: PAGE }))];
    if (container.status !== 'ok') return [container, ...DEPENDENT.map((id) => line(id, 'unknown', { cause: 'livetv_needed' }))];
    const left = env.timeoutMs - (performance.now() - t0) - SPARE_MS;
    const [encoder, stats] = await Promise.all([encoderLine(env, left), statsP]);
    const unread = (id: CheckId) => bad(id, 'unknown', 'check_unavailable');
    return [container, encoder, stats.ok ? sourcesLine(stats.v) : unread('livetv.sources'), stats.ok ? guidesLine(stats.v) : unread('livetv.guides')];
  },
};
