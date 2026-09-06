/* Shared nav helpers. Currently just the outside-click closer for the
   "More ▾" details dropdown — clicking anywhere outside an open
   dropdown collapses it, matching the affordance users expect from
   a top-of-page menu. */
(function () {
  'use strict'
  document.addEventListener('click', function (e) {
    var open = document.querySelectorAll('details.nav-more[open]')
    for (var i = 0; i < open.length; i++) {
      if (!open[i].contains(e.target)) open[i].removeAttribute('open')
    }
  })
  // Also collapse when the user picks an item — anchor clicks inside
  // the menu would otherwise leave the dropdown stuck open during
  // the same-page hash-jump.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('.nav-more-menu a')
    if (!a) return
    var d = a.closest('details.nav-more')
    if (d) d.removeAttribute('open')
  })

  // ── "Explore" menu (homepage) — same affordances, plus Esc, the ✕
  //    close button, and a body scroll-lock for the mobile overlay. ──
  function closeExplore() {
    var open = document.querySelectorAll('details.nav-explore[open]')
    for (var i = 0; i < open.length; i++) open[i].removeAttribute('open')
  }
  // Outside-click close.
  document.addEventListener('click', function (e) {
    var open = document.querySelectorAll('details.nav-explore[open]')
    for (var i = 0; i < open.length; i++) {
      if (!open[i].contains(e.target)) open[i].removeAttribute('open')
    }
  })
  // Close on link pick or the ✕ button.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest &&
      e.target.closest('.nav-explore-panel a, .nav-explore-close')
    if (!t) return
    var d = t.closest('details.nav-explore')
    if (d) d.removeAttribute('open')
  })
  // Esc closes.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeExplore()
  })
  // Lock body scroll while the mobile full-screen overlay is open. The
  // `toggle` event doesn't bubble, so listen in the capture phase.
  document.addEventListener('toggle', function (e) {
    var d = e.target
    if (d && d.tagName === 'DETAILS' && d.classList && d.classList.contains('nav-explore')) {
      document.body.classList.toggle('nav-explore-open', d.open)
    }
  }, true)

  // ── "Report a bug" trigger (More ▾ dropdown item, sitewide) ──────────
  // Lazy-loads the login-widget bundle on demand and opens the bug-report
  // modal (which gates login itself). The bundle has an internal
  // double-load guard, so injecting it here is safe even when a page also
  // lazy-loads it for boosts/identity.
  function ensureWidget() {
    if (window.LBLogin) return Promise.resolve()
    if (window.__lbWidgetLoad) return window.__lbWidgetLoad
    window.__lbWidgetLoad = new Promise(function (resolve, reject) {
      // If a page loader already injected the bundle, just wait for it.
      var existing = document.querySelector('script[src*="login-widget.js"]')
      if (existing && !window.LBLogin) {
        var iv = setInterval(function () { if (window.LBLogin) { clearInterval(iv); resolve() } }, 60)
        setTimeout(function () { clearInterval(iv); window.LBLogin ? resolve() : reject(new Error('widget load timeout')) }, 15000)
        return
      }
      var s = document.createElement('script')
      s.src = '/assets/widgets/login-widget.js'
      s.async = true
      s.onload = function () { Promise.resolve().then(resolve) }
      s.onerror = function () { window.__lbWidgetLoad = null; reject(new Error('widget load failed')) }
      document.head.appendChild(s)
    })
    return window.__lbWidgetLoad
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-lb-bug-trigger]')
    if (!t) return
    e.preventDefault()
    ensureWidget().then(function () {
      if (window.LBLogin && window.LBLogin.openBugReport) window.LBLogin.openBugReport()
    }).catch(function (err) { console.error('[lb] bug-report widget load failed', err) })
  })

  // ── Cart icon (sitewide) ─────────────────────────────────────────────
  // The merch cart lives in sessionStorage (key 'lb_merch_cart', written by
  // merch.js). The nav shows a running item-count badge on every page and
  // routes clicks to the cart modal in place once the homepage's Marketplace
  // tab has hydrated (feeds-market.js exposes window.openMerchCart), or to
  // /#market-cart from anywhere else. The badge refreshes on a
  // 'lb-cart-changed' event merch.js fires when the cart mutates, plus on
  // tab-focus / bfcache restore.
  function cartItemCount() {
    try {
      var c = JSON.parse(sessionStorage.getItem('lb_merch_cart') || '{}')
      return Object.keys(c).reduce(function (sum, k) { return sum + (Number(c[k]) || 0) }, 0)
    } catch (e) { return 0 }
  }
  function updateNavCart() {
    var link = document.getElementById('nav-cart-link')
    if (!link) return
    var badge = document.getElementById('nav-cart-badge')
    var n = cartItemCount()
    if (badge) {
      badge.textContent = n ? String(n) : ''
      badge.style.display = n ? 'flex' : 'none'
    }
    // Don't show an empty cart on pages you can't shop from; always show it
    // while the Marketplace tab is open so the cart is reachable while
    // browsing (the shop's own surface, since /merch was folded in there).
    // The feeds live on the homepage since feeds-homepage (lb-v80); the old
    // /feeds path is kept in the test for anyone on a cached copy of it.
    var shopping = /^\/(index\.html)?$|\/feeds(\.html)?$/.test(location.pathname) &&
      document.body.getAttribute('data-active-feed') === 'market'
    link.style.display = (n > 0 || shopping) ? '' : 'none'
  }
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest && e.target.closest('#nav-cart-link')
    if (!link) return
    // Once the Marketplace tab has hydrated, open the modal in place instead
    // of navigating.
    if (typeof window.openMerchCart === 'function') {
      e.preventDefault()
      window.openMerchCart()
    }
    // Otherwise let the anchor navigate to /#market-cart (the homepage's tab
    // shell routes that to the Marketplace tab and opens the cart on arrival).
  })
  window.addEventListener('lb-cart-changed', updateNavCart)
  // Switching to/from the Marketplace tab changes whether an empty cart shows.
  document.addEventListener('lb:feed-activate', updateNavCart)
  window.addEventListener('pageshow', updateNavCart)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') updateNavCart()
  })
  updateNavCart()
})()
