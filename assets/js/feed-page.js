/* The feed pages' shell: /events, /market, /podcasts, /articles
 * (rails-homepage, 2026-11). The lazy widget loader and the triggers the
 * homepage's inline block used to carry for the feeds (the nav's Boost and
 * Log in controls, the Create Event button, the Find-an-Event modal), plus
 * the page's share of the URL: the feed's controls are plain query params
 * on the page itself (/events?range=1m&type=virtual), written here from
 * the renderers' lb:feed-params and read back by feed-url.js.
 *
 * Classic deferred script, like nav.js. The feeds themselves are feeds.js
 * (a module), which hydrates the one panel on the page off
 * <body data-active-feed>. */
(function () {
  'use strict';

  // One loader promise shared with every other trigger (widget-loader.js
  // for module callers, nav.js for the bug-report item): the bundle is 1MB
  // and two racing triggers must not parse it twice. Keep in step with
  // assets/js/widget-loader.js and index.html's inline copy.
  function ensureWidgetLoaded() {
    if (window.LBLogin) return Promise.resolve();
    if (window.__lbWidgetLoad) return window.__lbWidgetLoad;
    window.__lbWidgetLoad = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src*="login-widget.js"]');
      if (existing) {
        var started = Date.now();
        var iv = setInterval(function () {
          if (window.LBLogin) { clearInterval(iv); resolve(); return; }
          if (Date.now() - started > 15000) {
            clearInterval(iv);
            window.__lbWidgetLoad = null;
            reject(new Error('login widget load timed out'));
          }
        }, 60);
        return;
      }
      var s = document.createElement('script');
      s.src = '/assets/widgets/login-widget.js';
      s.async = true;
      s.onload = function () { Promise.resolve().then(resolve); };
      s.onerror = function () {
        window.__lbWidgetLoad = null;
        reject(new Error('Failed to load login widget'));
      };
      document.head.appendChild(s);
    });
    return window.__lbWidgetLoad;
  }
  window.__lbEnsureWidgetLoaded = ensureWidgetLoaded;

  // ── Nav: Boost the Show ──
  var boostPh = document.querySelector('[data-lb-boost-trigger="show"]');
  if (boostPh) {
    boostPh.addEventListener('click', function () {
      boostPh.disabled = true;
      var long = boostPh.querySelector('.lb-label-long');
      var short = boostPh.querySelector('.lb-label-short');
      var prevLong = long ? long.textContent : '';
      var prevShort = short ? short.textContent : '';
      if (long) long.textContent = 'Loading…';
      if (short) short.textContent = '…';
      ensureWidgetLoaded().then(function () {
        if (window.LBLogin && window.LBLogin.openShowBoost) window.LBLogin.openShowBoost();
      }).catch(function (e) {
        if (long) long.textContent = prevLong;
        if (short) short.textContent = prevShort;
        boostPh.disabled = false;
        console.error('[lb] widget load failed', e);
      });
    });
  }

  // ── Nav: identity slot ──
  var identitySlot = document.getElementById('lb-identity-slot');
  function renderIdentitySignIn() {
    if (!identitySlot) return;
    identitySlot.innerHTML =
      '<button type="button" class="lb-identity-placeholder" aria-label="Log in to Local Bitcoiners"><img src="/assets/favicon.png" alt="" aria-hidden="true" width="18" height="18">Log in</button>';
    var btn = identitySlot.querySelector('button');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = '…';
      ensureWidgetLoaded().then(function () {
        if (window.LBLogin && window.LBLogin.requestLogin) window.LBLogin.requestLogin();
      }).catch(function (e) {
        btn.textContent = prev;
        btn.disabled = false;
        console.error('[lb] widget load failed', e);
      });
    });
  }
  if (identitySlot) {
    var hasSession = false;
    try { hasSession = !!localStorage.getItem('lb_nostr_session'); } catch (e) {}
    if (hasSession) {
      identitySlot.innerHTML = '<div class="lb-identity-restoring" aria-label="Loading account"></div>';
      ensureWidgetLoaded().catch(function (e) {
        console.warn('[lb] eager widget load failed', e);
        renderIdentitySignIn();
      });
    } else {
      renderIdentitySignIn();
    }
  }

  // ── Create Event → the widget's create-meetup modal ──
  // Delegated: feeds.js repaints the button inside the Featured box on every
  // repaint, so no single element can carry the listener.
  document.addEventListener('click', function (e) {
    var createBtn = e.target && e.target.closest && e.target.closest('.event-create-btn');
    if (!createBtn || createBtn.disabled) return;
    var label = createBtn.querySelector('span:last-child');
    var prev = label ? label.textContent : '';
    createBtn.disabled = true;
    if (label) label.textContent = 'Loading…';
    ensureWidgetLoaded().then(function () {
      if (window.LBLogin && window.LBLogin.openMeetupModal) return window.LBLogin.openMeetupModal('create');
    }).catch(function (err) {
      console.error('[lb] create meetup load failed', err);
    }).then(function () {
      createBtn.disabled = false;
      if (label) label.textContent = prev;
    });
  });

  // ── Find an Event to Feature: the accordion modal (events page only) ──
  (function () {
    var modal = document.getElementById('event-find-modal');
    if (!modal) return;
    var closeBtn = document.getElementById('event-find-close');
    var prewarmed = false;
    var lastTrigger = null;

    function onKey(e) { if (e.key === 'Escape') closeModal(); }
    function openModal() {
      modal.hidden = false;
      document.addEventListener('keydown', onKey);
      if (!prewarmed) {
        prewarmed = true;
        ensureWidgetLoaded().catch(function (e) { console.warn('[lb] find prewarm failed', e); });
      }
      if (closeBtn) closeBtn.focus();
    }
    function closeModal() {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey);
      if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.feed-find-btn');
      if (!btn) return;
      lastTrigger = btn;
      openModal();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

    var findRoots = {};
    function ensureFlowMounted(kind, body) {
      if ((kind !== 'my' && kind !== 'search') || findRoots[kind] || !body) return;
      findRoots[kind] = true;
      ensureWidgetLoaded().then(function () {
        if (window.LBLogin && window.LBLogin.mountFindFlow) {
          body.innerHTML = '';
          findRoots[kind] = window.LBLogin.mountFindFlow(kind, body, { onBoosted: closeModal });
        } else {
          findRoots[kind] = null;
        }
      }).catch(function (e) {
        findRoots[kind] = null;
        console.error('[lb] mount find flow failed', e);
        if (body && !body.childNodes.length) {
          body.innerHTML = '<p class="ec-acc-placeholder">Couldn’t load — please try again.</p>';
        }
      });
    }

    var heads = Array.prototype.slice.call(modal.querySelectorAll('.ec-acc-head'));
    heads.forEach(function (head) {
      head.addEventListener('click', function () {
        var body = modal.querySelector('[data-acc-body="' + head.dataset.acc + '"]');
        var willOpen = head.getAttribute('aria-expanded') !== 'true';
        heads.forEach(function (h) {
          var b = modal.querySelector('[data-acc-body="' + h.dataset.acc + '"]');
          var open = h === head && willOpen;
          h.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (b) b.hidden = !open;
        });
        if (willOpen && body) {
          ensureFlowMounted(head.dataset.acc, body);
          var input = body.querySelector('input');
          if (input) input.focus();
        }
      });
    });
  })();

  // ── The URL ──
  // The nav cart's /market?cart=1 opens the cart once the catalog is merged
  // (feeds-market.js consumes the flag); the key is dropped so a reload does
  // not reopen it. Then the feed's controls: a renderer announces a change
  // over lb:feed-params (feed-url.js) and the page writes it as its own
  // query (an empty value drops the key, back to the feed's default).
  var feed = document.body.getAttribute('data-active-feed') || '';
  function writeQuery(p) {
    var qs = p.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); } catch (e) {}
  }
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('cart') === '1') {
      window.__lbOpenCartOnMarket = true;
      q.delete('cart');
      writeQuery(q);
    }
  } catch (e) {}
  document.addEventListener('lb:feed-params', function (e) {
    var d = (e && e.detail) || {};
    if (!d.feed || d.feed !== feed) return;
    var p;
    try { p = new URLSearchParams(location.search); } catch (err) { return; }
    var params = d.params || {};
    Object.keys(params).forEach(function (k) { if (params[k]) p.set(k, params[k]); else p.delete(k); });
    // The pre-rails keys named the tab and sub-tab on the homepage; the page
    // is the tab now.
    p.delete('feed');
    p.delete('view');
    writeQuery(p);
  });
})();
