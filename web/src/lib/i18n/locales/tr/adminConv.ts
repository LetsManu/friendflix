// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Dönüştürmeler',
  intro: 'Sunucunun aynı anda kaç videoyu dönüştürebileceği: filmler ve diziler, canlı TV ve kayıtlar birlikte.',
  used: '{u} / {l} kullanımda',
  measured: '{s}× gerçek zamanlı ölçüldü ({engine})',
  liveSpeed: 'Canlı TV {s}×',
  recommended: 'önerilen {n}',
  checked: 'denetlendi {when}',
  today: 'bugün {time}',
  remeasure: 'Yeniden ölç',
  auto: 'Otomatik ({n})',
  custom: 'Özel değer',
  noRealtime: 'Sunucu gerçek zamanlı dönüştürme yapamıyor.',
  busyMeasure: 'Ölçüm yalnızca kimse izlemiyorken yapılabilir.',
  kind: {
    film: 'Film/dizi',
    live: 'Canlı TV',
    record: 'Kayıt',
    else: 'Diğer',
  },
  free: 'boş',
  over: 'sınırın üzerinde',
  stale: 'Ölçüm eski – lütfen yeniden ölçün',
  never: 'Henüz ölçülmedi · o zamana kadar {n}',
  measuring: 'Ölçülüyor… (yaklaşık 20 sn)',
  cpu: 'işlemci',
  bar: 'Dönüştürme yerlerinin kullanımı',
  running: {
    title: 'Şu an çalışanlar',
    none: 'Şu anda hiçbir şey dönüştürülmüyor.',
  },
  since: '{d} önce başladı',
  slots: {
    label: 'Eşzamanlı dönüştürmeler',
    value: 'Yer sayısı olarak özel değer',
    less: 'Daha az',
    more: 'Daha çok',
  },
  priority: {
    label: 'Öncelik',
    films: 'Önce filmler ve diziler',
    live: 'Önce canlı TV',
    equal: 'Eşit',
    hint: {
      films: 'Canlı TV, filmler ve diziler için bir yer boş bırakır (2 veya daha fazla yerde).',
      live: 'Filmler ve diziler, canlı TV için bir yer boş bırakır (2 veya daha fazla yerde).',
      equal: 'Hiçbir yer boş tutulmaz – önce gelen alır.',
    },
  },
  last: {
    ok: 'Son ölçüm başarılı',
    failed: 'Son ölçüm başarısız – lütfen yeniden deneyin',
    no_title: 'Son ölçüm yapılamadı: kitaplıkta uygun başlık yok (SDR, 720p–1080p)',
    busy: 'Son ölçüm durduruldu: biri izliyordu',
    no_user: 'Son ölçüm yapılamadı: dönüştürmek için yönetici hesabı yok',
    unsupported: 'Ölçüm yalnızca Jellyfin ile yapılır',
  },
  err: {
    running: 'Bir ölçüm zaten sürüyor.',
    busyUnknown: 'Medya sunucusu şu anda yanıt vermiyor; bu yüzden birinin izleyip izlemediği belli değil.',
    noUser: 'Medya sunucusunun ölçüm için dönüştürme yapabileceği bir yönetici hesabı yok.',
    unsupported: 'Ölçüm yalnızca Jellyfin ile yapılır',
    tooMany: 'Kısa sürede çok fazla ölçüm. Lütfen birkaç dakika sonra yeniden deneyin.',
    locked: 'Ortamda ayarlanmış – burada değiştirilemez.',
    loadFailed: 'Dönüştürmeler yüklenemedi.',
  },
  details: 'Oynatma denetimine git',
};
export default dict;
