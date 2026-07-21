# Print-engine fonts

The server-side print renderer (`src/printEngine.js`) registers the bundled
`Inter-Regular.ttf` / `Inter-Bold.ttf` (Inter 4.1, SIL Open Font License — see
LICENSE.txt) so the printed comment renders in the exact same typeface as the
on-site mockup.

These files are **committed on purpose**: without them, Linux deploys fall back
to a wider generic sans-serif, which changes where handles and comments wrap on
the physical print vs. what the customer previewed.
