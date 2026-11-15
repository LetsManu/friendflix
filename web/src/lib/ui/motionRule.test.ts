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
  // TV focus design (the owner keeps it): focused tiles, rows and buttons on html.tv
  'app.css:html.tv': 'TV focus scale; the TV focus design the owner keeps',
  'lib/tv/:': 'TV focus tiles and rails; the TV focus design the owner keeps',
  'lib/BrandHubs.svelte::global(html.tv)': 'TV focus tile; the TV focus design',
  'lib/BrandHubs.svelte:.tile:hover, .tile:focus-visible': 'brand logo tile lift; logo artwork only (the reduced-motion rule drops it)',
  'lib/LangPick.svelte:.tvlp': 'TV focus option; the TV focus design',
  'lib/Player.svelte::global(html.tv) .ic:focus-visible': 'TV focus on an icon button; no text',
  'lib/detail/DetailTv.svelte::global(html.tv)': 'TV focus button; the TV focus design',
  'lib/detail/TvEpisodes.svelte::global(html.tv)': 'TV focus row; the TV focus design',
  'lib/detail/TvSub.svelte:.rcol': 'TV focus on a cast avatar image; no text in the scaled box',
  'lib/live/FavOrderSheet.svelte:.tv .row:focus-within': 'TV focus row; the TV focus design',
  'lib/live/FavTiles.svelte:.tv .': 'TV focus tile; the TV focus design',
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
  // TEMPORARY, text-bearing and outside this stage (reported to the controller): hover / desktop preview cards zoom out of their card
  'lib/HoverPreview.svelte:el.animate': 'TEMPORARY: card-to-preview FLIP zoom of a text-bearing preview; own stage, tracked in the report',
  'lib/desk/DeskPreview.svelte:grow = el.animate': 'TEMPORARY: card-to-preview FLIP zoom of a text-bearing preview; own stage, tracked in the report',
  'lib/desk/DeskPreview.svelte:shrink = el.animate': 'TEMPORARY: preview-to-card FLIP shrink of a text-bearing preview; own stage, tracked in the report',
  'lib/phone/Carousel.svelte:transform:translate3d': 'TEMPORARY: scroll-driven side-card depth of the home carousel, not a pop-up (Stage 6)',
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
const STATE = /:active|\.pressed|:focus|\.open\b|\.in\b|\.out\b/;
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
      if (b.at === 'keyframes' && /scale\(/.test(b.body)) found.push({ file, detail: b.sel });
      else if (!b.at && /transform\s*:[^;]*scale\(/.test(b.body) && STATE.test(b.sel)) found.push({ file, detail: b.sel });
    }
    // a JS string (or markup style) building a transform
    for (const line of code.split('\n')) if (/scale\(/.test(line)) found.push({ file, detail: ws(line).slice(0, 160) });
    if (/import\s*\{[^}]*\bscale\b[^}]*\}\s*from\s*['"]svelte\/transition['"]/.test(code)) found.push({ file, detail: "import { scale } from 'svelte/transition'" });
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
