// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Bildirimler',
  fresh: { one: '{n} yeni', other: '{n} yeni' },
  filter: { all: 'Tümü', unread: 'Okunmamış' },
  category: {
    downloads: 'İndirmeler',
    devices: 'Cihazlar',
    series: 'Diziler ve filmler',
    achievements: 'Başarılar',
    livetv: 'Canlı TV',
    system: 'Sistem',
    requests: 'İstekler',
    social: 'Arkadaşlar',
    misc: 'Diğer',
  },
  section: { today: 'Bugün', week: 'Bu hafta' },
  action: { view: 'Görüntüle', devices: 'Cihazları kontrol et', update: 'Güncelle', open: 'Aç' },
  readAll: 'Tümünü okundu say',
  clearAll: 'Tümünü temizle',
  clearCategory: '{category} temizle',
  clearUnread: 'Okunmamışları temizle',
  cleared: { one: '{n} bildirim kaldırıldı', other: '{n} bildirim kaldırıldı' },
  undo: 'Geri al',
  remove: 'Kaldır',
  empty: 'Bildirim yok',
  end: 'Hepsi bu kadar. Bildirimler {days} gün sonra kaldırılır.',
  error: 'Bildirimler yüklenemedi.',
  retry: 'Tekrar dene',
  settings: 'Ayarlar',
  close: 'Kapat',
  newLabel: 'yeni',
  moreItems: { one: '+{n} tane daha', other: '+{n} tane daha' },
};
export default dict;
