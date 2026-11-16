// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The no-text-scale rule as a source scan (menus spec): a pop-up, a menu or a text control never animates `scale()`, and the
 * overshooting spring curve stays out of pop-up code. Elements without any text may keep a scale; each one is named in ALLOW
 * with its reason. A key is `path:pattern`: `path` is a substring of the file's path under src/, `pattern` a substring of the
 * finding's detail (a keyframes name, a selector or the source line). Every key must still match something.
 */
const ALLOW: Record<string, string> = {
  // TV focus design (the owner keeps it): focused tiles, rows and buttons on html.tv. One key per finding; a focus scale on an element
  // that holds text is TEMPORARY until stage 5 (TV menus) decides it
  'app.css:html.tv .card:focus-within': 'TEMPORARY: text-bearing TV focus scale (a card with its caption and badges); owner decision in stage 5 (TV menus)',
  'app.css:html.tv .tv-btn:focus-visible': 'TEMPORARY: text-bearing TV focus scale (the text buttons of TV dialogs and menus); owner decision in stage 5 (TV menus)',
  'lib/tv/TvRail.svelte:a:focus-visible': 'TEMPORARY: text-bearing TV focus scale (a side bar link holds its label); owner decision in stage 5 (TV menus)',
  'lib/tv/TvCategoryRow.svelte:.cat:focus-visible': 'TEMPORARY: text-bearing TV focus scale (a category tile holds the genre name); owner decision in stage 5 (TV menus)',
  'lib/tv/TvFocusTile.svelte:@keyframes tv-settle': 'TV hero backdrop settling as it comes in; the .bg image only',
  'lib/tv/TvFocusTile.svelte:@keyframes tv-drift': 'TV hero backdrop drift; the .drift box holds only the backdrop image',
  'lib/BrandHubs.svelte::global(html.tv)': 'TV focus tile; the TV focus design',
  'lib/BrandHubs.svelte:.tile:hover, .tile:focus-visible': 'brand logo tile lift; logo artwork only (the reduced-motion rule drops it)',
  'lib/LangPick.svelte:.tvlp': 'TV focus option; the TV focus design',
  'lib/Player.svelte::global(html.tv) .ic:focus-visible': 'TV focus on an icon button; no text',
  'lib/detail/DetailTv.svelte::global(html.tv)': 'TV focus button; the TV focus design',
  'lib/detail/TvEpisodes.svelte::global(html.tv)': 'TV focus row; the TV focus design',
  'lib/detail/TvSub.svelte:.rcol': 'TV focus on a cast avatar image; no text in the scaled box',
  'lib/live/FavOrderSheet.svelte:.tv .row:focus-within': 'TV focus row; the TV focus design',
  'lib/live/FavTiles.svelte:.tv .ordnen:focus-visible': 'TEMPORARY: text-bearing TV focus scale (the Ordnen button); owner decision in stage 5 (TV menus)',
  'lib/live/FavTiles.svelte:.tv .tile:focus-visible': 'TEMPORARY: text-bearing TV focus scale (a channel tile with its name and programme); owner decision in stage 5 (TV menus)',
  'lib/live/GroupChips.svelte:.tv .chip': 'TV focus chip; the TV focus design',
  'lib/live/PanelRow.svelte::global(html.tv)': 'TV focus row; the TV focus design',
  'lib/live/RecordingsRow.svelte:.tv .rtile:focus-visible': 'TV focus tile; the TV focus design',
  'lib/live/TvLiveList.svelte:.trow': 'TV focus row; the TV focus design',
  'lib/player/CreditsSequence.svelte:.tv :is': 'TV focus button; the TV focus design',
  'lib/player/TvControls.svelte::global(html.tv) .back': 'TV focus on an icon button; the TV focus design',
  'lib/player/TvControls.svelte:.sbar:focus-visible .kd': 'TV scrub knob dot; no text',
  'lib/player/TvControls.svelte:<div class="still"': 'TV scrub preview sprite frame (an image); the time label sits outside it',
  'lib/player/TvEpisodesOverlay.svelte::global(html.tv)': 'TV focus row; the TV focus design',
  'lib/player/TvTracks.svelte::global(html.tv)': 'TV focus row; the TV focus design',
  'routes/watch/[id]/+page.svelte::global(html.tv)': 'TV focus button; the TV focus design',
  // artwork, thumbnails and sprites: images with no text inside the scaled box
  'lib/Card.svelte:.thumb:active': 'artwork press on a card thumbnail; an image',
  'lib/Hero.svelte:ff-kenburns': 'hero backdrop drift; an image, the text layer is a sibling',
  'lib/Player.svelte:{#if thumb}': 'seek preview sprite frame; an image',
  'lib/player/ScenesPanel.svelte:{:else if fr}': 'scene sprite frame; an image',
  'lib/Player.svelte:.track:hover .knob': 'seek knob dot; no text',
  'lib/Row.svelte:.row .pg': 'row arrow icon on hover / focus; icon only',
  'lib/CastButton.svelte:.ic:hover': 'cast icon button hover; icon only',
  'lib/Player.svelte:.ic:hover:not(:disabled)': 'player icon button hover; icon only (inside the desk pill, where the text tooltip lives, the button does not scale)',
  'lib/Player.svelte:.pill .ic:hover:not(:disabled) > :global(svg)': 'the icon of a desk pill button; the svg only, its tooltip stays',
  'routes/party/[id]/+page.svelte:.em:hover': 'reaction emoji button hover; a single glyph, no readable text',
  'lib/RatingButton.svelte:.opt:hover svg': 'rating icon; icon only',
  'routes/kids/KidsTile.svelte:.tile:hover img': 'kids tile artwork; images only',
  'lib/detail/DetailTv.svelte:img.animate': 'TV detail backdrop settle; an image',
  'lib/glass/pointer.ts:card:': 'card tilt on artwork cards; row hover depth, not a pop-up',
  'lib/glass/pointer.ts:parts.shadow': 'card tilt shadow layer; no text',
  // icon-only presses, ripples and decorative layers
  'lib/glass/press.ts:ICON_SCALE': 'icon-only press-scale (.92); text controls press by opacity',
  'lib/glass/press.ts:RIPPLE': 'press ripple; a plain disc, no text',
  'lib/Player.svelte:@keyframes rip': 'double-tap ripple; a plain shape, no text',
  'lib/auth/auth.css:.af-secret .icon-btn:active': 'show / hide password icon button; icon only',
  'lib/admin/Halo.svelte:ff-halo': 'decorative ring around a live dot; no text',
  'lib/auth/PasskeyWait.svelte:breathe': 'breathing ring around the fingerprint icon; no text inside',
  'lib/admin/StepList.svelte:ff-pop': 'step dot / check icon pop; the dot holds an icon only, no text',
  'lib/version/VersionEgg.svelte:@keyframes fall': 'easter-egg confetti glyphs falling; no pop-up, no readable text',
  'routes/party/[id]/+page.svelte:@keyframes up': 'floating reaction emoji; a glyph, no readable text',
  // splash logo: tile, flare, bloom and ring hold no text (the wordmark's stage no longer scales)
  'lib/Intro.svelte:@keyframes ff-tile': 'splash logo tile (an SVG); no text',
  'lib/Intro.svelte:@keyframes ff-bloom': 'splash glow; no text',
  'lib/Intro.svelte:@keyframes ff-play': 'splash play mark inside the logo SVG; no text',
  'lib/Intro.svelte:@keyframes ff-flare': 'splash flare; no text',
  'lib/Intro.svelte:@keyframes ff-ring': 'splash ring; no text',
  // TEMPORARY, text-bearing and outside this stage: the phone carousel's side cards (stage 3), the quiet hero title (stage 6)
  'lib/phone/Carousel.svelte:transform:translate3d': 'TEMPORARY: scroll-driven side-card depth of the home carousel, not a pop-up; stage 3 (phone)',
  'lib/Hero.svelte:.hero.quiet h1': 'TEMPORARY: the quiet hero shrinks its title (0.9 s), not a pop-up; stage 6 (audit leftovers)',
  // svelte/animate flip: it scales only an item whose own size changed between its two places; these keep their size and glide
  'lib/ui/ToastHost.svelte:svelte/animate': 'toast reorder glide; each toast keeps its size, so flip only translates',
  'lib/admin/rights/RoleList.svelte:svelte/animate': 'role row reorder glide; a row keeps its size, so flip only translates',
};

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(svelte|css|ts)$/.test(n) && !/\.(test|spec)\.ts$/.test(n)) out.push(p);
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1').replace(/<!--[\s\S]*?-->/g, ' ');
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
const STATE = /:active|\.pressed|:focus|:hover|\.open\b|\.in\b|\.out\b|\.on\b|\.show\b|\.shown\b|\.quiet\b|\[open\]|\[aria-expanded/;
/** a uniform scale in any spelling: `scale()`, `scale3d()`, the `scale` property and `zoom` (a one-axis scaleX / scaleY is a bar's
 * fill, never text) */
const SCALE_FN = /scale(3d)?\(/;
const SCALE_DECL = /(^|[;{\s])(scale|zoom)\s*:\s*[^;]*\d/;
const SPRING_FILES = /(^|\/)lib\/ui\/|lib\/glass\/fx\.ts|MoreActions|ListMenu|\/desk\/|live\/[^/]*Sheet|admin\/.*Sheet|Dialog/;
const SPRING = /springEase|springAt|--m-spring|--fr-spring|--tv-spring/;

/** the rules of a stylesheet: keyframes with their body, other blocks with selector and body (media queries unwrapped) */
function cssBlocks(css: string, out: { at: string; sel: string; body: string }[] = []) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = ws(css.slice(i, open));
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (/^@keyframes/.test(sel)) out.push({ at: 'keyframes', sel, body });
    else if (sel.startsWith('@')) cssBlocks(body, out);
    else out.push({ at: '', sel, body });
    i = j;
    // declarations before a selector (`;`-ended) are not part of the next selector
    const semi = css.slice(i).match(/^\s*;/);
    if (semi) i += semi[0].length;
  }
  return out;
}

type Finding = { file: string; detail: string };
function scan(): Finding[] {
  const found: Finding[] = [];
  for (const abs of walk(SRC)) {
    const file = relative(SRC, abs).split('\\').join('/');
    const raw = readFileSync(abs, 'utf8');
    const styleMatches = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
    const css = file.endsWith('.css') ? raw : styleMatches.map((m) => m[1]).join('\n');
    // the script and markup: the source with the style blocks cut out by position (a source scan, not HTML sanitizing)
    let rest = '';
    let from = 0;
    for (const m of styleMatches) { rest += raw.slice(from, m.index); from = m.index! + m[0].length; }
    rest += raw.slice(from);
    const code = file.endsWith('.css') ? '' : stripComments(rest);
    for (const b of cssBlocks(stripComments(css))) {
      if (b.at === 'keyframes' && (SCALE_FN.test(b.body) || SCALE_DECL.test(b.body))) found.push({ file, detail: b.sel });
      else if (!b.at && STATE.test(b.sel) && (/transform\s*:[^;]*scale(3d)?\(/.test(b.body) || SCALE_DECL.test(b.body))) found.push({ file, detail: b.sel });
    }
    // a JS string (or markup style) building a transform
    for (const line of code.split('\n')) if (SCALE_FN.test(line) || /\b(scale|zoom)\s*:\s*['"`\d.]/.test(line)) found.push({ file, detail: ws(line).slice(0, 160) });
    if (/import\s*\{[^}]*\bscale\b[^}]*\}\s*from\s*['"]svelte\/transition['"]/.test(code)) found.push({ file, detail: "import { scale } from 'svelte/transition'" });
    // svelte/animate's flip scales an item whose size changed between its two places
    if (/import\s*\{[^}]*\bflip\b[^}]*\}\s*from\s*['"]svelte\/animate['"]/.test(code)) found.push({ file, detail: "import { flip } from 'svelte/animate'" });
    if (SPRING_FILES.test('/' + file) || SPRING_FILES.test(file)) {
      for (const line of stripComments(raw).split('\n')) if (SPRING.test(line)) found.push({ file, detail: 'spring in pop-up code: ' + ws(line).slice(0, 140) });
    }
  }
  return found;
}

const allowed = (f: Finding) => Object.keys(ALLOW).some((k) => {
  const at = k.indexOf(':');
  const path = k.slice(0, at), pat = k.slice(at + 1);
  return f.file.includes(path) && f.detail.includes(pat);
});

describe('motion rule', () => {
  const found = scan();
  it('no pop-up or text control animates scale', () => {
    const bad = found.filter((f) => !allowed(f)).map((f) => `${f.file}: ${f.detail}`);
    expect(bad).toEqual([]);
  });
  it('every allow-list key still matches something', () => {
    const stale = Object.keys(ALLOW).filter((k) => {
      const at = k.indexOf(':');
      const path = k.slice(0, at), pat = k.slice(at + 1);
      return !found.some((f) => f.file.includes(path) && f.detail.includes(pat));
    });
    expect(stale).toEqual([]);
  });
});
