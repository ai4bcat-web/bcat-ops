import path from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      scope: '/driver',
      manifest: {
        name: 'BCAT Driver',
        short_name: 'BCAT',
        description: 'Mobile app for BCAT Amazon drivers',
        theme_color: '#1ea8f3',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/driver',
        start_url: '/driver',
        icons: [
          { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The staff SPA bundle is several MB. Precaching it would force a driver on a
        // phone to download the entire office app before the PWA installs, so precache
        // only the shell and let the JS land in the cache on first use instead.
        globPatterns: ['**/*.{css,html,ico,png,svg,webmanifest,woff2}'],
        navigateFallbackDenylist: [/^\/(?!driver)/],
        /*
         * The shell comes from the NETWORK first, and from the cache only when there is
         * no network.
         *
         * It used to be served from the precache, and that is how a driver gets a white
         * screen. Vite stamps a hash into the bundle filename and every deploy replaces
         * it, so an index.html cached by an older service worker points at a file that is
         * no longer on the server. The script 404s, nothing runs, the page is blank — and
         * reloading does not help, because the reload is answered by the same cached
         * shell. There is one bundle and no code splitting, so no JS gets far enough to
         * recover it either.
         *
         * Fetching the shell fresh means the HTML a driver loads always names a bundle
         * that exists. Five seconds, then fall back to the cached copy, so a phone with no
         * signal at a dock still opens the app.
         */
        navigateFallback: undefined,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }: { request: Request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'bcat-driver-shell',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 16 },
            },
          },
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.endsWith('.js'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'bcat-driver-js' },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
    environment: 'node',
    // The jsdom render tests drive real user events; at 132 files the default 5s
    // starts timing out on a loaded machine while the same test passes alone.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
