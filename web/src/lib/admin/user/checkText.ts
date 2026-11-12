// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The *Kurzfassung* of the Sicht prüfen tab (spec §6.4): plain sentences from the effective rights of one profile, one translation key each. */
import { fmtList, fmtNumber, tr, trDynamic } from '#lib/i18n';
import type { RightsRow } from './rights';

/** the switches the summary names, in this order (Live TV is not part of Phase 0) */
const PERMS = ['requests', 'cast', 'party', 'partySchedule', 'comments'] as const;
/** a kids profile never has these; its own sentence says so */
const KIDS_OFF: ReadonlySet<string> = new Set(['party', 'partySchedule', 'comments']);

/**
 * `rows` are the effective rights of the profile (`GET /rights?profile=`, the kids overlay included), `libs` the libraries it sees of all,
 * `kids` the kids profile's age limit (null = a grown-up's profile). A field without a row, or without a limit, has no sentence.
 */
export function summarySentences(name: string, rows: RightsRow[], libs: { visible: number; total: number }, kids: { maxRating: 0 | 6 | 12 } | null): string[] {
  const v = (k: string): unknown => rows.find((r) => r.key === k)?.value;
  const out: string[] = [];
  out.push(libs.visible >= libs.total ? tr('adminPeople.check.s.libsAll', { name }) : tr('adminPeople.check.s.libsSome', { name, n: libs.visible, m: libs.total }));
  if (kids) out.push(tr('adminPeople.check.s.kids', { n: kids.maxRating }));
  else {
    const cap = v('maxParentalRating');
    out.push(typeof cap === 'number' ? tr('adminPeople.check.s.ratingCap', { n: cap }) : tr('adminPeople.check.s.ratingAll'));
  }
  const streams = v('maxStreams');
  if (typeof streams === 'number') out.push(tr('adminPeople.check.s.streams', { n: streams }));
  const remote = v('remoteMaxBitrate');
  if (typeof remote === 'number') out.push(tr('adminPeople.check.s.remote', { mbit: fmtNumber(Math.round((remote / 1_000_000) * 10) / 10, { maximumFractionDigits: 1 }) }));
  const dl = v('download');
  if (typeof dl === 'boolean') out.push(tr(dl ? 'adminPeople.check.s.downloadYes' : 'adminPeople.check.s.downloadNo'));
  const known = PERMS.filter((k) => typeof v(k) === 'boolean' && !(kids && KIDS_OFF.has(k)));
  const label = (k: string) => trDynamic(`adminPeople.check.perm.${k}`);
  const yes = known.filter((k) => v(k) === true).map(label), no = known.filter((k) => v(k) === false).map(label);
  if (yes.length) out.push(tr('adminPeople.check.s.permsYes', { list: fmtList(yes) }));
  if (no.length) out.push(tr('adminPeople.check.s.permsNo', { list: fmtList(no) }));
  return out;
}
