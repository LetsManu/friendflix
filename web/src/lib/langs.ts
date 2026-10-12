/** ISO 639-2/T language codes (as indexed by the backend) -> German labels. */
const LABEL: Record<string, string> = {
  deu: 'Deutsch', eng: 'Englisch', fra: 'Französisch', spa: 'Spanisch', ita: 'Italienisch', por: 'Portugiesisch', nld: 'Niederländisch',
  rus: 'Russisch', pol: 'Polnisch', tur: 'Türkisch', jpn: 'Japanisch', kor: 'Koreanisch', zho: 'Chinesisch', ara: 'Arabisch',
  hin: 'Hindi', swe: 'Schwedisch', nor: 'Norwegisch', dan: 'Dänisch', fin: 'Finnisch', ces: 'Tschechisch', slk: 'Slowakisch',
  hun: 'Ungarisch', ron: 'Rumänisch', ell: 'Griechisch', heb: 'Hebräisch', tha: 'Thailändisch', ukr: 'Ukrainisch', bul: 'Bulgarisch',
  hrv: 'Kroatisch', srp: 'Serbisch', fas: 'Persisch', vie: 'Vietnamesisch', ind: 'Indonesisch', isl: 'Isländisch', lat: 'Latein',
};

/** German display name for a language code; unknown codes fall back to the upper-case code. */
export function langLabel(code: string): string {
  const c = code.trim().toLowerCase();
  return LABEL[c] ?? c.toUpperCase();
}

/** "Ton: Deutsch, Englisch · Untertitel: Deutsch" (empty string when nothing is known). */
export function langLine(langs: { audio?: string[]; subs?: string[] } | undefined | null): string {
  const parts: string[] = [];
  if (langs?.audio?.length) parts.push(`Ton: ${langs.audio.map(langLabel).join(', ')}`);
  if (langs?.subs?.length) parts.push(`Untertitel: ${langs.subs.map(langLabel).join(', ')}`);
  return parts.join(' · ');
}
