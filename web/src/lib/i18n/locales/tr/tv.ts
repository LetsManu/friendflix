// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Ana menü', profile: 'Profil değiştir, {name}', account: 'Hesap' },
  tile: { top10: 'Top 10 · {n}. sıra' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Baştan başlat', episodes: 'Bölümler ve sezonlar', collection: 'Koleksiyon', with: 'Oyuncular: {names}', actions: 'İşlemler' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Geri', seasons: 'Sezonlar', none: 'Şu anda burada bir şey yok.' },
  /** player (spec 4): the pause screen eyebrow, remaining time, the episode line under the title */
  player: { watching: 'Şu an izliyorsunuz', remaining: '−{time}', episode: 'S{s} B{e} · {name}' },
};
export default dict;
