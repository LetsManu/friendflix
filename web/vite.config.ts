import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter(),
      // Strict CSP: only own origin. hls.js needs blob: for its worker and media source; styles are inline from Svelte.
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self', 'unsafe-inline'],
          'font-src': ['self', 'data:'],
          'img-src': ['self', 'data:', 'blob:'],
          'media-src': ['self', 'blob:'],
          'connect-src': ['self', 'ws:', 'wss:'],
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
