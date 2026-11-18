// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Area 'notes' (German source): the notifications center (the side sheet at the bell, lib/notifications). */
export default {
  title: 'Benachrichtigungen',
  fresh: { one: '{n} neu', other: '{n} neu' },
  filter: { all: 'Alle', unread: 'Ungelesen' },
  /** per category (lib/notifications/look.ts categoryKey); 'other' is `misc` here, as an `other` key would read as plural forms */
  category: {
    downloads: 'Downloads',
    devices: 'Geräte',
    series: 'Serien & Filme',
    achievements: 'Achievements',
    livetv: 'Live TV',
    system: 'System',
    requests: 'Wünsche',
    social: 'Freunde',
    misc: 'Sonstiges',
  },
  section: { today: 'Heute', week: 'Diese Woche' },
  action: { view: 'Ansehen', devices: 'Geräte prüfen', update: 'Aktualisieren', open: 'Öffnen' },
  readAll: 'Alle gelesen',
  clearAll: 'Alles leeren',
  clearCategory: '{category} leeren',
  clearUnread: 'Ungelesene leeren',
  cleared: { one: '{n} Benachrichtigung entfernt', other: '{n} Benachrichtigungen entfernt' },
  undo: 'Rückgängig',
  remove: 'Entfernen',
  empty: 'Keine Benachrichtigungen',
  end: 'Das waren alle. Benachrichtigungen werden nach {days} Tagen entfernt.',
  error: 'Benachrichtigungen konnten nicht geladen werden.',
  retry: 'Nochmal',
  settings: 'Einstellungen',
  close: 'Schließen',
  newLabel: 'neu',
} as const;
