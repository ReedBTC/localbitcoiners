/**
 * PWA install affordance.
 *
 * Adds a small bottom-pinned banner on mobile browsers that surfaces
 * "Install Local Bitcoiners" as a real, tappable thing — most users
 * have no idea browsers can install web apps without app stores, so
 * an explicit prompt is the only way they'll discover it.
 *
 * Two paths because the install API is split:
 *   - Chromium-based mobile (Android Chrome, Edge, Brave, Samsung)
 *     fires `beforeinstallprompt`. We capture the deferred prompt and
 *     wire it to a custom Install button. After the user picks
 *     install/dismiss the banner self-clears.
 *   - iOS Safari (and iOS Chrome/Firefox, which are Safari under the
 *     hood) doesn't expose any install API. The only way to install is
 *     Share → Add to Home Screen, so we render an instruction card
 *     pointing at that flow.
 *
 * Suppression rules:
 *   - Skip entirely if already running as an installed PWA
 *     (display-mode: standalone, or iOS navigator.standalone).
 *   - Skip on desktop — PWA-install on desktop is rarely the right
 *     ask on a podcast site, and Reed asked specifically for mobile.
 *   - If the user dismisses, remember for 14 days (localStorage). We
 *     err on the long side because re-prompting too often is more
 *     annoying than a single missed install opportunity.
 *   - On a successful install, suppress for 365 days as a safety
 *     net in case the appinstalled event misses or the user
 *     uninstalls and reinstalls quickly.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var DISMISS_KEY = 'lb_pwa_install_dismissed_until';
  var SESSION_SHOWN_KEY = 'lb_pwa_install_shown_session';
  var DISMISS_MS = 14 * 24 * 60 * 60 * 1000;       // 14 days
  var INSTALLED_MS = 365 * 24 * 60 * 60 * 1000;    // ~1 year
  var SHOW_DELAY_MS = 1500;                         // let the page settle first

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {}
    // iOS Safari exposes navigator.standalone instead of display-mode.
    if (navigator.standalone === true) return true;
    return false;
  }

  function isMobile() {
    // UA-string check is good enough for "show this UI?" — it's not a
    // security boundary, just an audience filter. Covers iOS Safari,
    // Android Chrome/Edge/Samsung, plus most niche mobile browsers.
    var ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|Opera Mini/i.test(ua);
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    // iPadOS 13+ reports as Mac in UA; sniff for touch + Safari quirks.
    if (/Mac/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function isDismissed() {
    try {
      var raw = localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      var until = parseInt(raw, 10);
      if (!Number.isFinite(until)) return false;
      if (Date.now() < until) return true;
      // Expired — clean up so future suppression checks short-circuit.
      localStorage.removeItem(DISMISS_KEY);
      return false;
    } catch (e) { return false; }
  }

  function setDismissedFor(ms) {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + ms)); } catch (e) {}
  }

  // Per-tab "shown once" flag. Without this the banner reappears 1.5s
  // after every internal navigation until the user explicitly dismisses,
  // which is more annoying than informative on a multi-page session.
  // sessionStorage is per-tab and clears when the tab closes.
  function isShownThisSession() {
    try { return sessionStorage.getItem(SESSION_SHOWN_KEY) === '1'; } catch (e) { return false; }
  }
  function markShownThisSession() {
    try { sessionStorage.setItem(SESSION_SHOWN_KEY, '1'); } catch (e) {}
  }

  if (!isMobile()) return;
  if (isStandalone()) return;
  if (isDismissed()) return;
  if (isShownThisSession()) return;

  // Capture the install prompt event before any other handler runs.
  // Fires once on Chromium mobile when the page is eligible for install.
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  // Native install completed — clear our banner if it's still up and
  // mark "don't ask again for a year" since they just installed.
  window.addEventListener('appinstalled', function () {
    setDismissedFor(INSTALLED_MS);
    var el = document.getElementById('lb-pwa-install-banner');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });

  // SECURITY: the innerHTML strings below are concatenated from static
  // literals only — no user data, no remote data, no URL params. Do
  // NOT introduce dynamic interpolation (npub, profile name, query
  // strings, etc.) into these strings; if you need dynamic content,
  // build it via document.createElement + textContent instead.
  function buildBanner() {
    var iosFlow = isIOS() && !deferredPrompt;
    var wrap = document.createElement('div');
    wrap.id = 'lb-pwa-install-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Install Local Bitcoiners app');
    wrap.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:max(12px, env(safe-area-inset-bottom, 12px));' +
      'z-index:88;padding:14px 16px;border-radius:12px;' +
      'background:linear-gradient(180deg,#1e3a5f 0%,#15294a 100%);' +
      'color:#f5eedc;border:1px solid rgba(247,147,26,0.55);' +
      'box-shadow:0 18px 50px -12px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.04);' +
      'font:500 14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'display:flex;align-items:center;gap:12px;' +
      'transform:translateY(120%);opacity:0;transition:transform .25s ease, opacity .25s ease;';

    var iconHtml =
      '<div style="flex:0 0 auto;width:38px;height:38px;border-radius:9px;background:rgba(247,147,26,0.18);' +
      'border:1px solid rgba(247,147,26,0.45);display:flex;align-items:center;justify-content:center;">' +
      '<img src="/assets/LocalBitcoiners.png" alt="" width="28" height="28" style="border-radius:6px;display:block;" />' +
      '</div>';

    var titleHtml =
      '<div style="flex:1 1 auto;min-width:0;">' +
      '<div style="font-weight:600;color:#fff;line-height:1.25;">Install Local Bitcoiners</div>' +
      '<div style="font-size:12px;color:rgba(245,238,220,0.75);margin-top:2px;line-height:1.3;">' +
      (iosFlow
        ? 'Tap <strong>Share</strong> &nbsp;<span aria-hidden="true">⬆︎</span>&nbsp; then <strong>Add to Home Screen</strong>'
        : 'One-tap install — works offline, no app store needed.') +
      '</div>' +
      '</div>';

    var actionHtml = iosFlow
      ? ''
      : '<button type="button" id="lb-pwa-install-btn" style="' +
        'flex:0 0 auto;background:#f7931a;color:#fff;border:none;border-radius:8px;' +
        'padding:9px 14px;font:600 13px system-ui,-apple-system,sans-serif;cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent;">Install</button>';

    var dismissHtml =
      '<button type="button" id="lb-pwa-install-dismiss" aria-label="Dismiss install prompt" style="' +
      'flex:0 0 auto;background:transparent;color:rgba(245,238,220,0.6);border:none;' +
      'padding:6px;cursor:pointer;font:400 18px system-ui;line-height:1;-webkit-tap-highlight-color:transparent;' +
      '">&times;</button>';

    wrap.innerHTML = iconHtml + titleHtml + actionHtml + dismissHtml;
    return wrap;
  }

  function showBanner() {
    if (document.getElementById('lb-pwa-install-banner')) return;
    if (isDismissed()) return;
    if (isStandalone()) return;
    if (isShownThisSession()) return;

    // On Android we wait for beforeinstallprompt before showing — the
    // banner without a working Install button is a dead end. iOS never
    // fires the event, so we show immediately on iOS.
    var iosFlow = isIOS() && !deferredPrompt;
    if (!iosFlow && !deferredPrompt) return;

    markShownThisSession();
    var banner = buildBanner();
    document.body.appendChild(banner);
    // Force layout so the entrance transition fires.
    requestAnimationFrame(function () {
      banner.style.transform = 'translateY(0)';
      banner.style.opacity = '1';
    });

    var dismissBtn = banner.querySelector('#lb-pwa-install-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        setDismissedFor(DISMISS_MS);
        hideBanner(banner);
      });
    }

    var installBtn = banner.querySelector('#lb-pwa-install-btn');
    if (installBtn && deferredPrompt) {
      installBtn.addEventListener('click', function () {
        if (!deferredPrompt) { hideBanner(banner); return; }
        try { deferredPrompt.prompt(); } catch (e) { hideBanner(banner); return; }
        // userChoice resolves with { outcome: 'accepted' | 'dismissed' }.
        // We treat both as "stop nagging" — accepted obviously, dismissed
        // because the native prompt is the user's clearest "no" signal.
        var p = deferredPrompt.userChoice;
        deferredPrompt = null;
        if (p && typeof p.then === 'function') {
          p.then(function (choice) {
            if (choice && choice.outcome === 'accepted') {
              setDismissedFor(INSTALLED_MS);
            } else {
              setDismissedFor(DISMISS_MS);
            }
            hideBanner(banner);
          }).catch(function () { hideBanner(banner); });
        } else {
          hideBanner(banner);
        }
      });
    }
  }

  function hideBanner(banner) {
    if (!banner) return;
    banner.style.transform = 'translateY(120%)';
    banner.style.opacity = '0';
    setTimeout(function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, 260);
  }

  function maybeShow() {
    setTimeout(showBanner, SHOW_DELAY_MS);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    maybeShow();
  } else {
    window.addEventListener('DOMContentLoaded', maybeShow, { once: true });
  }

  // Chromium can fire beforeinstallprompt slightly after load. If we
  // showed an iOS instruction card already, leave it; otherwise, kick
  // off the banner once the event arrives.
  window.addEventListener('beforeinstallprompt', function () {
    if (!document.getElementById('lb-pwa-install-banner')) {
      setTimeout(showBanner, 200);
    }
  });
})();
