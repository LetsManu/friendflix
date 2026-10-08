import { writable } from 'svelte/store';
import { api } from '$lib/api';

/** Id of the card whose trailer preview is currently running (only one at a time). */
export const previewOwner = writable<string>('');
let hls: { destroy(): void } | null = null;

export async function playPreview(itemId: string, getVideo: () => HTMLVideoElement | undefined): Promise<boolean> {
  previewOwner.set(itemId); // claim synchronously so the card's guard keeps the <video> mounted
  try {
    const { url, start = 0 } = await api<{ url: string; start?: number }>(`/api/items/${itemId}/trailer`);
    await new Promise((r) => setTimeout(r, 0)); // wait for the <video> to render
    const v = getVideo();
    if (!v) { console.warn('[preview] <video> not rendered for', itemId); stopPreview(itemId); return false; }
    const { default: Hls } = await import('hls.js'); // loaded only when a preview is actually needed
    hls?.destroy();
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 8, startLevel: 0, startPosition: start > 0 ? start : -1 });
      hls = h;
      h.loadSource(url);
      h.attachMedia(v);
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { console.warn('[preview] hls fatal', d.type, d.details, d.response?.code); stopPreview(itemId); } });
    } else { v.src = url; if (start > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true }); }
    await v.play();
    return true;
  } catch (e) {
    console.warn('[preview] failed', itemId, e);
    stopPreview(itemId);
    return false;
  }
}

export function stopPreview(itemId: string) {
  hls?.destroy();
  hls = null;
  previewOwner.update((o) => (o === itemId ? '' : o));
}
