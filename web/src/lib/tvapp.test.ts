// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

const lg = vi.hoisted(() => ({ on: false, exit: vi.fn() }));
const fire = vi.hoisted(() => ({ on: false, post: vi.fn(() => true) }));
vi.mock('./webos/detect', () => ({ isLgApp: () => lg.on, exitLgApp: lg.exit }));
vi.mock('./firetv/detect', () => ({ isFireTvApp: () => fire.on, postFireTv: fire.post }));
import { exitTvApp, isTvApp } from './tvapp';

afterEach(() => { lg.on = false; fire.on = false; lg.exit.mockClear(); fire.post.mockClear(); });

describe('tvapp', () => {
  it('isTvApp: LG or Fire TV', () => {
    lg.on = true;
    expect(isTvApp()).toBe(true);
    lg.on = false; fire.on = true;
    expect(isTvApp()).toBe(true);
    fire.on = false;
    expect(isTvApp()).toBe(false);
  });
  it('exitTvApp posts exit in the Fire TV app and calls exitLgApp otherwise', () => {
    const w = { navigator: { userAgent: 'x' } };
    fire.on = true;
    exitTvApp(w);
    expect(fire.post).toHaveBeenCalledTimes(1);
    expect(fire.post).toHaveBeenCalledWith('exit', w);
    expect(lg.exit).not.toHaveBeenCalled();
    fire.on = false;
    exitTvApp(w);
    expect(lg.exit).toHaveBeenCalledTimes(1);
    expect(lg.exit).toHaveBeenCalledWith(w);
    expect(fire.post).toHaveBeenCalledTimes(1);
  });
});
