// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Konwersje',
  intro: 'Ile filmów serwer może konwertować jednocześnie: filmy i seriale, telewizja na żywo, nagrania oraz pobrania łącznie.',
  used: '{u} z {l} zajętych',
  measured: 'Zmierzono {s}× czasu rzeczywistego ({engine})',
  liveSpeed: 'TV na żywo {s}×',
  recommended: 'zalecane {n}',
  checked: 'sprawdzono {when}',
  today: 'dziś {time}',
  remeasure: 'Zmierz ponownie',
  auto: 'Automatycznie ({n})',
  custom: 'Własna wartość',
  noRealtime: 'Serwer nie radzi sobie z konwersją w czasie rzeczywistym.',
  busyMeasure: 'Pomiar jest możliwy tylko wtedy, gdy nikt nie ogląda.',
  kind: {
    film: 'Film/serial',
    live: 'TV na żywo',
    record: 'Nagranie',
    else: 'Inne',
  },
  free: 'wolne',
  over: 'powyżej limitu',
  stale: 'Pomiar jest nieaktualny – zmierz ponownie',
  never: 'Jeszcze nie mierzono · do tego czasu {n}',
  measuring: 'Pomiar trwa… (ok. 20 s)',
  cpu: 'procesor',
  bar: 'Zajętość miejsc konwersji',
  running: {
    title: 'Trwa teraz',
    none: 'Teraz nic nie jest konwertowane.',
  },
  since: 'od {d}',
  slots: {
    label: 'Jednoczesne konwersje',
    value: 'Własna wartość w miejscach',
    less: 'Mniej',
    more: 'Więcej',
  },
  priority: {
    label: 'Pierwszeństwo',
    films: 'Najpierw filmy i seriale',
    live: 'Najpierw TV na żywo',
    equal: 'Równe',
    hint: {
      films: 'TV na żywo zostawia jedno miejsce wolne dla filmów i seriali (od 2 miejsc).',
      live: 'Filmy i seriale zostawiają jedno miejsce wolne dla TV na żywo (od 2 miejsc).',
      equal: 'Żadne miejsce nie jest rezerwowane – kto pierwszy, ten lepszy.',
    },
  },
  last: {
    ok: 'Ostatni pomiar udany',
    failed: 'Ostatni pomiar nieudany – spróbuj ponownie',
    no_title: 'Ostatni pomiar niemożliwy: brak odpowiedniego tytułu (SDR, od 720p do 1080p) w bibliotece',
    busy: 'Ostatni pomiar przerwany: ktoś oglądał',
    no_user: 'Ostatni pomiar niemożliwy: brak konta administratora do konwersji',
    unsupported: 'Pomiar tylko z Jellyfin',
  },
  err: {
    running: 'Pomiar już trwa.',
    busyUnknown: 'Serwer multimediów nie odpowiada, więc nie wiadomo, czy ktoś ogląda.',
    noUser: 'Nie ma konta administratora, na które serwer multimediów mógłby konwertować na potrzeby pomiaru.',
    unsupported: 'Pomiar tylko z Jellyfin',
    tooMany: 'Za dużo pomiarów w krótkim czasie. Spróbuj ponownie za kilka minut.',
    locked: 'Ustawione w środowisku – nie można tego zmienić tutaj.',
    loadFailed: 'Nie udało się wczytać konwersji.',
  },
  details: 'Do kontroli odtwarzania',
};
export default dict;
