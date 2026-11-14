// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { localeManifest } from './src/service-worker/precache.ts';
import { kitVersionName } from './src/lib/version/kit-version.ts';

/** Writes /_app/locales.json (language → its chunk files) for the service worker's offline language precache. */
const localeChunks = (): Plugin => ({
  name: 'ff-locale-manifest',
  apply: 'build',
  generateBundle(_opts, bundle) {
    const m = localeManifest(bundle as unknown as Parameters<typeof localeManifest>[0]);
    if (m) this.emitFile({ type: 'asset', fileName: '_app/locales.json', source: JSON.stringify(m) });
  },
});

export default defineConfig({
  plugins: [
    localeChunks(),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter(),
      // reproducible builds: git sha / SOURCE_DATE_EPOCH instead of SvelteKit's default Date.now() (docs/reproducible-builds.md)
      version: { name: kitVersionName(process.env) },
      // Strict CSP: only own origin. hls.js needs blob: for its worker and media source. hooks.server.ts adds this host's websocket
      // origin to connect-src at request time (web/server/headers.js); the prerendered /offline page's <meta> policy keeps 'self'.
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          // gstatic: Google Cast sender SDK (loaded lazily by lib/cast.ts, only on Chromium when casting is enabled), path-scoped.
          // TODO verify on hardware (Chrome + Chromecast): if the SDK loads further scripts from other gstatic paths, add only those paths.
          'script-src': ['self', 'https://www.gstatic.com/cv/js/sender/', 'https://www.gstatic.com/cast/sdk/libs/'],
          // Styles: stylesheets from the own origin only; no <style> element anywhere (the build emits CSS files, nothing injects
          // one), so an injected <style> (CSS selector exfiltration) is refused. style="" attributes stay allowed: Svelte renders and
          // sets them (style:, dynamic style values, skeleton sizes), and a hash or nonce cannot cover an attribute.
          // style-src keeps 'unsafe-inline' only for engines without CSP Level 3 (the old Chromium of the Tizen and webOS TVs reads
          // neither -elem nor -attr); every current browser uses the two split directives instead.
          'style-src': ['self', 'unsafe-inline'],
          'style-src-elem': ['self'],
          'style-src-attr': ['unsafe-inline'],
          'font-src': ['self', 'data:'],
          'img-src': ['self', 'data:', 'blob:'],
          'media-src': ['self', 'blob:'],
          // websockets (/ws/party, /ws/remote) are same-host: 'self' covers them in CSP Level 3 browsers, the hook adds wss://<host> and ws://<host>
          'connect-src': ['self'],
          'frame-src': ['https://www.youtube-nocookie.com'],
          'worker-src': ['self', 'blob:'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'frame-ancestors': ['none'],
          'form-action': ['self'],
        },
      },
    }),
  ],
  // Dev: the browser talks to one origin; proxy API, auth, media and websockets to the backend/gateway.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/media': 'http://localhost:4000',
    },
  },
});
