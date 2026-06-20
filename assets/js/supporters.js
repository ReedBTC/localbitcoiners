/* Supporters page — mempool.space-style grids of the people who power
 * Local Bitcoiners, in three groups:
 *
 *   1. Boosters & Streamers — everyone who sent sats, bucketed into
 *      lifetime tiers (100k+ / 69k+ / 21k+ / under 21k). Totals come
 *      from /data/sats.json (total_sats per sender_npub, boosts AND
 *      streams), the same ledger the Stats leaderboard uses. Hosts are
 *      excluded (we don't rank ourselves); truly anonymous payments
 *      (no npub and no name) are skipped.
 *   2. Coding Contributors — hardcoded; Reed maintains this by hand.
 *   3. Show Guests — npubs pulled live from /api/guests (the [guests:]
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

  var SATS_URL = '/data/sats.json';
  var GUESTS_URL = '/api/guests';

  // Hosts — shown in their own "Hosts" group (no follow pack), AND counted
  // in the Supporters tiers by what they've boosted (no longer excluded).
  var HOSTS = [
    { npub: 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s', label: 'Reed' },
    { npub: 'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z', label: 'Rev Hodl' },
  ];

  // Coding Contributors — maintained by hand. Reed will say when to add.
  var CODING_CONTRIBUTORS = [
    { npub: 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s', label: 'Reed' },
    { npub: 'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7', label: 'Chad Farrow' },
  ];

  // Tier buckets, top to bottom. `min` is the inclusive lifetime-sats
  // floor; a supporter lands in the first tier they clear.
  var TIERS = [
    { id: 't100', min: 100000, title: '100k+ Sovereigns',   pack: 'lb-supporters-100k', featured: true },
    { id: 't69',  min: 69000,  title: '69k+ Frontiersmen',  pack: 'lb-supporters-69k',  featured: true },
    { id: 't21',  min: 21000,  title: '21k+ Trailblazers',  pack: 'lb-supporters-21k',  featured: true },
    { id: 't0',   min: 1,      title: 'Pioneers',           pack: 'lb-supporters-other' },
  ];

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
  var CODERS_PACK = 'lb-supporters-coders';

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

    // Cards with an npub are copy-to-clipboard buttons; name-only
    // supporters (no npub) are static — there's nothing to copy.
    var card = document.createElement(npub ? 'button' : 'div');
    card.className = 'sup-card' + (npub ? ' is-copyable' : '');
    if (npub) {
      card.type = 'button';
      card.title = 'Click to copy npub';
      card.setAttribute('aria-label', 'Copy npub for ' + name);
      card.addEventListener('click', function () { copyNpub(npub); });
    }

    var avatar = document.createElement('span');
    avatar.className = 'sup-avatar' + (opts.ring ? ' ' + opts.ring : '');
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

    var nameEl = document.createElement('span');
    nameEl.className = 'sup-name';
    nameEl.textContent = name;

    card.appendChild(avatar);
    card.appendChild(nameEl);

    // Show Guests get the episode(s) they were on, linked to /ep###.
    if (opts.episodes && opts.episodes.length) {
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
      registerCard(npub, { avatar: avatar, nameEl: nameEl, hasName: !!opts.name });
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
      if (prof.name) { rec.nameEl.textContent = prof.name; rec.hasName = true; }
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
  // `count` may be null to omit the count badge (e.g. tier sub-headers).
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

  function buildGrid(cards, centered) {
    var grid = document.createElement('div');
    grid.className = 'sup-grid' + (centered ? ' sup-grid--centered' : '');
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

  // Top-level section (Show Guests, Coding Contributors, Hosts). Skipped if
  // empty. `centered` centers the pfp grid (for small/curated groups).
  function renderSection(container, title, sub, cards, packSlug, centered) {
    if (!cards.length) return;
    var section = document.createElement('section');
    section.className = 'sup-section';

    var head = document.createElement('div');
    head.className = 'sup-section-head';
    head.appendChild(makeHeadRow('h2', title, null, packSlug));
    if (sub) {
      var p = document.createElement('p');
      p.className = 'sup-section-sub';
      p.textContent = sub;
      head.appendChild(p);
    }
    section.appendChild(head);
    section.appendChild(buildGrid(cards, centered));
    container.appendChild(section);
  }

  // The Boosters & Streamers group: one section header + note, then a
  // lighter sub-header per tier. `tiers` is [{ title, cards }, …].
  function renderBoosterGroup(container, title, note, tiers) {
    var live = tiers.filter(function (t) { return t.cards.length; });
    if (!live.length) return;

    var section = document.createElement('section');
    section.className = 'sup-section';

    var head = document.createElement('div');
    head.className = 'sup-section-head';
    head.appendChild(makeHeadRow('h2', title, null, null));
    if (note) {
      var p = document.createElement('p');
      p.className = 'sup-section-sub';
      p.textContent = note;
      head.appendChild(p);
    }
    section.appendChild(head);

    live.forEach(function (t) {
      var tier = document.createElement('div');
      tier.className = 'sup-tier' + (t.featured ? ' sup-tier--featured' : '');
      var th = document.createElement('div');
      th.className = 'sup-tier-head';
      th.appendChild(makeHeadRow('h3', t.title, null, t.pack));
      tier.appendChild(th);
      tier.appendChild(buildGrid(t.cards));
      section.appendChild(tier);
    });

    container.appendChild(section);
  }

  // ── Aggregate supporters from the sats ledger ──────────────────────
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
        rec = byKey[key] = { npub: npub || null, name: r.sender_name || null, sats: 0 };
      }
      rec.sats += sats;
      if (!rec.name && r.sender_name) rec.name = r.sender_name;
    }
    var people = [];
    for (var k in byKey) people.push(byKey[k]);
    people.sort(function (a, b) { return b.sats - a.sats; });
    return people;
  }

  function tierOf(sats) {
    for (var i = 0; i < TIERS.length; i++) {
      if (sats >= TIERS[i].min) return TIERS[i].id;
    }
    return null;
  }

  // Gold/silver/bronze pfp rings for the top three tiers.
  var TIER_RINGS = { t100: 'tier-gold', t69: 'tier-silver', t21: 'tier-bronze' };

  function render(people, guestNpubs, cache, epMap) {
    var root = document.getElementById('supporters-root');
    var loading = document.getElementById('supporters-loading');
    if (loading) loading.style.display = 'none';
    epMap = epMap || Object.create(null);

    function profFor(npub) { return (npub && cache[npub]) || null; }

    function cardFor(npub, label, ring, episodes) {
      var prof = profFor(npub);
      return makeCard({ npub: npub, name: (prof && prof.name) || label || null, picture: prof && prof.picture, ring: ring, episodes: episodes });
    }

    // 1. Supporters — boost/stream tiers. One group header + note, then a tier each.
    var buckets = Object.create(null);
    TIERS.forEach(function (t) { buckets[t.id] = []; });
    people.forEach(function (p) {
      var tid = tierOf(p.sats);
      if (!tid) return;
      buckets[tid].push(cardFor(p.npub, p.name, TIER_RINGS[tid]));
    });
    renderBoosterGroup(
      root,
      'Supporters',
      'Lifetime sats sent via boosts + streams. Anonymous supporters aren’t shown.',
      TIERS.map(function (t) { return { title: t.title, cards: buckets[t.id], pack: t.pack, featured: t.featured }; })
    );

    // 2. Show Guests — below the supporters (with their episode link(s)).
    renderSection(root, 'Show Guests', 'Everyone who’s come on the podcast.',
      guestNpubs.map(function (n) { return cardFor(n, null, null, epMap[n]); }), GUESTS_PACK);

    // 3. Coding Contributors — small group, centered pfps.
    renderSection(root, 'Coding Contributors', 'Builders who’ve shipped code to the site and bots.',
      CODING_CONTRIBUTORS.map(function (c) { return cardFor(c.npub, c.label); }), CODERS_PACK, true);

    // 4. Hosts — no follow pack; small group, centered pfps.
    renderSection(root, 'Hosts', 'The folks behind the mic.',
      HOSTS.map(function (h) { return cardFor(h.npub, h.label); }), null, true);
  }

  function collectNpubs(people, guestNpubs) {
    var set = Object.create(null);
    people.forEach(function (p) { if (p.npub) set[p.npub] = true; });
    CODING_CONTRIBUTORS.forEach(function (c) { set[c.npub] = true; });
    HOSTS.forEach(function (h) { set[h.npub] = true; });
    guestNpubs.forEach(function (n) { set[n] = true; });
    return Object.keys(set);
  }

  function init() {
    var errEl = document.getElementById('supporters-error');

    var satsP = fetch(SATS_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('sats ' + r.status); return r.json(); })
      .then(function (d) { return Array.isArray(d.rows) ? d.rows : []; });

    // Guests are non-critical — fall back to an empty roster if the
    // feed endpoint is down so the booster tiers still render.
    var guestsP = fetch(GUESTS_URL)
      .then(function (r) { return r.ok ? r.json() : { guests: [] }; })
      .then(function (d) { return Array.isArray(d.guests) ? d.guests : []; })
      .catch(function () { return []; });

    // Guest → episode-number map from the RSS shownotes ([guests: …]).
    var epP = guestEpisodeMap();

    Promise.all([satsP, guestsP, epP]).then(function (res) {
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
      var loading = document.getElementById('supporters-loading');
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
