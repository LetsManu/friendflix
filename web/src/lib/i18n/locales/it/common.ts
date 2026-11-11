// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/common';
import type { Translation } from '../../types';

/** Italian – area "common". Missing keys fall back to German (docs/i18n.md). */
const it: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  save: 'Salva',
  saving: 'Salvataggio…',
  saved: 'Salvato',
  saveFailed: 'Salvataggio non riuscito.',
  failed: 'Qualcosa non ha funzionato.',
  cancel: 'Annulla',
  close: 'Chiudi',
  done: 'Fatto',
  delete: 'Elimina',
  edit: 'Modifica',
  retry: 'Riprova',
  loading: 'Caricamento…',
  more: 'Altro',
  continue: 'Continua',
  later: 'Più tardi',
  preview: 'Anteprima',
  on: 'Sì',
  off: 'No',
  standard: 'Predefinito',
  unknown: 'sconosciuto',
  /** client kinds of the hand-off display rule; airplay/chromecast wrap the sending device's name */
  deviceKind: {
    tizen: 'TV Samsung',
    webos: 'TV LG',
    firetv: 'Fire TV',
    desktop: 'App Windows',
    android: 'App Android',
    airplay: 'AirPlay ({sender})',
    chromecast: 'Chromecast ({sender})',
  },
  movies: 'Film',
  series: 'Serie TV',
  duration: { hm: '{h} h {m} min', h: '{h} h', m: '{m} min', s: '{s} s' },
  rating: {
    rate: 'Valuta',
    notForMe: 'Così così',
    like: 'Bene',
    love: 'Adorato',
    rated: 'Valutazione: {label} – modifica la valutazione',
    remove: '{label} (rimuovi la valutazione)',
    saveFailed: 'Impossibile salvare la valutazione.',
  },
  language: {
    label: 'Lingua',
  },
  experimental: 'Sperimentale',
};
export default it;
