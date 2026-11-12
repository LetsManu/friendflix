// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Conversions',
  intro: 'Combien de vidéos le serveur peut convertir en même temps : films et séries, TV en direct, enregistrements et téléchargements ensemble.',
  used: '{u} sur {l} utilisées',
  measured: 'Mesuré {s}× temps réel ({engine})',
  liveSpeed: 'TV en direct {s}×',
  recommended: 'recommandé {n}',
  checked: 'vérifié {when}',
  today: 'aujourd’hui {time}',
  remeasure: 'Mesurer à nouveau',
  auto: 'Automatique ({n})',
  custom: 'Valeur personnalisée',
  noRealtime: 'Le serveur ne sait pas convertir en temps réel.',
  busyMeasure: 'La mesure n’est possible que si personne ne regarde.',
  kind: {
    film: 'Film/série',
    live: 'TV en direct',
    record: 'Enregistrement',
    else: 'Autres',
  },
  free: 'libre',
  over: 'au-dessus de la limite',
  stale: 'Mesure périmée – merci de mesurer à nouveau',
  never: 'Pas encore mesuré · {n} d’ici là',
  measuring: 'Mesure en cours… (environ 20 s)',
  cpu: 'processeur',
  bar: 'Occupation des places de conversion',
  running: {
    title: 'En cours',
    none: 'Rien n’est converti pour le moment.',
  },
  since: 'depuis {d}',
  slots: {
    label: 'Conversions simultanées',
    value: 'Valeur personnalisée en places',
    less: 'Moins',
    more: 'Plus',
  },
  priority: {
    label: 'Priorité',
    films: 'Films et séries d’abord',
    live: 'TV en direct d’abord',
    equal: 'À égalité',
    hint: {
      films: 'La TV en direct laisse une place libre aux films et séries (à partir de 2 places).',
      live: 'Les films et séries laissent une place libre à la TV en direct (à partir de 2 places).',
      equal: 'Aucune place n’est gardée libre : le premier arrivé la prend.',
    },
  },
  last: {
    ok: 'Dernière mesure réussie',
    failed: 'Dernière mesure échouée – merci de réessayer',
    no_title: 'Dernière mesure impossible : aucun titre adapté (SDR, 720p à 1080p) dans la médiathèque',
    busy: 'Dernière mesure interrompue : quelqu’un regardait',
    no_user: 'Dernière mesure impossible : aucun compte administrateur pour convertir',
    unsupported: 'Mesure possible uniquement avec Jellyfin',
  },
  err: {
    running: 'Une mesure est déjà en cours.',
    busyUnknown: 'Le serveur multimédia ne répond pas pour le moment : impossible de savoir si quelqu’un regarde.',
    noUser: 'Aucun compte administrateur ne permet au serveur multimédia de convertir pour la mesure.',
    unsupported: 'Mesure possible uniquement avec Jellyfin',
    tooMany: 'Trop de mesures en peu de temps. Réessayez dans quelques minutes.',
    locked: 'Défini dans l’environnement – non modifiable ici.',
    loadFailed: 'Impossible de charger les conversions.',
  },
  details: 'Vers le test de lecture',
};
export default dict;
