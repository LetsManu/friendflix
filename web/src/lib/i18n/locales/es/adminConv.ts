// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminConv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Conversiones',
  intro: 'Cuántos vídeos puede convertir el servidor a la vez: películas y series, TV en directo, grabaciones y descargas juntas.',
  used: '{u} de {l} en uso',
  measured: 'Medido {s}× tiempo real ({engine})',
  liveSpeed: 'TV en directo {s}×',
  recommended: 'recomendado {n}',
  checked: 'comprobado {when}',
  today: 'hoy {time}',
  remeasure: 'Medir de nuevo',
  auto: 'Automático ({n})',
  custom: 'Valor propio',
  noRealtime: 'El servidor no puede convertir en tiempo real.',
  busyMeasure: 'Medir solo funciona mientras nadie está viendo nada.',
  kind: {
    film: 'Película/serie',
    live: 'TV en directo',
    record: 'Grabación',
    else: 'Otras',
  },
  free: 'libre',
  over: 'por encima del límite',
  stale: 'Medición desactualizada: vuelve a medir',
  never: 'Aún sin medir · hasta entonces {n}',
  measuring: 'Midiendo… (unos 20 s)',
  cpu: 'procesador',
  bar: 'Uso de las plazas de conversión',
  running: {
    title: 'En marcha ahora',
    none: 'Ahora mismo no se convierte nada.',
  },
  since: 'desde hace {d}',
  slots: {
    label: 'Conversiones simultáneas',
    value: 'Valor propio en plazas',
    less: 'Menos',
    more: 'Más',
  },
  priority: {
    label: 'Prioridad',
    films: 'Películas y series primero',
    live: 'TV en directo primero',
    equal: 'Misma prioridad',
    hint: {
      films: 'La TV en directo deja una plaza libre para películas y series (a partir de 2 plazas).',
      live: 'Las películas y series dejan una plaza libre para la TV en directo (a partir de 2 plazas).',
      equal: 'No se reserva ninguna plaza: quien llega primero, la obtiene.',
    },
  },
  last: {
    ok: 'Última medición correcta',
    failed: 'Última medición fallida: inténtalo de nuevo',
    no_title: 'Última medición imposible: no hay un título adecuado (SDR, de 720p a 1080p) en la biblioteca',
    busy: 'Última medición interrumpida: alguien estaba viendo algo',
    no_user: 'Última medición imposible: no hay cuenta de administrador para convertir',
    unsupported: 'Medir solo es posible con Jellyfin',
  },
  err: {
    running: 'Ya hay una medición en curso.',
    busyUnknown: 'El servidor multimedia no responde ahora, así que no está claro si alguien está viendo algo.',
    noUser: 'No hay ninguna cuenta de administrador con la que el servidor multimedia pueda convertir para la medición.',
    unsupported: 'Medir solo es posible con Jellyfin',
    tooMany: 'Demasiadas mediciones en poco tiempo. Inténtalo de nuevo en unos minutos.',
    locked: 'Definido en el entorno: aquí no se puede cambiar.',
    loadFailed: 'No se pudieron cargar las conversiones.',
  },
  details: 'Ir a la comprobación de reproducción',
};
export default dict;
