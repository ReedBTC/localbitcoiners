/* Homepage hub hydration.
 *
 * Lightweight, static-JSON-driven — no Nostr, no relays, no widget
 * bundle. Reads the same daily ledger snapshots the Stats/Supporters
 * pages use (/data/sats.json, /data/zaps.json, /data/meetups.json) to:
 *
 *   1. Fill the "By the Numbers" strip (sats raised, supporters, meetups;
 *      episode count is set by the inline RSS script).
 *   2. Render a "Recent Boosts" ticker from the latest ledger messages.
 *   3. Update the Explore teaser counts.
 *   4. Reveal modules on scroll.
 *
 * Everything degrades quietly: a failed fetch just leaves the dashes /
 * placeholder copy in place rather than throwing.
 */
(function () {
  'use strict';

  var SATS_URL = '/api/sats';
  var ZAPS_URL = '/api/zaps';
  var MEETUPS_URL = '/api/meetups';

  // ── helpers ──────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function rows(data) {
    return data && Array.isArray(data.rows) ? data.rows : [];
  }

  function fmtInt(n) {
    return (n || 0).toLocaleString('en-US');
  }

  // ── Explore teaser counts ─────────────────────────────────────────
  // (The "By the Numbers" strip was replaced by the live leaderboards in
  // home-leaderboards.js; home.js now only fills the Explore card counts
  // and drives reveal-on-scroll.)
  Promise.all([
    getJSON(SATS_URL).catch(function () { return null; }),
    getJSON(ZAPS_URL).catch(function () { return null; }),
    getJSON(MEETUPS_URL).catch(function () { return null; }),
  ]).then(function (res) {
    var satRows = rows(res[0]), zapRows = rows(res[1]), meetups = res[2];

    // Supporters — distinct npubs across boosts, streams, and zaps.
    var npubs = {};
    function addNpub(r) { if (r && r.sender_npub) npubs[r.sender_npub] = 1; }
    satRows.forEach(addNpub);
    zapRows.forEach(addNpub);
    var supporterCount = Object.keys(npubs).length;

    var meetupCount = (meetups && typeof meetups.row_count === 'number')
      ? meetups.row_count : rows(meetups).length;

    var sc = $('explore-supporters-count');
    if (sc && supporterCount) sc.textContent = fmtInt(supporterCount) + ' people';
    var mc = $('explore-meetups-count');
    if (mc && meetupCount) mc.textContent = fmtInt(meetupCount) + ' listener-boosted';
  });

  // ── reveal-on-scroll ─────────────────────────────────────────────
  function initReveal() {
    var els = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    els.forEach(function (el) { io.observe(el); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveal);
  } else {
    initReveal();
  }
})();
