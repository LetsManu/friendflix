// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from '#lib/api';
import type { Counts, Feed, Filter, Selection } from './types';

export interface NotesApi {
  feed(o: { filter: Filter; cursor?: string | null; limit?: number }): Promise<Feed>;
  counts(): Promise<Counts>;
  markRead(sel?: Selection): Promise<unknown>;
  hide(sel: Selection): Promise<{ undo: string; n: number }>;
  unhide(token: string): Promise<{ n: number }>;
}

const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });

export const defaultApi: NotesApi = {
  feed({ filter, cursor, limit }) {
    const q = new URLSearchParams({ filter, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (cursor) q.set('cursor', cursor);
    if (limit !== undefined) q.set('limit', String(limit));
    return api<Feed>(`/api/notifications/feed?${q}`);
  },
  counts: () => api<Counts>('/api/notifications/feed?limit=0'),
  markRead: (sel = {}) => post('/api/notifications/read', sel),
  hide: (sel) => post('/api/notifications/hide', sel),
  unhide: (token) => post('/api/notifications/unhide', { token }),
};

export const feed = defaultApi.feed;
export const counts = defaultApi.counts;
export const markRead = defaultApi.markRead;
export const hide = defaultApi.hide;
export const unhide = defaultApi.unhide;
