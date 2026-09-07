/* Supporters page — the people who power Local Bitcoiners, in two groups:
 *
 *   1. Supporters — everyone who sent sats, as one wall (the OnlyBoosts
 *      community wall, ported, with its members-wall controls since
 *      2026-09-06): a 1W / 1M / All range over when the sats were sent and a
 *      Rank pill (Chart rank, the default, or most sats / boosts / episodes),
 *      then a podium of the top PODIUM with larger brand-ringed avatars and
 *      a ranked grid, WALL_VISIBLE cards showing and the rest behind a
 *      "Show N more" button. Each card carries the ranked figure under the
 *      name, all three on hover. Rows come from /api/sats, the same ledger
 *      the Stats leaderboard uses; see aggregate() for what counts as a
 *      sat, a boost and an episode. Truly anonymous payments (no npub and
 *      no name) are skipped. The old lifetime tiers (100k / 69k / 21k) are
 *      gone; one Follow Pack (lb-supporters-all) covers the whole wall.
 *   2. Show Guests — npubs pulled live from /api/guests (the [guests:]
 *      tags in each episode's RSS shownotes).
 *
 * Names + circular avatars resolve through the shared profile cache
 * exposed by episode-enhance.js (window.LBEpisodeEnhance). We paint
 * immediately from the localStorage cache, then upgrade in place once
 * the relay fetch resolves. Supporters with a name but no avatar get a
 * blank circle; supporters with neither npub nor name never appear.
 */
// ⚠️ A MODULE SINCE 2026-09-06 (it was a classic deferred script), so the
// wall can use the site's one pair of range/sort widgets rather than a third
// copy. Both pages load it with type="module"; module scripts are deferred and
// run in document order, and the two globals this reads (LBOnlyBoosts,
// LBEpisodeEnhance) are polled for regardless.
import { rangeControl, sortControl, rangeStartMs, rangeWindow } from '/assets/js/head-controls.js'

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

    // Supporters carry a figure under the name — whichever metric the wall is
    // ordered by (figureFor), compact ("412k"), with all three figures on
    // hover. Tabular digits so a column lines up.
    if (opts.figure) {
      var satsEl = document.createElement('span');
      satsEl.className = 'sup-sats';
      satsEl.textContent = opts.figure.text;
      satsEl.title = opts.figure.title;
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

  // ── The wall's controls ─────────────────────────────────────────────
  // OnlyBoosts' members wall, carried over (Reed, 2026-09-06): a 1W / 1M /
  // All range over WHEN the sats were sent, and a Rank pill. The four views
  // are the three single axes plus the chart rank that combines them, and
  // the chart rank is the default: a single large boost no longer buys a
  // podium place on its own, and the people who show up across many
  // episodes rise. "Most episodes" is the breadth axis — OnlyBoosts ranks
  // shows boosted across a network; this is one show, so the equivalent is
  // how many of its episodes a person has boosted or streamed.
  var WALL_VIEWS = [
    ['chart', 'Chart rank'],
    ['sats', 'Most sats'],
    ['boosts', 'Most boosts'],
    ['episodes', 'Most episodes'],
  ];
  var DEFAULT_VIEW = 'chart';
  var DEFAULT_RANGE = 'all';

  // Competition rank of every value in `vals`: 1 + the count strictly ahead,
  // so equal values share a place (1, 2, 2, 4). OnlyBoosts' rank.js.
  function compRanks(vals) {
    return vals.map(function (v) {
      var ahead = 0;
      for (var i = 0; i < vals.length; i++) if (vals[i] > v) ahead++;
      return 1 + ahead;
    });
  }

  // Order the wall. `chart` is OnlyBoosts' chart rank (rank.js#chartRanks,
  // ported verbatim in rule): each person's competition rank in sats, in
  // boosts and in episodes, summed, lowest total first; ties break episodes →
  // sats → boosts, then the incoming order, so a full tie is stable. The
  // single axes break ties on sats, then boosts. O(n²) in the ranking, which
  // is nothing at this wall's size (a few hundred people at most).
  function orderPeople(people, view) {
    var list = people.slice();
    if (view === 'chart') {
      var rS = compRanks(list.map(function (p) { return p.sats; }));
      var rB = compRanks(list.map(function (p) { return p.boosts; }));
      var rK = compRanks(list.map(function (p) { return p.episodes; }));
      list.forEach(function (p, i) { p.score = rS[i] + rB[i] + rK[i]; p.i = i; });
      list.sort(function (a, b) {
        return a.score - b.score || b.episodes - a.episodes || b.sats - a.sats || b.boosts - a.boosts || a.i - b.i;
      });
      return list;
    }
    var key = view === 'boosts' ? 'boosts' : view === 'episodes' ? 'episodes' : 'sats';
    list.sort(function (a, b) { return b[key] - a[key] || b.sats - a.sats || b.boosts - a.boosts; });
    return list;
  }

  // The figure under a face: the metric the wall is ordered by (sats for the
  // chart rank, the headline figure), with all three on hover.
  function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : many); }
  function figureFor(p, view) {
    var title = fmtInt(p.sats) + ' sats · ' + plural(p.boosts, 'boost', 'boosts') + ' · ' + plural(p.episodes, 'episode', 'episodes');
    if (view === 'boosts') return { text: compact(p.boosts) + (p.boosts === 1 ? ' boost' : ' boosts'), title: title };
    if (view === 'episodes') return { text: compact(p.episodes) + (p.episodes === 1 ? ' episode' : ' episodes'), title: title };
    return { text: compact(p.sats) + ' sats', title: title };
  }

  // The Supporters wall: the controls, then a podium row, a ranked grid and
  // "Show N more", repainted from the ledger rows whenever a control changes.
  // The first PODIUM cards carry opts.podium for the larger avatar.
  function renderWall(container, title, sub, packSlug, ctx) {
    var section = makeSection(title, sub, null, packSlug);
    var range = DEFAULT_RANGE;
    var view = DEFAULT_VIEW;

    var controls = document.createElement('div');
    controls.className = 'sup-controls';
    var group = document.createElement('div');
    group.className = 'pcast-controls';
    group.appendChild(rangeControl(range, function (key) { range = key; paint(); }, {
      label: 'Filter supporters by when they sent sats',
    }));
    group.appendChild(sortControl(WALL_VIEWS, view, function (key) { view = key; paint(); }, {
      tag: 'Rank: ', title: 'Rank supporters by',
    }));
    controls.appendChild(group);
    section.appendChild(controls);

    var body = document.createElement('div');
    body.className = 'sup-wall-body';
    section.appendChild(body);

    function paint() {
      body.innerHTML = '';
      var people = orderPeople(aggregate(ctx.rows, rangeStartMs(range)), view);
      if (!people.length) {
        var empty = document.createElement('p');
        empty.className = 'sup-empty';
        empty.textContent = 'No sats sent in the ' + rangeWindow(range) + '.';
        body.appendChild(empty);
        return;
      }
      var cards = people.map(function (p, i) {
        return ctx.cardFor(p.npub, p.name, { figure: figureFor(p, view), podium: i < PODIUM });
      });

      var podium = document.createElement('div');
      podium.className = 'sup-podium';
      cards.slice(0, PODIUM).forEach(function (c) { podium.appendChild(c); });
      body.appendChild(podium);

      var rest = cards.slice(PODIUM);
      var shown = Math.max(0, WALL_VISIBLE - PODIUM);
      if (rest.length) {
        var grid = buildGrid(rest);
        rest.forEach(function (c, i) { if (i >= shown) c.hidden = true; });
        body.appendChild(grid);
      }

      // One button that toggles: "Show N more" opens the fold, then reads
      // "Show fewer" and closes it again (restoring exactly the top
      // WALL_VISIBLE), scrolling the section back into view so the reader
      // isn't left partway down the page after the collapse.
      var hidden = Math.max(0, rest.length - shown);
      if (hidden > 0) {
        var folded = rest.slice(shown);
        var open = false;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sup-show-more';
        btn.setAttribute('aria-expanded', 'false');
        var label = function () {
          btn.textContent = open
            ? 'Show fewer supporters'
            : 'Show ' + fmtInt(hidden) + ' more supporter' + (hidden === 1 ? '' : 's');
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
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
        body.appendChild(btn);
      }
    }

    paint();
    container.appendChild(section);
  }

  // ── Aggregate supporters from the sats ledger ──────────────────────
  // One record per person over the rows inside `sinceMs` (the wall's range;
  // -Infinity for All), with the three figures the wall ranks on. The rules
  // (Reed's calls, 2026-09-06):
  //   • sats — everything: boosts, streams, and zaps once a person's zaps reach
  //     ZAP_MIN_SATS (a tiny one-off zap shouldn't put a random npub on the
  //     wall; mirrors bots/follow-packs so the page and the kind-39089 pack
  //     agree on who is on it).
  //   • boosts — every non-zap row. A boost row is one payment; a stream row is
  //     a per-(episode, supporter) aggregate stamped with last activity, so a
  //     streamer counts once per episode streamed, and a 1W wall means "who
  //     boosted or streamed in it" (the stats page's own caveat).
  //   • episodes — distinct episodes across those same non-zap rows.
  //   Zaps are sats but not boosts: no boost credit, no episode credit.
  var ZAP_MIN_SATS = 100;

  function aggregate(rows, sinceMs) {
    var byKey = Object.create(null);
    var windowed = sinceMs > -Infinity;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sats = typeof r.total_sats === 'number' ? r.total_sats : 0;
      if (sats <= 0) continue;
      if (windowed) {
        var t = Date.parse(r.settled_at || '');
        if (!(t >= sinceMs)) continue;
      }
      var npub = r.sender_npub || '';
      var key = npub || (r.sender_name ? 'name:' + r.sender_name : '');
      if (!key) continue;                                 // truly anonymous → skip
      var rec = byKey[key];
      if (!rec) {
        rec = byKey[key] = { npub: npub || null, name: r.sender_name || null, sats: 0, zapSats: 0, boosts: 0, eps: Object.create(null), episodes: 0 };
      }
      if (r.source === 'zap') {
        rec.zapSats += sats;
      } else {
        rec.sats += sats;
        rec.boosts += 1;
        if (r.episode_id) rec.eps[r.episode_id] = true;
      }
      if (!rec.name && r.sender_name) rec.name = r.sender_name;
    }
    var people = [];
    for (var k in byKey) {
      var p = byKey[k];
      if (p.zapSats >= ZAP_MIN_SATS) p.sats += p.zapSats;  // fold qualifying zaps in
      p.episodes = Object.keys(p.eps).length;
      if (p.sats > 0) people.push(p);                      // sub-floor zap dust drops off
    }
    return people;
  }

  // Profiles by npub: the localStorage cache at first paint, upgraded in
  // place as relays answer. Module-level so a repaint (range or rank change)
  // builds its cards from the best-known profiles rather than the cache alone.
  var profiles = Object.create(null);

  function render(rows, guestNpubs, epMap) {
    var root = document.getElementById(IDS.root);
    var loading = document.getElementById(IDS.loading);
    if (loading) loading.style.display = 'none';
    epMap = epMap || Object.create(null);

    function cardFor(npub, label, extra) {
      var prof = (npub && profiles[npub]) || null;
      var opts = { npub: npub, name: (prof && prof.name) || label || null, picture: prof && prof.picture };
      if (extra) for (var k in extra) opts[k] = extra[k];
      return makeCard(opts);
    }

    // 1. Supporters — one wall over the ledger, with its own range and rank
    //    controls (renderWall). The homepage gets the wall alone, under the
    //    page's own "Community" title.
    if (HOME) {
      renderWall(root, null, null, null, { rows: rows, cardFor: cardFor });
      return;
    }
    renderWall(root, 'Supporters',
      'Sats sent via boosts, streams and zaps; boosts and episodes count boosts and streams only. Anonymous supporters aren’t shown.',
      ALL_PACK, { rows: rows, cardFor: cardFor });

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
      var rows = res[0];
      var people = aggregate(rows, -Infinity);   // everyone, for the profile fetch
      var guestNpubs = res[1];
      var epMap = res[2] || Object.create(null);
      var npubs = collectNpubs(people, guestNpubs);

      var enhance = window.LBEpisodeEnhance || {};
      profiles = (enhance.getCachedProfilesByNpub && enhance.getCachedProfilesByNpub(npubs)) || Object.create(null);

      render(rows, guestNpubs, epMap);

      // Upgrade in place once relays answer, and remember them so a repaint
      // (range or rank change) builds its cards from the resolved profiles.
      if (enhance.fetchProfilesByNpub) {
        enhance.fetchProfilesByNpub(npubs).then(function (resolved) {
          if (!resolved) return;
          Object.keys(resolved).forEach(function (npub) {
            profiles[npub] = Object.assign({}, profiles[npub] || null, resolved[npub]);
            applyProfile(npub, resolved[npub]);
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
