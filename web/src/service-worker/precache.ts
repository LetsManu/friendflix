/**
 * What the service worker stores on install: only the app shell the offline hub needs (the prerendered /offline page,
 * the modules and stylesheets it references, the latin Inter subset and the icons). Every other immutable file
 * (route chunks, other font subsets) is cached on first use (cache-first), so a first visit no longer downloads the whole app twice.
 */

/** absolute `/_app/immutable/…` URLs referenced by a prerendered page (module preloads, stylesheets, the hydration import) */
export function shellUrls(html: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => out.add('/' + p.replace(/^\.?\//, ''));
  for (const m of html.matchAll(/\b(?:href|src)="((?:\.?\/)?_app\/immutable\/[^"?#]+)"/g)) add(m[1]!);
  for (const m of html.matchAll(/import\(\s*["']((?:\.?\/)?_app\/immutable\/[^"'?#]+)["']\s*\)/g)) add(m[1]!);
  return [...out];
}

/** the Inter subset German text needs (the others load on demand through unicode-range) */
export const isShellFont = (path: string) => /\/inter-latin-wght-normal\.[\w-]+\.woff2$/.test(path);

/** files to put into the cache on install, before reading the /offline page */
export function basePrecache(o: { immutable: string[]; prerendered: string[]; statics: string[] }): string[] {
  return [...new Set([...o.prerendered, ...o.statics, ...o.immutable.filter(isShellFont)])];
}
