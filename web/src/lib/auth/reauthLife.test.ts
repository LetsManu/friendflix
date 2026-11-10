// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The dialog's clean-up rule: closing always cancels unless the flow ended; a start that returns after a close cancels what it opened.
import { describe, expect, it, vi } from 'vitest';
import { reauthLife } from './reauthLife';

describe('reauthLife', () => {
  it('closing while the first step is still loading cancels', async () => {
    const cancel = vi.fn(async () => undefined);
    const life = reauthLife(cancel);
    await life.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('closing after a refused passkey (no step, no passkey card) cancels: the password attempt is still open', async () => {
    const cancel = vi.fn(async () => undefined);
    const life = reauthLife(cancel);
    expect(life.started()).toBe(true);
    await life.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a start that returns after the dialog was closed cancels the sessions it opened and shows nothing', async () => {
    const cancel = vi.fn(async () => undefined);
    const life = reauthLife(cancel);
    await life.close();
    cancel.mockClear();
    expect(life.started()).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a flow that ended or finished is not cancelled on close, and closing twice cancels once', async () => {
    const cancel = vi.fn(async () => undefined);
    const done = reauthLife(cancel);
    done.finish();
    await done.close();
    expect(cancel).not.toHaveBeenCalled();
    const twice = reauthLife(cancel);
    await twice.close();
    await twice.close();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a failing cancel never blocks closing', async () => {
    const life = reauthLife(async () => { throw new Error('offline'); });
    await expect(life.close()).resolves.toBeUndefined();
  });
});
