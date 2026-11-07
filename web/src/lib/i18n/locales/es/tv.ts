// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menú principal', profile: 'Cambiar de perfil, {name}', account: 'Cuenta' },
  tile: { top10: 'Top 10 · n.º {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Empezar de nuevo', episodes: 'Episodios y temporadas', collection: 'Colección', with: 'Con: {names}', actions: 'Acciones' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Volver', seasons: 'Temporadas', none: 'Ahora mismo no hay nada aquí.' },
  /** player (spec 4): the pause screen eyebrow, remaining time, the episode line under the title */
  player: { watching: 'Estás viendo', remaining: '−{time}', episode: 'T{s} E{e} · {name}' },
};
export default dict;
