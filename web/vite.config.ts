import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Dev: the browser talks to one origin; proxy API, auth, media and websockets to the backend/gateway.
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/media': 'http://localhost:4000',
    },
  },
});
