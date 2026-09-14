/* Shared ad-pixel bootstrapper for pages that don't load app.js
   (track/terms/privacy/shipping). index.html initializes pixels itself,
   inline in app.js's loadConfig(), since it already fetches /api/config for
   other reasons — this file exists only to avoid duplicating that fetch
   across four static pages. Requires /vendor/tiktok-pixel.js and
   /vendor/meta-pixel.js loaded first. */
(function () {
  'use strict';
  fetch('/api/config')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;
      if (cfg.tiktokPixelId && typeof window.ttq !== 'undefined') {
        window.ttq.load(cfg.tiktokPixelId);
        window.ttq.page();
      }
      if (cfg.metaPixelId && typeof window.fbq !== 'undefined') {
        window.fbq('init', cfg.metaPixelId);
        window.fbq('track', 'PageView');
      }
    })
    .catch(function () { /* analytics failures must never affect the page */ });
})();
