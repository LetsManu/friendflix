import type { Item } from '#lib/api';

/** genre (lower-case, German or English) -> mood tag for "Dieser Titel ist:" */
const MOOD: Record<string, string> = {
  thriller: 'Spannend', krimi: 'Spannend', crime: 'Spannend', mystery: 'Spannend', action: 'Spannend',
  komödie: 'Witzig', komoedie: 'Witzig', comedy: 'Witzig',
  drama: 'Emotional',
  horror: 'Gruselig',
  romanze: 'Romantisch', romance: 'Romantisch', liebesfilm: 'Romantisch',
  abenteuer: 'Aufregend', adventure: 'Aufregend',
  'sci-fi': 'Fantasievoll', 'science fiction': 'Fantasievoll', 'sci-fi & fantasy': 'Fantasievoll', fantasy: 'Fantasievoll',
  animation: 'Herzerwärmend', familie: 'Herzerwärmend', family: 'Herzerwärmend', kinder: 'Herzerwärmend',
  dokumentarfilm: 'Informativ', dokumentation: 'Informativ', documentary: 'Informativ',
  krieg: 'Ergreifend', war: 'Ergreifend', historie: 'Ergreifend', history: 'Ergreifend',
};

/** Up to three distinct mood tags derived from the genres, in genre order. */
export function moodTags(genres: readonly string[] | undefined, max = 3): string[] {
  const out: string[] = [];
  for (const g of genres ?? []) {
    const m = MOOD[g.trim().toLowerCase()];
    if (m && !out.includes(m)) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

/** "Noch 23 Min." for something that was started but not finished; '' otherwise. */
export function remainingLabel(positionTicks?: number, runtimeTicks?: number): string {
  if (!positionTicks || !runtimeTicks || positionTicks >= runtimeTicks) return '';
  const min = Math.ceil((runtimeTicks - positionTicks) / 600_000_000);
  if (min < 1) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `Noch ${h} Std.${m ? ` ${m} Min.` : ''}` : `Noch ${m} Min.`;
}

export interface Person { id: string; name: string; role?: string; type: string; image: boolean }
/** names of one credit type (Director / Writer / Actor ...), de-duplicated, order kept */
export function byType(people: readonly Person[], ...types: string[]): Person[] {
  const seen = new Set<string>();
  return people.filter((p) => types.includes(p.type) && !seen.has(p.id) && seen.add(p.id));
}

/** Age rating text for the info block ("FSK 12" -> "Ab 12 Jahren"), '' when it cannot be derived. */
export function ageText(rating?: string): string {
  if (!rating) return '';
  const m = /(?:FSK|PG|ab)?\s*[-:]?\s*(\d{1,2})\b/i.exec(rating);
  if (/^(fsk\s*)?0$/i.test(rating.trim()) || /^(g|all|u|ab 0)$/i.test(rating.trim())) return 'Für alle Altersstufen freigegeben';
  return m ? `Ab ${m[1]} Jahren` : '';
}

/** label of a season option (Jellyfin name, else "Staffel n") */
export const seasonLabel = (s: Pick<Item, 'name' | 'indexNumber'>): string => s.name || (s.indexNumber !== undefined ? `Staffel ${s.indexNumber}` : 'Staffel');
