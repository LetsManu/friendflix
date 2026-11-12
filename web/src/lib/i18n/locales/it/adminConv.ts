// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Conversioni',
  intro: 'Quanti video il server può convertire contemporaneamente: film e serie, TV in diretta, registrazioni e download insieme.',
  used: '{u} su {l} in uso',
  measured: 'Misurato {s}× tempo reale ({engine})',
  liveSpeed: 'TV in diretta {s}×',
  recommended: 'consigliato {n}',
  checked: 'verificato {when}',
  today: 'oggi {time}',
  remeasure: 'Misura di nuovo',
  auto: 'Automatico ({n})',
  custom: 'Valore personalizzato',
  noRealtime: 'Il server non riesce a convertire in tempo reale.',
  busyMeasure: 'Misurare è possibile solo quando nessuno sta guardando.',
  kind: {
    film: 'Film/serie',
    live: 'TV in diretta',
    record: 'Registrazione',
    else: 'Altro',
  },
  free: 'libero',
  over: 'oltre il limite',
  stale: 'Misurazione obsoleta – misura di nuovo',
  never: 'Non ancora misurato · fino ad allora {n}',
  measuring: 'Misurazione in corso… (circa 20 s)',
  cpu: 'processore',
  bar: 'Uso dei posti di conversione',
  running: {
    title: 'In corso ora',
    none: 'Al momento non si sta convertendo nulla.',
  },
  since: 'da {d}',
  slots: {
    label: 'Conversioni contemporanee',
    value: 'Valore personalizzato in posti',
    less: 'Meno',
    more: 'Più',
  },
  priority: {
    label: 'Priorità',
    films: 'Prima film e serie',
    live: 'Prima la TV in diretta',
    equal: 'Pari priorità',
    hint: {
      films: 'La TV in diretta lascia un posto libero a film e serie (da 2 posti).',
      live: 'Film e serie lasciano un posto libero alla TV in diretta (da 2 posti).',
      equal: 'Nessun posto viene tenuto libero: chi arriva prima lo ottiene.',
    },
  },
  last: {
    ok: 'Ultima misurazione riuscita',
    failed: 'Ultima misurazione non riuscita – riprova',
    no_title: 'Ultima misurazione impossibile: nessun titolo adatto (SDR, da 720p a 1080p) nella libreria',
    busy: 'Ultima misurazione interrotta: qualcuno stava guardando',
    no_user: 'Ultima misurazione impossibile: nessun account amministratore con cui convertire',
    unsupported: 'Misurazione possibile solo con Jellyfin',
  },
  err: {
    running: 'Una misurazione è già in corso.',
    busyUnknown: 'Il media server al momento non risponde, quindi non è chiaro se qualcuno stia guardando.',
    noUser: 'Non c’è alcun account amministratore con cui il media server possa convertire per la misurazione.',
    unsupported: 'Misurazione possibile solo con Jellyfin',
    tooMany: 'Troppe misurazioni in poco tempo. Riprova tra qualche minuto.',
    locked: 'Impostato nell’ambiente – non modificabile qui.',
    loadFailed: 'Impossibile caricare le conversioni.',
  },
  details: 'Vai al controllo della riproduzione',
};
export default dict;
