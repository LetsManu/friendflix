/** Pure helpers for the player's control bar (Netflix layout). */

/** Saved defaults sent with the FIRST playback/info request: quality cap and preferred audio language (detail-page pick wins). */
export function firstInfoBody(pf: { quality?: number; audioLang?: string }, wantAudio = ''): { maxBitrate?: number; audioLang?: string } {
  const out: { maxBitrate?: number; audioLang?: string } = {};
  if (typeof pf.quality === 'number' && pf.quality >= 300_000) out.maxBitrate = Math.floor(pf.quality);
  const lang = (wantAudio || pf.audioLang || '').trim();
  if (lang && lang.length <= 16) out.audioLang = lang;
  return out;
}

/** Centre text of the bar: "Serie  F3 Folgentitel" (Netflix style) or the film name. */
export function barTitles(it: { name: string; type?: string; seriesName?: string; indexNumber?: number; parentIndexNumber?: number } | null): { title: string; sub: string } {
  if (!it) return { title: '', sub: '' };
  if (it.seriesName) return { title: it.seriesName, sub: `${it.indexNumber !== undefined ? `F${it.indexNumber} ` : ''}${it.name}`.trim() };
  return { title: it.name, sub: '' };
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const speedLabel = (r: number) => (r === 1 ? '1× (Normal)' : `${String(r).replace('.', ',')}×`);
