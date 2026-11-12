// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { sharedRoles, type RolesAnswer } from './rolesAnswer';

describe('sharedRoles', () => {
  it('asks once for every caller', async () => {
    const load = vi.fn(async (): Promise<RolesAnswer> => ({ roles: {} }));
    const roles = sharedRoles(load);
    const [a, b] = await Promise.all([roles(), roles()]);
    await roles();
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
  it('a failure is not kept: the next call asks again', async () => {
    const load = vi.fn<() => Promise<RolesAnswer>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ roles: { guest: { label: 'Gast' } as never } });
    const roles = sharedRoles(load);
    await expect(roles()).rejects.toThrow('down');
    await expect(roles()).resolves.toMatchObject({ roles: { guest: {} } });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
