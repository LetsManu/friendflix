// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CastSession } from './engine';

/** The cast bar shows while a title plays on a TV, except on the immersive pages (watch, party) and in TV mode. */
export function barVisible(o: { path: string; tv: boolean; session: CastSession | null }): boolean {
  return o.session !== null && !o.tv && !/^\/(watch|party)\//.test(o.path);
}
