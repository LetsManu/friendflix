// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Notifications',
  fresh: { one: '{n} nouvelle', many: '{n} nouvelles', other: '{n} nouvelles' },
  filter: { all: 'Toutes', unread: 'Non lues' },
  category: {
    downloads: 'Téléchargements',
    devices: 'Appareils',
    series: 'Séries et films',
    achievements: 'Succès',
    livetv: 'TV en direct',
    system: 'Système',
    requests: 'Demandes',
    social: 'Amis',
    misc: 'Autres',
  },
  section: { today: 'Aujourd’hui', week: 'Cette semaine' },
  action: { view: 'Voir', devices: 'Vérifier les appareils', update: 'Mettre à jour', open: 'Ouvrir' },
  readAll: 'Tout marquer comme lu',
  clearAll: 'Tout effacer',
  clearCategory: 'Effacer {category}',
  clearUnread: 'Effacer les non lues',
  cleared: { one: '{n} notification supprimée', many: '{n} notifications supprimées', other: '{n} notifications supprimées' },
  undo: 'Annuler',
  remove: 'Supprimer',
  empty: 'Aucune notification',
  end: 'C’est tout. Les notifications sont supprimées après {days} jours.',
  error: 'Impossible de charger les notifications.',
  retry: 'Réessayer',
  settings: 'Paramètres',
  close: 'Fermer',
  newLabel: 'nouvelle',
};
export default dict;
