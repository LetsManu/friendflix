// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

export type DetailTab = 'episodes' | 'more' | 'extras' | 'details';

export function detailTabs(o: { series: boolean; similar: number; extras: number }): DetailTab[] {
  const tabs: DetailTab[] = [];
  if (o.series) tabs.push('episodes');
  if (o.similar > 0) tabs.push('more');
  if (o.extras > 0) tabs.push('extras');
  tabs.push('details');
  return tabs;
}
