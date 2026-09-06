/* Supporters page — the people who power Local Bitcoiners, in two groups:
 *
 *   1. Supporters — everyone who sent sats, as one wall ordered by lifetime
 *      sats (the OnlyBoosts community wall, ported): a podium of the top
 *      PODIUM with larger brand-ringed avatars, then a ranked grid, with
 *      WALL_VISIBLE cards showing and the rest behind a "Show N more"
 *      button. Each card carries the person's sats under their name.
 *      Totals come from /data/sats.json (total_sats per sender_npub,
 *      boosts AND streams), the same ledger the Stats leaderboard uses.
 *      Truly anonymous payments (no npub and no name) are skipped. The
 *      old lifetime tiers (100k / 69k / 21k) are gone; one Follow Pack
 *      (lb-supporters-all) covers the whole wall.
 *   2. Show Guests — npubs pulled live from /api/guests (the [guests:]
 *      tags in each episode's RSS shownotes).
 *
 * Names + circular avatars resolve through the shared profile cache
 * exposed by episode-enhance.js (window.LBEpisodeEnhance). We paint
 * immediately from the localStorage cache, then upgrade in place once
 * the relay fetch resolves. Supporters with a name but no avatar get a
 * blank circle; supporters with neither npub nor name never appear.
 */
(function () {
  'use strict';

  var SATS_URL = '/api/sats';
  var GUESTS_URL = '/api/guests';

  // ── Two pages, one wall ──
  // This script also paints the homepage's Community section (feeds-homepage,
  // 2026-09-06): the same podium + ranked grid + "Show N more" wall, and
  // nothing else — no section heading (the page supplies its own "Community"
  // title), no Show Guests. Which page it is on is decided by which root the
  // markup carries: #supporters-root is the full page, #community-root the
  // homepage. The same PODIUM / WALL_VISIBLE shape both places, so the two
  // walls always agree on who is above the fold.
  var HOME = !document.getElementById('supporters-root') && !!document.getElementById('community-root');
  var IDS = HOME
    ? { root: 'community-root', loading: 'community-loading', error: 'community-error' }
    : { root: 'supporters-root', loading: 'supporters-loading', error: 'supporters-error' };

  // Co-hosts — Reed + Rev. Injected into the Show Guests section right before
  // the earliest-episode (EP002) guests and labelled "co-host" instead of an
  // episode (they aren't in the RSS [guests:] roster, so we add them by hand).
  // Also ranked on the Supporters wall by what they've boosted.
  var CO_HOSTS = [
    { npub: 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s', label: 'Reed' },
    { npub: 'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z', label: 'Rev Hodl' },
  ];
  var CO_HOST_SET = Object.create(null);
  CO_HOSTS.forEach(function (c) { CO_HOST_SET[c.npub] = true; });

  // The wall's shape, matching OnlyBoosts' community wall: the top PODIUM
  // people get larger cards on their own row; WALL_VISIBLE counts the
  // podium, so the grid under it shows WALL_VISIBLE - PODIUM before the
  // "Show N more" button. Nobody is dropped, only folded.
  var PODIUM = 5;
  var WALL_VISIBLE = 21;

  // Compact sat figures — 1435000 → "1.4M", 41200 → "41k" (OnlyBoosts' rule).
  function compact(n) {
    var v = Number(n || 0);
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1e4) return Math.round(v / 1e3) + 'k';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(v);
  }
  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function shortNpub(npub) {
    if (!npub || npub.length < 20) return npub || '';
    return npub.slice(0, 10) + '…' + npub.slice(-4);
  }

  // ── Follow packs (following.space, kind 39089) ─────────────────────
  // The show publishes one pack per category (bots/follow-packs); each
  // category's "Follow Pack" button links to it so people can one-click
  // follow everyone in that category. Owner = the show account.
  var SHOW_PUBKEY_HEX = 'c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592';
  var GUESTS_PACK = 'lb-supporters-guests';
  // Everyone on the wall — links off the "Supporters" heading.
  var ALL_PACK = 'lb-supporters-all';

  function followPackUrl(slug) {
    return 'https://following.space/d/' + slug + '?p=' + SHOW_PUBKEY_HEX;
  }

  // A small "Follow Pack ↗" link for a section header, or null if no slug.
  function makeFollowPackLink(slug) {
    if (!slug) return null;
    var a = document.createElement('a');
    a.className = 'sup-follow-pack';
    a.href = followPackUrl(slug);
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = 'Follow everyone in this category on Nostr (opens following.space)';
    a.appendChild(document.createTextNode('Follow Pack '));
    var arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    a.appendChild(arrow);
    return a;
  }

  // ── Copy-to-clipboard + toast ──────────────────────────────────────
  // execCommand fallback for when navigator.clipboard is unavailable or
  // rejected (e.g. Firefox on Android gates the async clipboard). The
  // textarea must be ON-SCREEN with real size — an opacity:0 / off-screen
  // field isn't reliably selectable on mobile — and we honour the actual
  // execCommand return value rather than assuming success.
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = '0';
    ta.style.fontSize = '16px';   // avoids iOS zoom; harmless elsewhere
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return !!ok;
  }

  function copyNpub(npub) {
    function finish(ok) {
      if (ok) { showToast('npub copied'); return; }
      // Last resort so it NEVER silently does nothing: prompt() shows the
      // npub for manual copy on every browser, including Firefox Android.
      try { window.prompt('Copy this npub:', npub); }
      catch (e) { showToast('Couldn’t copy npub'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(npub)
        .then(function () { finish(true); })
        .catch(function () { finish(fallbackCopy(npub)); });
    } else {
      finish(fallbackCopy(npub));
    }
  }

  var toastEl = null;
  var toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'sup-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // Force reflow so re-triggering restarts the transition.
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, 1600);
  }

  // Registry of rendered cards keyed by npub so a single profile resolve
  // updates every card for that person (a guest may also be a booster).
  var cardsByNpub = Object.create(null);

  function registerCard(npub, rec) {
    if (!cardsByNpub[npub]) cardsByNpub[npub] = [];
    cardsByNpub[npub].push(rec);
  }

  // Build one supporter card. `npub` may be null for name-only supporters.
  function makeCard(opts) {
    var npub = opts.npub || null;
    var name = opts.name || (npub ? shortNpub(npub) : 'Anonymous');
    var picture = opts.picture || null;

    // The avatar is built first because the OnlyBoosts wiring below needs it
    // to hang the booster dot on, and the card's element type depends on the
    // answer that wiring gives.
    var avatar = document.createElement('span');
    avatar.className = 'sup-avatar';
    var img = null;
    if (picture) {
      img = document.createElement('img');
      img.src = picture;
      img.alt = '';
      img.loading = 'lazy';
      avatar.appendChild(img);
    } else {
      avatar.classList.add('is-blank');
    }

    // Cards with an npub are interactive; name-only supporters (no npub) are
    // static — there's nothing to click. An interactive card is an <a> when the
    // person has an OnlyBoosts page and a copy-to-clipboard <button> when they
    // do not. .is-copyable drives the hover treatment for both.
    //
    // ⚠️ The <a>/<button> split is decided HERE and never revised, so init()
    // must have awaited obReady() before any card is built. See the note there.
    var ob = window.LBOnlyBoosts || null;
    var linked = !!(npub && ob && ob.hasBoosterPage(npub));
    var card = document.createElement(npub ? (linked ? 'a' : 'button') : 'div');
    card.className = 'sup-card' + (npub ? ' is-copyable' : '') + (opts.podium ? ' sup-card--podium' : '');
    if (npub) {
      if (!linked) {
        card.type = 'button';
        card.title = 'Click to copy npub';
        card.setAttribute('aria-label', 'Copy npub for ' + name);
      }
      if (ob) {
        ob.wireBoosterAction(card, {
          id: npub, name: name, avatar: avatar,
          onCopy: function () { copyNpub(npub); },
        });
      } else {
        card.addEventListener('click', function () { copyNpub(npub); });
      }
    }

    var nameEl = document.createElement('span');
    nameEl.className = 'sup-name';
    nameEl.textContent = name;

    card.appendChild(avatar);
    card.appendChild(nameEl);

    // Supporters carry their lifetime sats under the name, compact ("412k")
    // with the exact figure on hover. Tabular digits so a column lines up.
    if (typeof opts.sats === 'number') {
      var satsEl = document.createElement('span');
      satsEl.className = 'sup-sats';
      satsEl.textContent = compact(opts.sats) + ' sats';
      satsEl.title = fmtInt(opts.sats) + ' sats';
      card.appendChild(satsEl);
    }

    // Co-hosts get a plain "co-host" role chip in place of episode links.
    if (opts.roleLabel) {
      var roleWrap = document.createElement('span');
      roleWrap.className = 'sup-eps';
      var role = document.createElement('span');
      role.className = 'sup-role';
      role.textContent = opts.roleLabel;
      roleWrap.appendChild(role);
      card.appendChild(roleWrap);
    } else if (opts.episodes && opts.episodes.length) {
      // Show Guests get the episode(s) they were on, linked to /ep###.
      var eps = document.createElement('span');
      eps.className = 'sup-eps';
      opts.episodes.forEach(function (pad3) {
        var a = document.createElement('a');
        a.href = '/ep' + pad3;
        a.textContent = 'EP' + pad3;
        a.addEventListener('click', function (e) { e.stopPropagation(); });
        eps.appendChild(a);
      });
      card.appendChild(eps);
    }

    if (npub) {
      registerCard(npub, { card: card, avatar: avatar, nameEl: nameEl, hasName: !!opts.name });
    }
    return card;
  }

  // Fetch RSS once → guest npub → [padded episode numbers] from the
  // [guests: …] shownotes markers. Cached feed used when present.
  function guestEpisodeMap() {
    function parse(xml) {
      var map = Object.create(null);
      if (!xml) return map;
      var doc;
      try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return map; }
      var items = doc.querySelectorAll('item');
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var numEl = item.querySelector('episode');
        var num = numEl ? numEl.textContent.trim() : '';
        if (!num) {
          var t = item.querySelector('title');
          var tm = (t ? t.textContent : '').match(/Ep\.?\s*(\d+)/i);
          if (tm) num = tm[1];
        }
        if (!num) continue;
        var pad3 = String(num).replace(/[^\d]/g, '').padStart(3, '0');
        var descEl = item.querySelector('summary') || item.querySelector('description');
        var gm = (descEl ? descEl.textContent : '').match(/\[guests:\s*([^\]]*)\]/i);
        if (!gm) continue;
        gm[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (np) {
          var arr = map[np] || (map[np] = []);
          if (arr.indexOf(pad3) === -1) arr.push(pad3);
        });
      }
      Object.keys(map).forEach(function (k) { map[k].sort(); });
      return map;
    }
    try {
      var c = localStorage.getItem('lb_rss_xml_v1');
      if (c && c.indexOf('<item>') >= 0) return Promise.resolve(parse(c));
    } catch (e) {}
    return fetch('/api/rss').then(function (r) { return r.ok ? r.text() : ''; }).then(parse).catch(function () { return Object.create(null); });
  }

  // Apply a resolved profile to every card for that npub.
  function applyProfile(npub, prof) {
    var recs = cardsByNpub[npub];
    if (!recs || !prof) return;
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (prof.name) {
        rec.nameEl.textContent = prof.name;
        rec.hasName = true;
        // Cards are built before profiles resolve, so a booster's link was
        // labelled with their truncated npub. Name it now that we know it.
        if (rec.card && rec.card.tagName === 'A') {
          rec.card.title = 'View ' + prof.name + ' on OnlyBoosts';
          rec.card.setAttribute('aria-label', 'View ' + prof.name + ' on OnlyBoosts');
        } else if (rec.card) {
          rec.card.setAttribute('aria-label', 'Copy npub for ' + prof.name);
        }
      }
      if (prof.picture && rec.avatar.classList.contains('is-blank')) {
        rec.avatar.classList.remove('is-blank');
        var img = document.createElement('img');
        img.src = prof.picture;
        img.alt = '';
        img.loading = 'lazy';
        rec.avatar.appendChild(img);
      }
    }
  }

  // Title + count badge as a heading element (h2 or h3).
  // `count` may be null to omit the count badge.
  function makeHeading(tag, title, count) {
    var h = document.createElement(tag);
    h.textContent = title;
    if (count != null) {
      var badge = document.createElement('span');
      badge.className = 'sup-count';
      badge.textContent = String(count);
      h.appendChild(badge);
    }
    return h;
  }

  function buildGrid(cards) {
    var grid = document.createElement('div');
    grid.className = 'sup-grid';
    for (var i = 0; i < cards.length; i++) grid.appendChild(cards[i]);
    return grid;
  }

  // Title row = heading (+count) on the left, optional Follow Pack link right.
  function makeHeadRow(tag, title, count, packSlug) {
    var row = document.createElement('div');
    row.className = 'sup-head-row';
    row.appendChild(makeHeading(tag, title, count));
    var link = makeFollowPackLink(packSlug);
    if (link) row.appendChild(link);
    return row;
  }

  function makeSection(title, sub, count, packSlug) {
    var section = document.createElement('section');
    section.className = 'sup-section';
    // The homepage wall has no heading of its own: the page's "Community"
    // title is directly above it.
    if (title == null) return section;
    var head = document.createElement('div');
    head.className = 'sup-section-head';
    head.appendChild(makeHeadRow('h2', title, count, packSlug));
    if (sub) {
      var p = document.createElement('p');
      p.className = 'sup-section-sub';
      p.textContent = sub;
      head.appendChild(p);
    }
    section.appendChild(head);
    return section;
  }

  // Top-level section (Show Guests). Skipped if empty.
  function renderSection(container, title, sub, cards, packSlug) {
    if (!cards.length) return;
    var section = makeSection(title, sub, null, packSlug);
    section.appendChild(buildGrid(cards));
    container.appendChild(section);
  }

  // The Supporters wall: podium row, ranked grid, "Show N more". `cards`
  // arrive in rank order (largest sats first); the first PODIUM are built
  // with opts.podium so they carry the larger avatar.
  function renderWall(container, title, sub, cards, packSlug) {
    if (!cards.length) return;
    var section = makeSection(title, sub, cards.length, packSlug);

    var podium = document.createElement('div');
    podium.className = 'sup-podium';
    cards.slice(0, PODIUM).forEach(function (c) { podium.appendChild(c); });
    section.appendChild(podium);

    var rest = cards.slice(PODIUM);
    var shown = Math.max(0, WALL_VISIBLE - PODIUM);
    if (rest.length) {
      var grid = buildGrid(rest);
      rest.forEach(function (c, i) { if (i >= shown) c.hidden = true; });
      section.appendChild(grid);
    }

    // One button that toggles: "Show N more" opens the fold, then reads
    // "Show fewer" and closes it again (restoring exactly the top
    // WALL_VISIBLE), scrolling the heading back into view so the reader
    // isn't left partway down the guests section after the collapse.
    var hidden = Math.max(0, rest.length - shown);
    if (hidden > 0) {
      var folded = rest.slice(shown);
      var open = false;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sup-show-more';
      btn.setAttribute('aria-expanded', 'false');
      function label() {
        btn.textContent = open
          ? 'Show fewer supporters'
          : 'Show ' + fmtInt(hidden) + ' more supporter' + (hidden === 1 ? '' : 's');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      label();
      btn.addEventListener('click', function () {
        open = !open;
        for (var i = 0; i < folded.length; i++) folded[i].hidden = !open;
        label();
        if (!open) {
          try { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch (e) { section.scrollIntoView(); }
        }
      });
      section.appendChild(btn);
    }
    container.appendChild(section);
  }

  // ── Aggregate supporters from the sats ledger ──────────────────────
  // Zap-sourced sats are held aside per supporter and only count once they
  // aggregate to ZAP_MIN_SATS — a tiny one-off zap shouldn't put a random
  // npub on the wall. Boosts and streams always count. Mirrors
  // bots/follow-packs so the page and the kind-39089 pack (the "Follow
  // Pack" button) agree.
  var ZAP_MIN_SATS = 100;

  function aggregate(rows) {
    var byKey = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sats = typeof r.total_sats === 'number' ? r.total_sats : 0;
      if (sats <= 0) continue;
      var npub = r.sender_npub || '';
      var key = npub || (r.sender_name ? 'name:' + r.sender_name : '');
      if (!key) continue;                                 // truly anonymous → skip
      var rec = byKey[key];
      if (!rec) {
        rec = byKey[key] = { npub: npub || null, name: r.sender_name || null, sats: 0, zapSats: 0 };
      }
      if (r.source === 'zap') rec.zapSats += sats;
      else rec.sats += sats;
      if (!rec.name && r.sender_name) rec.name = r.sender_name;
    }
    var people = [];
    for (var k in byKey) {
      var p = byKey[k];
      if (p.zapSats >= ZAP_MIN_SATS) p.sats += p.zapSats;  // fold qualifying zaps in
      if (p.sats > 0) people.push(p);                      // sub-floor zap dust drops off
    }
    people.sort(function (a, b) { return b.sats - a.sats; });
    return people;
  }

  function render(people, guestNpubs, cache, epMap) {
    var root = document.getElementById(IDS.root);
    var loading = document.getElementById(IDS.loading);
    if (loading) loading.style.display = 'none';
    epMap = epMap || Object.create(null);

    function profFor(npub) { return (npub && cache[npub]) || null; }

    function cardFor(npub, label, extra) {
      var prof = profFor(npub);
      var opts = { npub: npub, name: (prof && prof.name) || label || null, picture: prof && prof.picture };
      if (extra) for (var k in extra) opts[k] = extra[k];
      return makeCard(opts);
    }

    // 1. Supporters — one wall, ranked by lifetime sats (people arrive sorted).
    var wallCards = people.map(function (p, i) {
      return cardFor(p.npub, p.name, { sats: p.sats, podium: i < PODIUM });
    });
    if (HOME) {
      // The homepage: the wall alone, under the page's own title.
      renderWall(root, null, null, wallCards, null);
      return;
    }
    renderWall(root, 'Supporters',
      'Lifetime sats sent via boosts + streams, most first. Anonymous supporters aren’t shown.',
      wallCards, ALL_PACK);

    // 2. Show Guests — below the supporters (with their episode link(s)). The
    //    guest list runs newest-episode-first, so its oldest-aired end is the
    //    bottom. The co-hosts (Reed + Rev) predate the show's first guests, so
    //    they sit just AFTER the earliest (EP002) guests — the "before EP002 in
    //    airing order" side — labelled "co-host" rather than an episode.
    var guestCards = [];
    var lastEp002 = -1;
    guestNpubs.forEach(function (n) {
      if (CO_HOST_SET[n]) return;   // never double-list a co-host from the RSS roster
      var eps = epMap[n];
      guestCards.push(cardFor(n, null, { episodes: eps }));
      if (eps && eps.indexOf('002') !== -1) lastEp002 = guestCards.length - 1;
    });
    var coHostCards = CO_HOSTS.map(function (c) { return cardFor(c.npub, c.label, { roleLabel: 'co-host' }); });
    // After the last EP002 guest; if none resolved (e.g. epMap unavailable),
    // fall back to the very end (still the oldest-aired side of the list).
    var insertAt = lastEp002 >= 0 ? lastEp002 + 1 : guestCards.length;
    guestCards.splice.apply(guestCards, [insertAt, 0].concat(coHostCards));
    renderSection(root, 'Show Guests', 'Everyone who’s come on the podcast.', guestCards, GUESTS_PACK);
  }

  function collectNpubs(people, guestNpubs) {
    var set = Object.create(null);
    people.forEach(function (p) { if (p.npub) set[p.npub] = true; });
    CO_HOSTS.forEach(function (c) { set[c.npub] = true; });
    guestNpubs.forEach(function (n) { set[n] = true; });
    return Object.keys(set);
  }

  // Wait for the OnlyBoosts booster index before painting cards, so makeCard()
  // knows up front whether each person links out or copies.
  //
  // ⚠️ This file is a classic deferred script and cannot import the module, so
  // it reads it off window. The <script type="module"> for it sits earlier in
  // supporters.html and deferred scripts run in document order, which means the
  // global is normally there already; the poll is insurance against a future
  // edit reordering those tags, not an expected path. Either way this resolves
  // rather than rejects — a missing index just means every card copies, which
  // is what the page did before.
  function obReady() {
    var ob = window.LBOnlyBoosts;
    if (ob && ob.ready) return ob.ready();
    return new Promise(function (res) {
      var tries = 0;
      (function poll() {
        var o = window.LBOnlyBoosts;
        if (o && o.ready) { o.ready().then(res, res); return; }
        if (++tries > 20) { res(); return; }  // ~1s, then paint without it
        setTimeout(poll, 50);
      })();
    });
  }

  function init() {
    if (!document.getElementById(IDS.root)) return;
    var errEl = document.getElementById(IDS.error);

    var satsP = fetch(SATS_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('sats ' + r.status); return r.json(); })
      .then(function (d) { return Array.isArray(d.rows) ? d.rows : []; });

    // Guests are non-critical — fall back to an empty roster if the
    // feed endpoint is down so the supporters wall still renders. The
    // homepage wall has no guests section, so it never asks.
    var guestsP = HOME ? Promise.resolve([]) : fetch(GUESTS_URL)
      .then(function (r) { return r.ok ? r.json() : { guests: [] }; })
      .then(function (d) { return Array.isArray(d.guests) ? d.guests : []; })
      .catch(function () { return []; });

    // Guest → episode-number map from the RSS shownotes ([guests: …]).
    var epP = HOME ? Promise.resolve(Object.create(null)) : guestEpisodeMap();

    Promise.all([satsP, guestsP, epP, obReady()]).then(function (res) {
      var people = aggregate(res[0]);
      var guestNpubs = res[1];
      var epMap = res[2] || Object.create(null);
      var npubs = collectNpubs(people, guestNpubs);

      var enhance = window.LBEpisodeEnhance || {};
      var cache = (enhance.getCachedProfilesByNpub && enhance.getCachedProfilesByNpub(npubs)) || Object.create(null);

      render(people, guestNpubs, cache, epMap);

      // Upgrade in place once relays answer.
      if (enhance.fetchProfilesByNpub) {
        enhance.fetchProfilesByNpub(npubs).then(function (profiles) {
          if (!profiles) return;
          Object.keys(profiles).forEach(function (npub) {
            applyProfile(npub, profiles[npub]);
          });
        }).catch(function () {});
      }
    }).catch(function (e) {
      console.error('[supporters] load failed', e);
      var loading = document.getElementById(IDS.loading);
      if (loading) loading.style.display = 'none';
      if (errEl) errEl.style.display = 'block';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
