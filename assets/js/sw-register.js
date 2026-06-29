/* Service-worker registration + auto-update.
 *
 * Registering /sw.js gives the site offline caching (see sw.js for the
 * strategy). The extra logic here fixes a real problem we hit: when we ship a
 * new VERSION, returning visitors — especially mobile browsers and INSTALLED
 * PWAs — could keep running the OLD service worker (and its cached CSS/JS) for
 * a long time, because the browser only checks for SW updates occasionally. So
 * a deploy looked "stuck" on mobile even after a bunch of refreshes.
 *
 * Two additions on top of a plain register():
 *  1. Force an update check on load AND whenever the tab/app regains focus, so
 *     a resumed PWA notices a new version promptly instead of waiting ~24h.
 *  2. When a newly-installed SW activates and takes control (controllerchange),
 *     reload the page once so the fresh assets actually take effect. Guarded so
 *     it never fires on a first-ever load (the initial claim) and never loops.
 *
 * sw.js already calls skipWaiting()/clients.claim(), so a new version activates
 * immediately rather than waiting for every tab to close. With this file, the
 * only thing to bump on an asset change stays the VERSION in sw.js — no
 * per-asset cache-busting query strings to keep in sync.
 *
 * Tradeoff: a returning visitor may see a single, one-time auto-refresh right
 * after a deploy. It can't loop (guarded), and it won't fire on first visit.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;

  // Only auto-reload when an EXISTING controller is replaced by a new one — not
  // on the initial claim of a first-ever visit (that would reload needlessly).
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      // Resumed tab / reopened PWA → check for a newer SW right away.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          try { reg.update(); } catch (e) {}
        }
      });
    }).catch(function () {});
  });
})();
