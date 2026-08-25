import { defineConfig } from 'vite'
import { resolve } from 'path'

// Third build target — the edge signer. See src/nostr-sign-entry.js for why
// this is vendored rather than installed.
//
// Output: `functions/_shared/nostr-sign.js`, ESM, consumed by
// `functions/api/sign-boost.js`.
//
// ⚠️ NOT an `ssr: true` build. That mode externalises dependencies, so it emits
// a 0.2KB file that re-exports `nostr-tools/pure` by bare specifier — which is
// exactly the npm import the edge cannot resolve. The browser lib mode is what
// inlines them, and nostr-tools is isomorphic: @noble reads `globalThis.crypto`,
// which a V8 isolate provides.
export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/nostr-sign-entry.js'),
      fileName: () => 'nostr-sign.js',
      formats: ['es'],
    },
    outDir: resolve(__dirname, '../functions/_shared'),
    emptyOutDir: false,
    copyPublicDir: false,
    minify: 'esbuild',
  },
})
