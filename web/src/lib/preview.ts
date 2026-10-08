import { writable } from 'svelte/store';
import { api } from '$lib/api';

/** Id of the card whose trailer preview is currently running (only one at a time). */
export const previewOwner = writable<string>('');
let hls: { destroy(): void } | null = null;

export async function playPreview(itemId: string, getVideo: () => HTMLVideoElement | undefined): Promise<boolean> {
  try {
    const { url } = await api<{ url: string }>(`/api/items/${itemId}/trailer`);
    previewOwner.set(itemId);
    await new Promise((r) => setTimeout(r, 0)); // wait for the <video> to render
    const v = getVideo();
    if (!v) { console.warn('[preview] <video> not rendered for', itemId); return false; }
    const { default: Hls } = await import('hls.js'); // loaded only when a preview is actually needed
    hls?.destroy();
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 8, startLevel: 0 });
      hls = h;
      h.loadSource(url);
      h.attachMedia(v);
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) stopPreview(itemId); });
    } else v.src = url;
    await v.play();
    return true;
  } catch (e) {
    console.warn('[preview] failed', itemId, e);
    return false;
  }
}

export function stopPreview(itemId: string) {
  hls?.destroy();
  hls = null;
  previewOwner.update((o) => (o === itemId ? '' : o));
}
