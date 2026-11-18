// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/notes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Notifications',
  fresh: { one: '{n} new', other: '{n} new' },
  filter: { all: 'All', unread: 'Unread' },
  category: {
    downloads: 'Downloads',
    devices: 'Devices',
    series: 'Shows & films',
    achievements: 'Achievements',
    livetv: 'Live TV',
    system: 'System',
    requests: 'Requests',
    social: 'Friends',
    misc: 'Other',
  },
  section: { today: 'Today', week: 'This week' },
  action: { view: 'View', devices: 'Check devices', update: 'Update', open: 'Open' },
  readAll: 'Mark all read',
  clearAll: 'Clear all',
  clearCategory: 'Clear {category}',
  clearUnread: 'Clear unread',
  cleared: { one: '{n} notification removed', other: '{n} notifications removed' },
  undo: 'Undo',
  remove: 'Remove',
  empty: 'No notifications',
  end: 'That’s all. Notifications are removed after {days} days.',
  error: 'Couldn’t load notifications.',
  retry: 'Try again',
  settings: 'Settings',
  close: 'Close',
  newLabel: 'new',
  moreItems: { one: '+{n} more', other: '+{n} more' },
};
export default dict;
