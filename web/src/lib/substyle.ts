import type { SubtitleStyle } from '#lib/stores';

export const SIZE_LABELS: Record<SubtitleStyle['size'], string> = { s: 'Klein', m: 'Mittel', l: 'Groß', xl: 'Sehr groß' };
export const COLOR_LABELS: Record<SubtitleStyle['color'], string> = { white: 'Weiß', yellow: 'Gelb', cyan: 'Cyan', green: 'Grün' };
export const BG_LABELS: Record<SubtitleStyle['background'], string> = { none: 'Keiner', shadow: 'Schatten', semi: 'Halbtransparent', solid: 'Schwarz' };
export const FONT_LABELS: Record<SubtitleStyle['font'], string> = { sans: 'Serifenlos', serif: 'Serifen', mono: 'Monospace' };

/** Classes for the stage / preview element; the matching static CSS rules live in Player.svelte and the settings page. */
export const subClasses = (s: SubtitleStyle) => `sub-size-${s.size} sub-color-${s.color} sub-bg-${s.background} sub-font-${s.font}`;
