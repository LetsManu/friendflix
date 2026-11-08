// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone player helpers: when the phone layout applies, which tools show per orientation, panel geometry and the sub line. */
import { fmtRuntime } from '#lib/hover';
import { tr, type TFn } from '#lib/i18n';

/** true only on a coarse-pointer device that is neither a TV nor a kids profile */
export function phonePlayer(o: { coarse: boolean; tv: boolean; kids: boolean }): boolean {
  return o.coarse && !o.tv && !o.kids;
}

/** the credits sequence runs on TV, desktop and phones, never for kids */
export function creditsOn(o: { kids: boolean; tv: boolean; desk: boolean; phone: boolean }): boolean {
  return !o.kids && (o.tv || o.desk || o.phone);
}

export type PhoneOrient = 'landscape' | 'portrait';
export const phoneOrient = (w: number, h: number): PhoneOrient => (h > w ? 'portrait' : 'landscape');

export type PhoneTool = 'next' | 'episodes' | 'tracks' | 'speed' | 'more';
export type ToolFeatures = { next: boolean; episodes: boolean; tracks: boolean; speed: boolean };

/** buttons of the bottom row, in order; More is always there */
export function phoneTools(o: PhoneOrient, f: ToolFeatures): PhoneTool[] {
  const order: PhoneTool[] = o === 'landscape' ? ['next', 'episodes', 'tracks', 'speed'] : ['episodes', 'tracks'];
  return [...order.filter((t) => f[t as keyof ToolFeatures]), 'more'];
}

/** what More lists on top in portrait (speed and next moved there); nothing in landscape */
export function moreExtras(o: PhoneOrient, f: ToolFeatures): ('speed' | 'next')[] {
  if (o === 'landscape') return [];
  const out: ('speed' | 'next')[] = [];
  if (f.speed) out.push('speed');
  if (f.next) out.push('next');
  return out;
}

export type PanelAnchor = 'start' | 'end' | 'full';
export const panelAnchor = (o: PhoneOrient, pill: 'start' | 'end'): PanelAnchor => (o === 'portrait' ? 'full' : pill);

export const PANEL_GAP = 8;
export const PANEL_MAX_W = 380;

/** panel bottom edge and max height in px, relative to the stage */
export function panelBox(o: { stageH: number; tlTop: number; topBottom: number }): { bottom: number; maxH: number } {
  return { bottom: o.stageH - o.tlTop + PANEL_GAP, maxH: Math.max(0, o.tlTop - PANEL_GAP - o.topBottom - PANEL_GAP) };
}

/** transform-origin so the panel grows from its button */
export function growOrigin(o: { anchor: PanelAnchor; btnX: number; left: number; width: number }): string {
  if (o.anchor === 'end') return 'bottom right';
  if (o.anchor === 'start') return 'bottom left';
  const p = o.width <= 0 ? 50 : Math.min(100, Math.max(0, Math.round(((o.btnX - o.left) / o.width) * 100)));
  return `${p}% 100%`;
}

/** line under the title: episode line, or "year · length" for a film */
export function phoneSub(
  it: { type?: string; name: string; seriesName?: string; parentIndexNumber?: number | null; indexNumber?: number | null; year?: number; runtimeTicks?: number } | null,
  tf: TFn = tr,
): string {
  if (!it) return '';
  if (it.seriesName) {
    const e = it.indexNumber, s = it.parentIndexNumber;
    if (e === undefined || e === null) return it.name;
    if (s === undefined || s === null) return `${tf('player.episodeOnly', { e })} · ${it.name}`;
    return tf('player.phone.episodeLine', { s, e, name: it.name });
  }
  return [it.year ? String(it.year) : '', fmtRuntime(it.runtimeTicks)].filter(Boolean).join(' · ');
}
