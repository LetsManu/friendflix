import { get, writable } from 'svelte/store';
import { api, ApiError } from '$lib/api';

/** Owner of the preview that is running right now (a card's item id, or `hero:<id>`) - only one at a time. */
export const previewOwner = writable<string>('');
let hls: { destroy(): void } | null = null;

/** Sound for previews (hover cards + billboard). Remembered per browser; on by default like on Netflix. */
const KEY = 'ff_sound';
const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
export const previewSound = writable<boolean>(saved !== '0');
previewSound.subscribe((on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ } });

/**
 * Turns sound on/off. Called from a click, so the browser allows un-muting even when autoplay had to start muted.
 */
export function toggleSound(v?: HTMLVideoElement) {
  const turnOn = v ? v.muted : !get(previewSound);
  previewSound.set(turnOn);
  if (v) v.muted = !turnOn;
}

/**
 * Plays the muted-or-not preview of `itemId` in the <video> returned by `getVideo`.
 * `owner` identifies who plays it (defaults to the item id) so the billboard and the hover cards never play together.
 */
export async function playPreview(itemId: string, getVideo: () => HTMLVideoElement | undefined, owner = itemId): Promise<boolean> {
  previewOwner.set(owner); // claim synchronously so the card's guard keeps the <video> mounted
  try {
    const { url, start = 0 } = await api<{ url: string; start?: number }>(`/api/items/${itemId}/trailer`);
    await new Promise((r) => setTimeout(r, 0)); // wait for the <video> to render
    const v = getVideo();
    if (!v) { console.warn('[preview] <video> not rendered for', itemId); stopPreview(owner); return false; }
    if (get(previewOwner) !== owner) return false; // somebody else took over while we were loading
    const { default: Hls } = await import('hls.js'); // loaded only when a preview is actually needed
    if (get(previewOwner) !== owner) return false;
    hls?.destroy();
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 8, startLevel: 0, startPosition: start > 0 ? start : -1 });
      hls = h;
      h.loadSource(url);
      h.attachMedia(v);
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { console.warn('[preview] hls fatal', d.type, d.details, d.response?.code); stopPreview(owner); } });
    } else { v.src = url; if (start > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true }); }
    // sound as chosen; browsers only allow it after the visitor has interacted with the page, otherwise fall back to muted
    v.muted = !get(previewSound);
    try { await v.play(); } catch (e) {
      if (v.muted) throw e;
      v.muted = true;
      await v.play();
    }
    return true;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) console.warn('[preview] failed', itemId, e); // 404 = this title simply has no preview
    stopPreview(owner);
    return false;
  }
}

export function stopPreview(owner: string) {
  if (get(previewOwner) === owner) { hls?.destroy(); hls = null; }
  previewOwner.update((o) => (o === owner ? '' : o));
}
