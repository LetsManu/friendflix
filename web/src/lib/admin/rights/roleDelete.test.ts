// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { canDelete, inUse, moveTargetsOf } from './roleDelete';

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
});
