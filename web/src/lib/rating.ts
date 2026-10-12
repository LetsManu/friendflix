/** Netflix-style three-step rating: -1 "Nicht mein Fall", 1 "Gefällt mir", 2 "Super", 0 = no rating. */
export type Thumb = -1 | 0 | 1 | 2;

export const RATING_OPTIONS: ReadonlyArray<{ value: Exclude<Thumb, 0>; label: string; icon: 'down' | 'up' | 'double' }> = [
  { value: -1, label: 'Nicht mein Fall', icon: 'down' },
  { value: 1, label: 'Gefällt mir', icon: 'up' },
  { value: 2, label: 'Super', icon: 'double' },
];

/** normalises whatever the API returned (null, '1', 3 …) to a known value */
export function toThumb(v: unknown): Thumb {
  const n = typeof v === 'string' ? Number(v) : v;
  return n === -1 || n === 1 || n === 2 ? n : 0;
}

/** clicking the active option resets the rating, any other option selects it */
export const nextThumb = (current: Thumb, picked: Exclude<Thumb, 0>): Thumb => (current === picked ? 0 : picked);

/** accessible name of the collapsed button */
export function thumbLabel(v: Thumb): string {
  const o = RATING_OPTIONS.find((x) => x.value === v);
  return o ? `Bewertet: ${o.label} – Bewertung ändern` : 'Bewerten';
}

/** index of the option keyboard focus starts on when the picker opens (the active one, else "Gefällt mir") */
export const focusIndex = (v: Thumb): number => Math.max(0, RATING_OPTIONS.findIndex((x) => x.value === (v === 0 ? 1 : v)));
