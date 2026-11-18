// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Mirrors of the backend's feed shapes (backend/src/notifications/feed.ts). Ids and cursors are opaque strings. */
export type Category = 'downloads' | 'devices' | 'series' | 'achievements' | 'livetv' | 'system' | 'requests' | 'social' | 'other';
export type Filter = 'all' | 'unread' | Category;
export type SectionKey = string; // 'today' | 'week' | 'YYYY-MM'
export interface FeedItem { id: number; title: string; body: string | null; at: string }
export interface FeedGroup { id: string; kind: string; category: Category; title: string; body: string | null; link: string | null; at: string; count: number; unread: boolean; unreadCount: number; items: FeedItem[] }
export interface Section { key: SectionKey; groups: FeedGroup[] }
export interface Counts { unread: number; categories: Array<{ key: Category; n: number }> }
export interface Feed extends Counts { sections: Section[]; next: string | null }
/**
 * What read / hide act on; nothing at all means everything (read only). `max`: the newest entry id the page knows; a category then
 * leaves out entries that arrived since (the store adds it).
 */
export interface Selection { ids?: number[]; groups?: string[]; category?: Filter; max?: number }
