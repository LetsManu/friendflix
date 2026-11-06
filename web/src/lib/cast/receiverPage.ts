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
<button id="skip" class="skip" hidden></button>
<section id="card" class="card" hidden aria-live="polite">
<h2 id="card-title"></h2>
<p id="card-text"></p>
<div class="bar"><i></i></div>
<div class="btns"><button id="card-primary" class="focus"></button><button id="card-secondary"></button></div>
</section>
<section id="still" class="still" hidden aria-live="assertive">
<h2 id="still-title"></h2>
<p id="still-text"></p>
<div><button id="still-primary"></button></div>
</section>
</body>
</html>
`;
}
