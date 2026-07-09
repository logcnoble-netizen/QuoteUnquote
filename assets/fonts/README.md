# Print-engine fonts (optional)

The server-side print renderer (`src/printEngine.js`) will use bundled font
files here to make the printed comment match the on-site Instagram look exactly.

Drop these TrueType files in this folder to enable them:

- `Inter-Regular.ttf`
- `Inter-Bold.ttf`

Get them from https://rsms.me/inter/ (SIL Open Font License). Once present,
`printEngine` registers them automatically and renders in **Inter**. If they are
absent, it falls back to the platform default sans-serif — the print still
generates, it just won't be pixel-identical to the browser mockup.

> `.ttf`/`.otf` files are git-ignored by default (see root `.gitignore`) so the
> repo stays binary-free. Commit them intentionally if you want them deployed,
> or add a build step that downloads them.
