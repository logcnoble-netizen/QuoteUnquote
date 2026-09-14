/* Meta Pixel SDK loader stub (Meta's standard base code, from Events Manager
   > Data Sources > your Pixel > Set Up > Meta Pixel > Install manually).
   Vendored as a static file (not inlined) so the strict CSP here never needs
   'unsafe-inline' for scripts. Defines window.fbq's queueing stub only — it
   never calls fbq('init', ...) itself, so the pixel stays inert with no ID
   configured. app.js calls fbq('init', pixelId) + fbq('track','PageView')
   once /api/config confirms a pixel id is set, so the ID lives in an env
   var, not committed code (same split as public/vendor/tiktok-pixel.js). */
!function (f, b, e, v, n, t, s) {
  if (f.fbq) return;
  n = f.fbq = function () {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
  };
  if (!f._fbq) f._fbq = n;
  n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
  t = b.createElement(e); t.async = !0; t.src = v;
  s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
}(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
