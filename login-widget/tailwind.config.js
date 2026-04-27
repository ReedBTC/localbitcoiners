/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,jsx}'],
  // No preflight — we don't want to reset the host site's styles. The
  // widget is mounted in a portal alongside the existing page; only our
  // own elements should pick up styling.
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
}
