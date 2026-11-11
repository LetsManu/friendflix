// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/**
 * A recording `navigator.mediaSession` (Chromium's real one shows nothing a test can read): keeps the metadata as a plain object,
 * every action handler by name, the last position state and the playback state. Call before the first navigation.
 */
export async function stubMediaSession(page: Page) {
  await page.addInitScript(() => {
    type Handler = ((d?: unknown) => void) | null;
    const log = { metadata: null as unknown, handlers: {} as Record<string, Handler>, positionState: null as unknown, playbackState: 'none' };
    (window as unknown as { __ms: typeof log }).__ms = log;
    const fake = {
      get metadata() { return log.metadata; },
      set metadata(m: unknown) {
        const md = m as { title: string; artist: string; artwork: Array<{ src: string }> } | null;
        log.metadata = md ? { title: md.title, artist: md.artist, artwork: md.artwork.map((a) => ({ src: a.src })) } : null;
      },
      get playbackState() { return log.playbackState; },
      set playbackState(s: string) { log.playbackState = s; },
      setActionHandler(a: string, fn: Handler) { log.handlers[a] = fn; },
      setPositionState(s: unknown) { log.positionState = s ?? null; },
    };
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: fake });
  });
}

export interface MediaSessionLog { metadata: { title: string; artist: string; artwork: Array<{ src: string }> } | null; handlers: string[]; positionState: { duration: number; position: number; playbackRate: number } | null; playbackState: string }
/** the session as the page left it; `handlers` lists the actions that currently have a handler */
export const mediaSessionLog = (page: Page): Promise<MediaSessionLog> => page.evaluate(() => {
  const l = (window as unknown as { __ms: { metadata: MediaSessionLog['metadata']; handlers: Record<string, unknown>; positionState: MediaSessionLog['positionState']; playbackState: string } }).__ms;
  return { metadata: l.metadata, handlers: Object.keys(l.handlers).filter((k) => l.handlers[k]).sort(), positionState: l.positionState, playbackState: l.playbackState };
});
/** what the lock screen does: calls the registered handler */
export const callMediaSession = (page: Page, action: string, details: Record<string, unknown> = {}) => page.evaluate(([a, d]) => {
  const h = (window as unknown as { __ms: { handlers: Record<string, ((d: unknown) => void) | null> } }).__ms.handlers[a as string];
  if (!h) throw new Error(`no handler for ${a as string}`);
  h({ action: a, ...(d as object) });
}, [action, details] as const);
