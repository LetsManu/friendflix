// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Notifiche',
  fresh: { one: '{n} nuova', many: '{n} nuove', other: '{n} nuove' },
  filter: { all: 'Tutte', unread: 'Non lette' },
  category: {
    downloads: 'Download',
    devices: 'Dispositivi',
    series: 'Serie e film',
    achievements: 'Traguardi',
    livetv: 'TV in diretta',
    system: 'Sistema',
    requests: 'Richieste',
    social: 'Amici',
    misc: 'Altro',
  },
  section: { today: 'Oggi', week: 'Questa settimana' },
  action: { view: 'Guarda', devices: 'Controlla i dispositivi', update: 'Aggiorna', open: 'Apri' },
  readAll: 'Segna tutte come lette',
  clearAll: 'Cancella tutto',
  clearCategory: 'Cancella {category}',
  clearUnread: 'Cancella non lette',
  cleared: { one: '{n} notifica rimossa', many: '{n} notifiche rimosse', other: '{n} notifiche rimosse' },
  undo: 'Annulla',
  remove: 'Rimuovi',
  empty: 'Nessuna notifica',
  end: 'È tutto. Le notifiche vengono rimosse dopo {days} giorni.',
  error: 'Impossibile caricare le notifiche.',
  retry: 'Riprova',
  settings: 'Impostazioni',
  close: 'Chiudi',
  newLabel: 'nuova',
  moreItems: { one: '+{n} altra', many: '+{n} altre', other: '+{n} altre' },
};
export default dict;
