// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Ana menü', profile: 'Profil değiştir, {name}' },
  tile: { top10: 'Top 10 · {n}. sıra' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Baştan başlat', episodes: 'Bölümler ve sezonlar', collection: 'Koleksiyon', with: 'Oyuncular: {names}', actions: 'İşlemler' },
};
export default dict;
