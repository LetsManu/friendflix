// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** A live channel on a TV (live TV spec §13) as a cast session describes it; shared by the web engine and the app's cast bar source. */

/** `now` = the programme's title, `next` = the following one as "21:00 Wetter am Hafen" */
export interface LiveInfo { channelId: string; number: number | null; name: string; now?: string; next?: string }

/** the one way a session becomes a live one: `live` and `isLive` together, so the two never disagree */
export const liveFields = (live: LiveInfo): { live: LiveInfo; isLive: true } => ({ live, isLive: true });
