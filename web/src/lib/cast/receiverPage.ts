// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The HTML and the Content-Security-Policy of FriendFlix's own Cast receiver (routes/cast-receiver/+server.ts). Its scripts and
 * styles are static files (web/static/cast-receiver/). The idle screen shows the instance's brand (name, byline, symbol, accent),
 * rendered here from the public brand the web server fetched (lib/manifest.ts cachedManifestBrand): every text escaped, the colours
 * only the validated #rrggbb tokens, the symbol only a URL of the public brand image route (parseBrand checks all three).
 */
import { brandInitial, brandPalette, builtInMark, DEFAULT_LOADED, isDefaultAccent, type LoadedBrand } from '#lib/brand';

const HEX = /^#[0-9a-f]{6}$/;
const IMAGE_URL = /^\/api\/public\/brand\/img\/[0-9a-f]{64}\.(png|webp)$/;
/** HTML text and attribute escaping (the brand's texts are the admin's, but never markup) */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Google's Cast Application Framework (CAF v3) receiver script */
export const CAF_URL = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';

/**
 * Only for /cast-receiver/:
 * - script-src: own origin + Google's Cast receiver libraries (CAF loads its media player / Shaka from these paths;
 *   TODO verify on hardware: should a device load a player library from another Google path, add only that path);
 * - media / connect: own origin (the /media/c/<token>/ stream, /api/cast/report) plus blob: for the MSE player;
 * - no frames, no objects, no forms, no embedding.
 */
export const RECEIVER_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.gstatic.com/cast/sdk/libs/ https://ajax.googleapis.com/ajax/libs/shaka-player/",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** the brand's colours over receiver.css's defaults (an inline style: the receiver's CSP allows it); nothing for today's coral */
function brandStyle(b: LoadedBrand): string {
  if (isDefaultAccent(b.tokens)) return '';
  const p = brandPalette(b.tokens);
  const vars: Array<[string, string]> = [['--acc', b.tokens.acc], ['--acc-fill', b.tokens.accFill], ['--coral', p.glassText]];
  return vars.every(([, v]) => HEX.test(v)) ? ` style="${vars.map(([k, v]) => `${k}: ${v}`).join('; ')}"` : '';
}

/** the idle screen's brand: today's mark and name for the default brand, else the symbol (upload, F tile or initial), name and byline */
function brandBlock(b: LoadedBrand): string {
  const name = esc(b.name);
  const by = b.brand.byline.trim();
  const sym = b.images.symbol && IMAGE_URL.test(b.images.symbol)
    ? `<img src="${b.images.symbol}" alt="">`
    : builtInMark(b) && isDefaultAccent(b.tokens)
      ? '<img src="/logo-icon.svg" alt="">'
      : builtInMark(b)
        ? `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${esc(brandPalette(b.tokens).markFrom)}"/><stop offset="1" stop-color="${esc(brandPalette(b.tokens).markTo)}"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="15" fill="url(#g)"/><path fill="#fff" d="M19 18a4 4 0 0 1 4-4h23a4 4 0 0 1 0 8H28v28a4.500 4.500 0 0 1-9 0z"/><path fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round" d="M33.500 29.500 45.500 36 33.500 42.500z"/></svg>`
        : `<span class="initial">${esc(brandInitial(b.name))}</span>`;
  return by ? `<div>${sym}<span class="names"><span class="nm">${name}</span><span class="by">${esc(by)}</span></span></div>` : `<div>${sym}${name}</div>`;
}

/** the receiver page (no user data in it: everything else comes from the sender over the Cast channel; the brand is public) */
export function receiverHtml(b: LoadedBrand = DEFAULT_LOADED): string {
  return `<!doctype html>
<html lang="en"${brandStyle(b)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name)}</title>
<link rel="stylesheet" href="/cast-receiver/receiver.css">
<script src="${CAF_URL}"></script>
<script type="module" src="/cast-receiver/receiver.js"></script>
</head>
<body class="idle">
<video id="v"></video>
<div class="brand" aria-hidden="true">${brandBlock(b)}</div>
<div id="scrim" class="scrim fx flat" aria-hidden="true"></div>
<div id="who" class="who fx" role="status"></div>
<button id="skip" class="skip" hidden></button>
<section id="card" class="card panel fx" aria-live="polite">
<div class="art thumb"><img id="card-img" alt="" hidden></div>
<div>
<h2 id="card-title" aria-live="off"></h2>
<p id="card-name" class="name clamp"></p>
<p id="card-hint" class="hint"></p>
</div>
<div id="card-buttons" class="btns" hidden><button id="card-primary" class="focus"></button><button id="card-secondary"></button></div>
<div class="cbar"><i></i></div>
</section>
<section id="pause" class="pause panel fx" aria-live="polite">
<div class="head"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="5" height="18" rx="1.5"></rect><rect x="14" y="3" width="5" height="18" rx="1.5"></rect></svg><span id="pause-label"></span></div>
<h2 id="pause-title" class="clamp"></h2>
<p id="pause-line" class="line clamp"></p>
<div class="pbar"><i id="pause-fill"></i></div>
<div class="times"><span id="pause-pos"></span><span id="pause-dur"></span></div>
</section>
<section id="load" class="load fx flat" aria-live="polite">
<div class="art"><img id="load-art" alt="" hidden></div>
<h2 id="load-title" class="clamp"></h2>
<p id="load-line" class="line clamp"></p>
<div class="ind"><i></i></div>
<p id="load-label" class="label"></p>
</section>
<div id="badge" class="badge fx" aria-hidden="true"><i></i><span id="badge-text"></span></div>
<section id="lcard" class="lcard panel fx" aria-live="polite">
<div class="art logo"><img id="lcard-img" alt="" hidden></div>
<div>
<h2 id="lcard-name" class="clamp"></h2>
<p id="lcard-now" class="line clamp"></p>
</div>
</section>
<section id="still" class="hold fx flat" aria-live="assertive">
<div class="panel">
<h2 id="still-title"></h2>
<p id="still-text"></p>
<p id="still-hint" class="hint"></p>
<button id="still-primary" hidden></button>
</div>
</section>
</body>
</html>
`;
}
