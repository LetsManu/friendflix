// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Powiadomienia',
  fresh: { one: '{n} nowe', few: '{n} nowe', many: '{n} nowych', other: '{n} nowego' },
  filter: { all: 'Wszystkie', unread: 'Nieprzeczytane' },
  category: {
    downloads: 'Pobrane',
    devices: 'Urządzenia',
    series: 'Seriale i filmy',
    achievements: 'Osiągnięcia',
    livetv: 'Telewizja na żywo',
    system: 'System',
    requests: 'Życzenia',
    social: 'Znajomi',
    misc: 'Inne',
  },
  section: { today: 'Dziś', week: 'Ten tydzień' },
  action: { view: 'Zobacz', devices: 'Sprawdź urządzenia', update: 'Zaktualizuj', open: 'Otwórz' },
  readAll: 'Oznacz wszystkie jako przeczytane',
  clearAll: 'Wyczyść wszystko',
  clearCategory: 'Wyczyść: {category}',
  clearUnread: 'Wyczyść nieprzeczytane',
  cleared: { one: 'Usunięto {n} powiadomienie', few: 'Usunięto {n} powiadomienia', many: 'Usunięto {n} powiadomień', other: 'Usunięto {n} powiadomienia' },
  undo: 'Cofnij',
  remove: 'Usuń',
  empty: 'Brak powiadomień',
  end: 'To już wszystko. Powiadomienia są usuwane po {days} dniach.',
  error: 'Nie udało się wczytać powiadomień.',
  retry: 'Spróbuj ponownie',
  settings: 'Ustawienia',
  close: 'Zamknij',
  newLabel: 'nowe',
};
export default dict;
