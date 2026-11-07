// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** area 'tv': TV mode (side-bar rail); German source. */
export default {
  rail: { label: 'Hauptmenü', profile: 'Profil wechseln, {name}' },
  tile: { top10: 'Top 10 · Platz {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Von vorne', episodes: 'Folgen & Staffeln', collection: 'Filmreihe', with: 'Mit: {names}', actions: 'Aktionen' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Zurück', seasons: 'Staffeln', none: 'Hier ist gerade nichts.' },
} as const;
