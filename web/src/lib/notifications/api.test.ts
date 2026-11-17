// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('#lib/api', () => ({ api: apiMock, apiCode: () => undefined, ApiError: class extends Error {} }));
import { counts, feed, hide, markRead, unhide } from './api';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
beforeEach(() => apiMock.mockClear());

describe('notifications api', () => {
  it('feed sends filter, tz, and optional cursor and limit', async () => {
    await feed({ filter: 'unread' });
    expect(apiMock).toHaveBeenLastCalledWith(`/api/notifications/feed?${new URLSearchParams({ filter: 'unread', tz })}`);
    await feed({ filter: 'series', cursor: 'c_1-x', limit: 10 });
    expect(apiMock).toHaveBeenLastCalledWith(`/api/notifications/feed?${new URLSearchParams({ filter: 'series', tz, cursor: 'c_1-x', limit: '10' })}`);
  });
  it('counts asks for limit=0', async () => {
    await counts();
    expect(apiMock).toHaveBeenLastCalledWith('/api/notifications/feed?limit=0');
  });
  it('read, hide and unhide post their bodies', async () => {
    await markRead();
    expect(apiMock).toHaveBeenLastCalledWith('/api/notifications/read', { method: 'POST', body: {} });
    await markRead({ groups: ['g'] });
    expect(apiMock).toHaveBeenLastCalledWith('/api/notifications/read', { method: 'POST', body: { groups: ['g'] } });
    await hide({ category: 'all' });
    expect(apiMock).toHaveBeenLastCalledWith('/api/notifications/hide', { method: 'POST', body: { category: 'all' } });
    await unhide('tok');
    expect(apiMock).toHaveBeenLastCalledWith('/api/notifications/unhide', { method: 'POST', body: { token: 'tok' } });
  });
});
