// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Notificaciones',
  fresh: { one: '{n} nueva', many: '{n} nuevas', other: '{n} nuevas' },
  filter: { all: 'Todas', unread: 'No leídas' },
  category: {
    downloads: 'Descargas',
    devices: 'Dispositivos',
    series: 'Series y películas',
    achievements: 'Logros',
    livetv: 'TV en directo',
    system: 'Sistema',
    requests: 'Peticiones',
    social: 'Amigos',
    misc: 'Otras',
  },
  section: { today: 'Hoy', week: 'Esta semana' },
  action: { view: 'Ver', devices: 'Revisar dispositivos', update: 'Actualizar', open: 'Abrir' },
  readAll: 'Marcar todas como leídas',
  clearAll: 'Borrar todo',
  clearCategory: 'Borrar {category}',
  clearUnread: 'Borrar no leídas',
  cleared: { one: '{n} notificación eliminada', many: '{n} notificaciones eliminadas', other: '{n} notificaciones eliminadas' },
  undo: 'Deshacer',
  remove: 'Quitar',
  empty: 'No hay notificaciones',
  end: 'Eso es todo. Las notificaciones se eliminan a los {days} días.',
  error: 'No se pudieron cargar las notificaciones.',
  retry: 'Reintentar',
  settings: 'Ajustes',
  close: 'Cerrar',
  newLabel: 'nueva',
  moreItems: { one: '+{n} más', many: '+{n} más', other: '+{n} más' },
};
export default dict;
