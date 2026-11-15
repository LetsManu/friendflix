// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api';
import { confirm } from '#lib/ui/confirm';
import { toast } from '#lib/ui/toast';
import { canDelete, copyRole, deleteMoving, deleteRole, inUse, moveTargetsOf } from './roleDelete';

vi.mock('#lib/api', async (orig) => ({ ...(await orig<typeof import('#lib/api')>()), api: vi.fn() }));
vi.mock('#lib/ui/confirm', () => ({ confirm: vi.fn() }));
vi.mock('#lib/ui/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(confirm).mockReset(); vi.mocked(toast.error).mockReset(); });

// the delete flow shared by the role list and the role page (review fix round 1, I3)
const r = (key: string, base: 'admin' | 'family' | 'friend' | 'guest', origin: 'code' | 'env' | 'admin' = 'admin', envGone = false) =>
  ({ key, label: key, builtinLabel: origin === 'code', base, origin, envGone });

describe('the shared delete flow', () => {
  it('moveTargetsOf: every role but the deleted one and the admin-based ones, by display name', () => {
    const roles = [r('admin', 'admin', 'code'), r('family', 'family', 'code'), r('kino', 'friend'), r('crew', 'friend', 'env')];
    expect(moveTargetsOf(roles, 'kino')).toEqual([{ key: 'family', name: 'Familie' }, { key: 'crew', name: 'crew' }]);
  });
  it('inUse: the counts of a 409 role_in_use, null for anything else', () => {
    expect(inUse(new ApiError(409, { error: 'role_in_use', accounts: 3, invites: 1 }))).toEqual({ accounts: 3, invites: 1 });
    expect(inUse(new ApiError(409, { error: 'name_taken' }))).toBeNull();
    expect(inUse(new Error('x'))).toBeNull();
  });
  it('canDelete: roles made here, and env roles that left .env', () => {
    expect([canDelete(r('kino', 'friend')), canDelete(r('family', 'family', 'code')), canDelete(r('crew', 'friend', 'env')), canDelete(r('crew', 'friend', 'env', true))]).toEqual([true, false, false, true]);
  });
  it('inUse: missing counts become 0', () => {
    expect(inUse(new ApiError(409, { error: 'role_in_use' }))).toEqual({ accounts: 0, invites: 0 });
  });

  describe('deleteRole', () => {
    const kino = { ...r('kino', 'friend'), accounts: 0 };
    it('asks once for an unused role, then deletes it', async () => {
      vi.mocked(confirm).mockResolvedValue(true);
      vi.mocked(api).mockResolvedValue(undefined);
      expect(await deleteRole(kino, null)).toBe('deleted');
      expect(confirm).toHaveBeenCalledOnce();
      expect(api).toHaveBeenCalledWith('/api/admin/roles/kino', { method: 'DELETE' });
    });
    it('cancelled: nothing is sent and the focus goes back to the trigger', async () => {
      vi.mocked(confirm).mockResolvedValue(false);
      const trigger = { focus: vi.fn() } as unknown as HTMLElement;
      expect(await deleteRole(kino, trigger)).toBe('kept');
      expect(api).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true }));
    });
    it('cancelled without a trigger does not throw', async () => {
      vi.mocked(confirm).mockResolvedValue(false);
      expect(await deleteRole(kino, null)).toBe('kept');
    });
    it('a held role skips the confirm and returns the counts of a 409 role_in_use', async () => {
      vi.mocked(api).mockRejectedValue(new ApiError(409, { error: 'role_in_use', accounts: 2, invites: 1 }));
      expect(await deleteRole({ ...kino, accounts: 2 }, null)).toEqual({ accounts: 2, invites: 1 });
      expect(confirm).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
    it('any other failure toasts the error and keeps the role', async () => {
      vi.mocked(confirm).mockResolvedValue(true);
      vi.mocked(api).mockRejectedValue(new ApiError(500, { error: 'boom' }));
      expect(await deleteRole(kino, null)).toBe('kept');
      expect(toast.error).toHaveBeenCalledOnce();
    });
    it('encodes the key in the URL', async () => {
      vi.mocked(api).mockResolvedValue(undefined);
      await deleteRole({ ...kino, key: 'a/b c', accounts: 1 }, null);
      expect(api).toHaveBeenCalledWith('/api/admin/roles/a%2Fb%20c', { method: 'DELETE' });
    });
  });

  describe('deleteMoving', () => {
    it('sends the target role and answers ok', async () => {
      vi.mocked(api).mockResolvedValue(undefined);
      expect(await deleteMoving('kino', 'family')).toEqual({ ok: true });
      expect(api).toHaveBeenCalledWith('/api/admin/roles/kino', { method: 'DELETE', body: { moveTo: 'family' } });
    });
    it('a role_in_use answer carries the new counts', async () => {
      vi.mocked(api).mockRejectedValue(new ApiError(409, { error: 'role_in_use', accounts: 1, invites: 0 }));
      const out = await deleteMoving('kino', 'family');
      expect(out).toMatchObject({ ok: false, counts: { accounts: 1, invites: 0 } });
      expect(typeof (out as { error: string }).error).toBe('string');
    });
    it('another failure has no counts', async () => {
      vi.mocked(api).mockRejectedValue(new ApiError(404, { error: 'not_found' }));
      expect(await deleteMoving('kino', 'family')).toMatchObject({ ok: false, counts: null });
    });
  });

  it('copyRole: POSTs label and source, returns the new key', async () => {
    vi.mocked(api).mockResolvedValue({ key: 'kino-2' });
    expect(await copyRole('Kino 2', 'kino')).toBe('kino-2');
    expect(api).toHaveBeenCalledWith('/api/admin/roles', { method: 'POST', body: { label: 'Kino 2', from: 'kino' } });
  });
  it('copyRole passes the API error on', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(409, { error: 'name_taken' }));
    await expect(copyRole('Kino', 'kino')).rejects.toBeInstanceOf(ApiError);
  });
});
