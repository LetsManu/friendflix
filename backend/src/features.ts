// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { castEnabled } from './cast.js';
import type { Ctx } from './ctx.js';
import { livetvInstalled } from './livetv/detect.js';
import { requestsEnabled } from './seerr/client.js';

/** which optional features this install has (the editor hides the rows of absent ones); livetv = the optional container answers (detection, 60 s) */
export function featureFlags(ctx: Ctx): { requests: boolean; cast: boolean; livetv: boolean } {
  return { requests: requestsEnabled(ctx), cast: castEnabled(ctx), livetv: livetvInstalled(ctx) };
}
