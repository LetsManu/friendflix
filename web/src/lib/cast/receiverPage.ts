// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The HTML and the Content-Security-Policy of FriendFlix's own Cast receiver (routes/cast-receiver/+server.ts). Its scripts and
 * styles are static files (web/static/cast-receiver/).
 */

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

/** the receiver page (no user data in it: everything else comes from the sender over the Cast channel) */
export function receiverHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FriendFlix</title>
<link rel="stylesheet" href="/cast-receiver/receiver.css">
<script src="${CAF_URL}"></script>
<script type="module" src="/cast-receiver/receiver.js"></script>
</head>
<body class="idle">
<video id="v"></video>
<div class="brand" aria-hidden="true"><div><img src="/logo-icon.svg" alt="">FriendFlix</div></div>
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
