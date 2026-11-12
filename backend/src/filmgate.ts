// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { admitConversion, bindConvGrant, sharedSessionRead } from './convbudget.js';
import { HEVC_SESSIONS_TIMEOUT_MS, bindHevcGrant, hevcGate } from './hevcenc.js';
import type { HevcGate, PlaybackDto } from './media/types.js';

type Admission = { ok: true } | { ok: false; why: 'full' | 'unknown' };

/** Ruling 6: only an answer that converts the picture on the server is admitted (direct play and a copy are never gated). */
export const convertsOf = (info: PlaybackDto): boolean => !info.directUrl && Boolean(info.delivery) && info.delivery!.video !== 'copy';

/**
 * The conversion gate of one film playback or cast request (spec §5.5, rulings 6 and 7). One grant id serves the HEVC gate
 * (`hevcgrant:`) and the budget (`conv:grant:`); both gates share one session-list read (sharedSessionRead), and the budget is asked at
 * most once per request, so their worst cases do not add up:
 *  - `hevc`: the closure for PlaybackOptions.hevcGate. The HEVC gate and the budget admission run in parallel; a budget refusal drops
 *    the HEVC grant and answers `h264_busy` (the plan falls back to H.264, which needs the same budget slot: the same refusal applies).
 *  - `admit`: after playbackInfo: may this answer be given? A copy or direct play always; a conversion when the budget admits it (the
 *    closure's answer when it asked already). false: the caller asks again with `noConvert` (copy fallback) or answers 503.
 *  - `bind`: the grants follow the answer given (null: nothing is given, both are dropped). Never stops a running conversion.
 */
export interface FilmGate {
  hevc: () => Promise<HevcGate>;
  admit: (info: PlaybackDto) => Promise<boolean>;
  bind: (info: PlaybackDto | null) => Promise<void>;
}

export function filmGate(ctx: Ctx, o: { userId: string; deviceId?: string; label?: string }): FilmGate {
  const grantId = randomUUID();
  const sessions = sharedSessionRead(ctx, HEVC_SESSIONS_TIMEOUT_MS);
  let budget: Promise<Admission> | undefined;
  const ask = (hevc: boolean): Promise<Admission> => (budget ??= admitConversion(ctx, {
    kind: 'film', userId: o.userId, ...(o.deviceId ? { deviceId: o.deviceId } : {}), hint: grantId, ...(hevc ? { hevc: true } : {}), ...(o.label ? { label: o.label } : {}), sessions,
  }).catch((): Admission => ({ ok: false, why: 'unknown' })));
  return {
    hevc: async () => {
      const [h, b] = await Promise.all([
        hevcGate(ctx, { userId: o.userId, deviceId: o.deviceId, playSessionIdHint: grantId, sessions }).catch((): HevcGate => ({ ok: false, why: 'h264_busy' })),
        ask(true),
      ]);
      if (h.ok && !b.ok) {
        await bindHevcGrant(ctx, grantId, null);
        return { ok: false, why: 'h264_busy' };
      }
      return h;
    },
    admit: async (info) => (convertsOf(info) ? (await ask(info.delivery!.video === 'hevc')).ok : true),
    bind: async (info) => {
      const hevc = info?.delivery?.video === 'hevc';
      await Promise.all([
        bindHevcGrant(ctx, grantId, info && hevc ? info.playSessionId : null), // a grant only lives on for a stream that converts
        bindConvGrant(ctx, grantId, info && convertsOf(info) ? info.playSessionId : null, { hevc, ...(o.label ? { label: o.label } : {}) }),
      ]);
    },
  };
}
