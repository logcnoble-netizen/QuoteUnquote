/** @type {import('tailwindcss').Config} */
// Compiled Tailwind build (replaces the Play CDN). `content` is scanned so only
// utilities actually referenced in markup/JS are emitted — the design is almost
// entirely custom CSS in public/styles.css, so this output is mostly Preflight
// (the base reset the CDN was providing) plus any utilities in use.
module.exports = {
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Space Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
