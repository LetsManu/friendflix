import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
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
  },
};
