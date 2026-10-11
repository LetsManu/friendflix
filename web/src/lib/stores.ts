import { writable } from 'svelte/store';
import { api } from '#lib/api';

/** Ids on "Meine Liste" (watchlist). Loaded once, updated optimistically by cards and detail pages. */
export const listIds = writable<Set<string>>(new Set());

export async function loadList() {
  try {
    listIds.set(new Set((await api('/api/watchlist/ids')).ids));
  } catch {
    /* non-fatal */
  }
}

export async function toggleList(id: string, on: boolean) {
  listIds.update((s) => {
    const n = new Set(s);
    if (on) n.delete(id); else n.add(id);
    return n;
  });
  try {
    await api(`/api/items/${id}/watchlist`, { method: on ? 'DELETE' : 'POST' });
  } catch {
    listIds.update((s) => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
  }
}

export interface SubtitleStyle { size: 's' | 'm' | 'l' | 'xl'; color: 'white' | 'yellow' | 'cyan' | 'green'; background: 'none' | 'shadow' | 'semi' | 'solid'; font: 'sans' | 'serif' | 'mono' }
export interface Prefs { autoplayNext: boolean; autoSkipIntro: boolean; shareHistory: boolean; shareRatings: boolean; hoverTrailers: boolean; hoverClip: boolean; audioLang: string; subtitleLang: string; quality: number; stillWatching: boolean; stillWatchingEpisodes: 2 | 3 | 4 | 5; subtitleStyle: SubtitleStyle; spoilerProtection: boolean }
export const DEFAULT_PREFS: Prefs = { autoplayNext: true, autoSkipIntro: false, shareHistory: false, shareRatings: true, hoverTrailers: true, hoverClip: true, audioLang: '', subtitleLang: '', quality: 0, stillWatching: true, stillWatchingEpisodes: 3, subtitleStyle: { size: 'm', color: 'white', background: 'semi', font: 'sans' }, spoilerProtection: false };
/** Viewing preferences (server-side, follow the user across devices). */
export const prefs = writable<Prefs>({ ...DEFAULT_PREFS });
export async function loadPrefs() {
  try { const p = (await api('/api/prefs')).prefs;
    prefs.set({ ...DEFAULT_PREFS, ...p, subtitleStyle: { ...DEFAULT_PREFS.subtitleStyle, ...p?.subtitleStyle } }); } catch { /* defaults */ }
}
export async function savePrefs(p: Prefs) {
  prefs.set(p);
  await api('/api/prefs', { method: 'PUT', body: p });
}
