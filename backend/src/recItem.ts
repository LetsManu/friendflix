// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A FriendFlix recording as an item id (Live TV Phase 3): `rec:<uuid>` in hand-off rows, the TV remote's `cast` and the TV's status.
 * One definition with no imports, so the remote hub and the hand-off share it without an import cycle.
 */
export const REC_ITEM_RE = /^rec:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** the longest a recording plays (its token cap, livetv/tokens.ts REC_CAP_S): a position up to this travels */
export const REC_MAX_S = 28 * 3600;
