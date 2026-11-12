import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the static build can be served from any sub-path.
  base: './',
  server: {
    host: true,
    // The dev server is reached through a proxied preview hostname.
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    // three.js is the whole bundle; it is one chunk by design.
    chunkSizeWarningLimit: 800,
  },
});
