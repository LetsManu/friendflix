// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { admitConversion, bindConvGrant, dropConvGrant, sharedSessionRead } from './convbudget.js';
import { HEVC_SESSIONS_TIMEOUT_MS, bindHevcGrant, hevcGate } from './hevcenc.js';
import type { HevcGate, PlaybackDto } from './media/types.js';

type Admission = { ok: true } | { ok: false; why: 'full' | 'unknown' };

/**
 * A stream of this play session is gone (stopped, or its cast token taken back): its HEVC and budget grants go with it, so a stopped
 * stream does not hold a slot for the rest of its 30-s grant (the server no longer lists it, so the grant alone would count it).
 */
export const releaseGrants = async (ctx: Ctx, playSessionId: string): Promise<void> => {
  await Promise.all([dropConvGrant(ctx, playSessionId), bindHevcGrant(ctx, playSessionId, null)]);
};

/** Ruling 6: only an answer that converts the picture on the server is admitted (direct play and a copy are never gated). */
export const convertsOf = (info: PlaybackDto): boolean => !info.directUrl && Boolean(info.delivery) && info.delivery!.video !== 'copy';

/**
 * Owner ruling of 2026-11-12: the budget's copy fallback carries the source at its own bitrate. It is offered only to a request that asked
 * for at least that much; a request whose own cap (`cap`, the viewer's pick or line: data saver, a lower quality, ABR on a slow line) lies
 * below the source gets `503 server_busy` instead of a copy above what it asked for. An unknown source bitrate counts as above (never a copy
 * of unknown size for a viewer who asked for less).
 */
export const copyFitsCap = (info: Pick<PlaybackDto, 'sourceBitrate'>, cap: number): boolean => info.sourceBitrate !== undefined && info.sourceBitrate <= cap;

/**
 * The conversion gate of one film playback or cast request (spec §5.5, rulings 6 and 7). One grant id serves the HEVC gate
 * (`hevcgrant:`) and the budget (`conv:grant:`); both gates share one session-list read (sharedSessionRead), and the budget is asked at
 * most once per request, so their worst cases do not add up:
 *  - `hevc`: the closure for PlaybackOptions.hevcGate. The HEVC gate and the budget admission run in parallel; a budget refusal drops
 *    the HEVC grant and answers `h264_busy` (the plan falls back to H.264, which needs the same budget slot: the same refusal applies).
 *  - `admit`: after playbackInfo: may this answer be given? A copy or direct play always; a conversion when the budget admits it (the
 *    closure's answer when it asked already). false: the caller asks again with `noConvert` (copy fallback) or answers 503.
 *  - `bind`: the grants follow the answer given (null: nothing is given, both are dropped). Never stops a running conversion.
 *  - `release`: an error after `bind` (the cast token was taken back, its mint failed): the bound grants of that play session go.
 * `label` (title; a series by its series name): given at construction, or to `admit` / `bind` when it is known only later.
 * `swap`: a hover / focus prefetch of /api/playback/info (body `prefetch`): this grant replaces the device's own unused prefetch grants
 * (admitConversion). A player's grant never has it, so no prefetch can drop it.
 */
export interface FilmGate {
  hevc: () => Promise<HevcGate>;
  admit: (info: PlaybackDto, label?: string) => Promise<boolean>;
  bind: (info: PlaybackDto | null, label?: string) => Promise<void>;
  release: (playSessionId: string) => Promise<void>;
}

export function filmGate(ctx: Ctx, o: { userId: string; deviceId?: string; label?: string; swap?: boolean }): FilmGate {
  const grantId = randomUUID();
  const sessions = sharedSessionRead(ctx, HEVC_SESSIONS_TIMEOUT_MS);
  // A request without a device id (no session device) is its own "device": user + this request's id. Its own grants never count against
  // it, and it never hides or replaces a grant of another request of the same account. (Leaving the own-device rule out by user alone
  // would hide another app's or tab's real grants of that account: an undercount. This way an earlier deviceless request's grant still
  // counts until it is bound, released or its 30 s end: the safe direction.)
  const device = o.deviceId ?? `req:${grantId}`;
  let budget: Promise<Admission> | undefined;
  const ask = (hevc: boolean, label = o.label): Promise<Admission> => (budget ??= admitConversion(ctx, {
    kind: 'film', userId: o.userId, deviceId: device, hint: grantId, ...(hevc ? { hevc: true } : {}), ...(label ? { label } : {}), ...(o.swap ? { swap: true } : {}), sessions,
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
    admit: async (info, label = o.label) => (convertsOf(info) ? (await ask(info.delivery!.video === 'hevc', label)).ok : true),
    bind: async (info, label = o.label) => {
      const hevc = info?.delivery?.video === 'hevc';
      await Promise.all([
        bindHevcGrant(ctx, grantId, info && hevc ? info.playSessionId : null), // a grant only lives on for a stream that converts
        bindConvGrant(ctx, grantId, info && convertsOf(info) ? info.playSessionId : null, { hevc, ...(label ? { label } : {}) }),
      ]);
    },
    release: (playSessionId) => releaseGrants(ctx, playSessionId),
  };
}
