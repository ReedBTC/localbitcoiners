import { defineConfig } from 'vite'
import { resolve } from 'path'

// Second build target — vendored nostr-tools bundle for the static
// HTML pages (boosts.html). Replaces a runtime import from esm.sh,
// which had no SRI and gave anyone who could MITM the CDN full
// access to our origin. Self-hosting + the strict `script-src 'self'`
// CSP added in the same change closes that class.
//
// Output: `assets/widgets/nostr-tools.js` as an ES module. Imported
// in boosts.html via `<script type="module">`.
export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/nostr-tools-entry.js'),
      fileName: () => 'nostr-tools.js',
      formats: ['es'],
    },
    outDir: resolve(__dirname, '../assets/widgets'),
    emptyOutDir: false,
    copyPublicDir: false,
    minify: 'esbuild',
  },
})
