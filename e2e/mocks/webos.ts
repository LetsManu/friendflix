// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/** User agent of the LG webOS TV browser engine. */
export const LG_UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 WebAppManager';

/**
 * Makes the page a stand-in LG TV: webOS user agent (set over CDP, so it reaches both navigator.userAgent and the request headers),
 * a `PalmSystem` stub that counts `platformBack()` calls, and a media engine that confirms every codec (`canPlayType` -> 'probably').
 * Call before the first navigation. The app still needs `?ff_app=webos` in the URL, like on the real TV.
 */
export async function asLgApp(page: Page): Promise<{ backCalls: () => Promise<number> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: LG_UA });
  await page.addInitScript(() => {
    const w = window as unknown as { __palmBack: number; PalmSystem: { platformBack(): void } };
    w.__palmBack = 0;
    w.PalmSystem = { platformBack() { w.__palmBack++; } };
    HTMLMediaElement.prototype.canPlayType = () => 'probably';
  });
  return { backCalls: () => page.evaluate(() => (window as unknown as { __palmBack: number }).__palmBack) };
}
