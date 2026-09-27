import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// BASE_PATH is set by the GitHub Pages workflow (e.g. /stuPad/); defaults to / for local dev and other hosts.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  // The app version shown in Setup and the page title comes from package.json: bump it there only.
  // Available as import.meta.env.VITE_APP_VERSION in code and %VITE_APP_VERSION% in index.html.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['template.pptx', 'icons/*.png', 'fonts/*'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,pptx}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: 'GGPad Kiosk',
        short_name: 'GGPad',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#000080',
        theme_color: '#000080',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['fake-indexeddb/auto'],
  },
});
