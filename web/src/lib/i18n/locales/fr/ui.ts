// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/ui';
import type { Translation } from '../../types';

/** Français – zone « ui » (kit d’interface partagé). */
const dict: Translation<typeof de> = {
  done: 'C’est fait.',
  undo: 'Annuler',
  undone: 'Action annulée.',
  retry: 'Réessayer',
  dismiss: 'Fermer la notification',
  notifications: 'Notifications',
  errorPrefix: 'Erreur :',
  /** the toast action's keyboard shortcut (its accessible description) */
  actionShortcut: 'Raccourci clavier : {key}',
  percent: '{n} %',
  confirm: {
    ok: 'Confirmer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    typeToConfirm: 'Saisissez « {word} » pour confirmer',
  },
  error: {
    generic: 'Cela n’a pas fonctionné.',
    network: 'Pas de connexion au serveur.',
    forbidden: 'Vous n’avez pas l’autorisation de faire cela.',
    castForbidden: 'La diffusion sur un téléviseur n’est pas activée pour votre compte.',
    partyForbidden: 'Les watch parties ne sont pas activées pour votre compte.',
    requestsForbidden: 'Les demandes ne sont pas activées pour votre compte.',
    notFound: 'Cet élément n’existe pas (ou plus).',
    conflict: 'Impossible pour le moment – quelque chose a changé entre-temps.',
    tooMany: 'Trop de tentatives. Veuillez patienter un instant.',
    server: 'Erreur du serveur. Veuillez réessayer plus tard.',
  },
  table: {
    filter: 'Filtrer le tableau',
    filterPlaceholder: 'Rechercher…',
    clearFilter: 'Effacer le filtre',
    sortAsc: '(tri croissant)',
    sortDesc: '(tri décroissant)',
    empty: 'Aucune entrée.',
    noMatch: 'Aucun résultat pour « {q} ».',
    loading: 'Chargement…',
    range: '{from}–{to} sur {total}',
    pages: 'Pages',
    prev: 'Page précédente',
    next: 'Page suivante',
    actions: 'Actions',
    actionsFor: 'Actions pour {name}',
  },
  copy: {
    copy: 'Copier',
    copied: 'Copié dans le presse-papiers.',
    failed: 'Copie impossible – sélectionnez le texte et copiez-le manuellement.',
    qr: 'Code QR',
    qrShow: 'Afficher le code QR',
    qrHide: 'Masquer le code QR',
  },
};
export default dict;
