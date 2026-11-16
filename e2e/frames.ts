// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';

/**
 * Frame sampling for pop-up motion (menus glass stage 1): text must never be scaled while a surface animates, or it blurs and
 * jumps between pixel grids. Both helpers run inside the page on every animation frame.
 */

/**
 * Starts sampling now and returns `stop()`: it ends the sampling and gives the largest `|scale - 1|` seen on any element under
 * `rootSelector` that has a direct non-empty text node, the product of its own and every ancestor's computed `transform`
 * (up to `<html>`), as `max(|scaleX - 1|, |scaleY - 1|)`. The root is looked up on each frame, so it may not exist yet (it is
 * being opened) or go away (it is closing). `frames` counts the frames in which text was found at all: a sampler that never saw
 * the surface would pass for nothing.
 */
export async function watchTextScale(page: Page, rootSelector: string): Promise<() => Promise<{ dev: number; frames: number }>> {
  const key = '__ffTextScale' + Math.random().toString(36).slice(2);
  await page.evaluate(([sel, k]) => {
    const st = { dev: 0, frames: 0, on: true };
    (window as unknown as Record<string, unknown>)[k!] = st;
    const matrixOf = (el: Element) => {
      const t = getComputedStyle(el).transform;
      return !t || t === 'none' ? new DOMMatrix() : new DOMMatrix(t);
    };
    const frame = () => {
      if (!st.on) return;
      let seen = false;
      for (const root of document.querySelectorAll(sel!)) {
        for (const e of [root, ...root.querySelectorAll('*')]) {
          if (![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim())) continue;
          seen = true;
          let m = new DOMMatrix();
          for (let a: Element | null = e; a; a = a.parentElement) m = matrixOf(a).multiply(m);
          const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
          st.dev = Math.max(st.dev, Math.abs(sx - 1), Math.abs(sy - 1));
        }
      }
      if (seen) st.frames++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, [rootSelector, key]);
  return () => page.evaluate((k) => {
    const st = (window as unknown as Record<string, { dev: number; frames: number; on: boolean }>)[k]!;
    st.on = false;
    return { dev: st.dev, frames: st.frames };
  }, key);
}

/**
 * Samples for `ms` (default 450, a little more than the longest pop-up motion) and resolves with the largest scale deviation.
 * Start it before the action and await it after: `const p = sampleTextScale(page, sel); await open(); expect(await p)...`.
 * A surface that never showed text in a frame fails here (-1 is never a pass).
 */
export async function sampleTextScale(page: Page, rootSelector: string, ms = 450): Promise<number> {
  const stop = await watchTextScale(page, rootSelector);
  await page.waitForTimeout(ms);
  const r = await stop();
  return r.frames > 0 ? r.dev : Number.POSITIVE_INFINITY;
}

/** The element's bounding box (null when it is not rendered): read before and after to see that nothing moved. */
export async function stableBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.locator(selector).first().boundingBox();
}

/**
 * Runs `action` (which opens or closes the surface) with the sampler already running, keeps sampling `ms` after it returns
 * (the motion outlasts the click), and resolves with the largest scale deviation of text under `rootSelector`. Fails (infinity)
 * when no frame ever showed text under the root.
 */
export async function textScaleDuring(page: Page, rootSelector: string, action: () => Promise<unknown>, ms = 450): Promise<number> {
  const stop = await watchTextScale(page, rootSelector);
  await action();
  await page.waitForTimeout(ms);
  const r = await stop();
  return r.frames > 0 ? r.dev : Number.POSITIVE_INFINITY;
}
