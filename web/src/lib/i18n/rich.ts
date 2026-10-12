/**
 * Minimal safe markup for translated sentences: only <b>…</b>, <kbd>…</kbd> and <a href="/internal">…</a>
 * (no nesting, no attributes besides an app-internal href). Everything else stays plain text, so a translation can never inject HTML.
 */
export type RichPart = { kind: 'text' | 'b' | 'kbd'; text: string } | { kind: 'a'; text: string; href: string };

const RE = /<(b|kbd)>(.*?)<\/\1>|<a href="(\/(?!\/)[^"<>\s]*)">(.*?)<\/a>/g;

export function richParts(src: string): RichPart[] {
  const out: RichPart[] = [];
  let last = 0;
  for (const m of src.matchAll(RE)) {
    if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) });
    if (m[1]) out.push({ kind: m[1] as 'b' | 'kbd', text: m[2] ?? '' });
    else out.push({ kind: 'a', href: m[3]!, text: m[4] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
}
