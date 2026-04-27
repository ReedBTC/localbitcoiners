import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { resolve } from 'path'

// Build the login widget as a single self-contained IIFE that ships
// alongside the static localbitcoiners index.html. CSS is injected at
// runtime so consumers only need <script src="login-widget.js">.
export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  // Library builds don't substitute `process.env.NODE_ENV` by default —
  // Vite assumes the consumer's bundler will. We're shipping an IIFE to
  // a static page with no further build, so do the substitution here.
  // Also alias `global` to `globalThis` for any deps that reference it.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.jsx'),
      name: 'LBLogin',
      fileName: () => 'login-widget.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../assets/widgets'),
    emptyOutDir: false,
    copyPublicDir: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    minify: 'esbuild',
  },
})
