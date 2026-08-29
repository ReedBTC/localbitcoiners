/* Stats page — podcast-wide charts, all fed by /data/sats.json (plus
 * the episode feed /api/rss for publish dates).
 *
 * 1. Sats over time — line chart, cumulative / daily toggle, with
 *    episode-release markers.
 * 2. Episode leaderboard — top 10 episodes by total sats or by unique
 *    supporters.
 * 3. Supporter leaderboard — top 10 identities by total sats or by
 *    episodes supported, plus an always-on bucket aggregating every
 *    anonymous payment.
 *
 * Everything counts total_sats (what listeners sent, not the show's
 * split) across every row — episode boosts, show-level boosts,
 * lb_donations, streams. npubs in the supporter leaderboard resolve to
 * display names via episode-enhance.js's shared relay helper. Zero
 * dependencies; fails silently to an error message on load failure.
 */
(function () {
  'use strict';

  var SATS_URL = '/api/sats';
  var RSS_URL = '/api/rss';
  var DAY_MS = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Podcast hosts — excluded from the supporter leaderboard (we don't
  // rank ourselves). They appear in the ledger only under these npubs.
  var HOST_NPUBS = {
    'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s': true, // Reed
    'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z': true, // Rev Hodl
  };

  // Boosts settled before the boost bot's first kind-1 note were never
  // published to Nostr — they surface in the pre-Nostr feed instead.
  var PRE_NOSTR_CUTOFF_MS = Date.parse('2026-03-24T02:23:29Z');
  var BIG_BOOST_MIN = 10000;

  // The bot backfilled a few pre-cutoff boosts with real Nostr notes
  // after the fact, so the cutoff alone would wrongly list them as
  // pre-Nostr. Hardcoded exclusions by payment_hash — these show in the
  // Nostr "Biggest Boosts" feed instead. Not worth a general fix: the
  // bot is reliable now, so this list shouldn't grow.
  var PRE_NOSTR_EXCLUDE = {
    // npub1vpx9596… 10,420 sats, Ep 1 — settled 2026-02-09, note
    // published 2026-04-22 (nevent1qqsrg23qx…). A top-5 all-time boost.
    '9afc2918883d0b147906abff80d0d58b0e0ae6ba6a5f21907342f4772432e3ad': true,
  };

  // Operating costs — billed monthly, dollar-denominated, converted to
  // sats at the time of the bill. Split 50/50 between Reed and Rev:
  // each host's bucket eats their half before any "profit" appears.
  // Add a new entry each month after the bill clears.
  var COSTS = [
    { ms: Date.parse('2026-02-02T00:00:00Z'), dollars: 25, sats: 32000 }, // Fountain only (Riverside started Mar)
    { ms: Date.parse('2026-03-02T00:00:00Z'), dollars: 49, sats: 73359 }, // Fountain 37428 + Riverside 35931
    { ms: Date.parse('2026-04-02T00:00:00Z'), dollars: 49, sats: 73359 }, // Fountain 37428 + Riverside 35931
    { ms: Date.parse('2026-05-02T00:00:00Z'), dollars: 49, sats: 62500 }, // Fountain 31888 + Riverside 30612
    { ms: Date.parse('2026-06-01T00:00:00Z'), dollars: 49, sats: 62500 }, // Fountain 31888 + Riverside 30612
    { ms: Date.parse('2026-07-01T00:00:00Z'), dollars: 49, sats: 74700 }, // Fountain 38112 + Riverside 36588
    { ms: Date.parse('2026-08-01T00:00:00Z'), dollars: 49, sats: 74700 }, // same as July (Reed, 2026-08-29)
    { ms: Date.parse('2026-09-01T00:00:00Z'), dollars: 49, sats: 74700 }, // same as July (Reed, 2026-08-29)
  ];

  // Ep 015 was donated in full to the Samourai Wallet devs: the guest set his
  // value split to billandkeonne@getalby.com, and Reed + Rev committed their
  // host shares (plus the V4V-budget/aquafox leg, with Reed covering the
  // Fountain leg manually) to the same cause. So 100% of Ep 015's sats route to
  // a dedicated "Samourai Devs" split bucket rather than the usual recipients.
  var SAMOURAI_EP = 15;

  var canvas = document.querySelector('[data-stats-dist]');
  var subEl = document.querySelector('[data-stats-sub]');
  var distControlsEl = document.querySelector('[data-stats-dist-controls]');
  var boardCanvas = document.querySelector('[data-stats-leaderboard]');
  var boardSubEl = document.querySelector('[data-board-sub]');
  var peopleCanvas = document.querySelector('[data-stats-people]');
  var peopleSubEl = document.querySelector('[data-people-sub]');
  var preNostrCanvas = document.querySelector('[data-stats-prenostr]');
  var streamersCanvas = document.querySelector('[data-stats-streamers]');
  var zappersCanvas = document.querySelector('[data-stats-zappers]');
  var appmixCanvas = document.querySelector('[data-stats-appmix]');
  var appmixLegendEl = document.querySelector('[data-appmix-legend]');
  var epgridCanvas = document.querySelector('[data-stats-epgrid]');
  var epgridSubEl = document.querySelector('[data-epgrid-sub]');
  if (!canvas && !boardCanvas && !peopleCanvas && !preNostrCanvas &&
      !streamersCanvas && !zappersCanvas && !appmixCanvas && !epgridCanvas) return;

  Promise.all([
    fetch(SATS_URL).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch(RSS_URL).then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; }),
  ]).then(function (results) {
    var doc = results[0];
    var rssXml = results[1];
    if (!doc || !Array.isArray(doc.rows)) { showError(); return; }
    var rows = doc.rows.filter(function (row) {
      return typeof row.total_sats === 'number' && row.total_sats > 0 &&
        isFinite(Date.parse(row.settled_at));
    });
    if (!rows.length) { showError(); return; }
    var episodes = rssXml ? parseEpisodes(rssXml) : [];
    renderDistribution(rows);
    renderAppMix(rows);
    renderLeaderboard(rows);
    renderEpisodeGrid(rows, episodes);
    renderBigPreNostr(rows);
    // The surfaces that render a person wait for the OnlyBoosts booster
    // index so each name is wired up front as a link or a copy button
    // (see the note on obReady). Resolves either way, so a dead index
    // just means every name copies.
    obReady().then(function () {
      renderIdentityBoard(rows);
      renderStreamerShoutout(rows);
      renderTopZappers(rows);
    });
  });

  // Wait for the OnlyBoosts booster index. This file is a classic deferred
  // script and cannot import the module, so it reads it off window; the
  // <script type="module"> for it sits before this one in stats.html, so
  // the global is normally there already and the poll is insurance.
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

  function showError() {
    var msg = '<p class="stats-error">Couldn\'t load sats data right now — try again later.</p>';
    if (canvas) canvas.innerHTML = msg;
    if (boardCanvas) boardCanvas.innerHTML = msg;
    if (peopleCanvas) peopleCanvas.innerHTML = msg;
    if (preNostrCanvas) preNostrCanvas.innerHTML = msg;
    if (streamersCanvas) streamersCanvas.innerHTML = msg;
    if (zappersCanvas) zappersCanvas.innerHTML = msg;
    if (appmixCanvas) appmixCanvas.innerHTML = msg;
    if (epgridCanvas) epgridCanvas.innerHTML = msg;
  }

  // ── RSS parsing — episode number + publish date for the markers ────
  function parseEpisodes(xml) {
    var episodes = [];
    var itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    var m;
    while ((m = itemRe.exec(xml)) !== null) {
      var item = m[1];
      var num = episodeNumber(item);
      var pubMs = Date.parse(tagText(item, 'pubDate'));
      if (num != null && isFinite(pubMs)) {
        episodes.push({
          num: num,
          pubMs: pubMs,
          title: tagText(item, 'title') || ('Episode ' + num),
        });
      }
    }
    return episodes;
  }

  // Episode number: <itunes:episode> wins; otherwise parse the title.
  // Covers both "… | Ep. NNN" and episode 1's "001. …" leading form.
  function episodeNumber(item) {
    var tag = tagText(item, 'itunes:episode') || tagText(item, 'episode');
    if (tag) {
      var n = parseInt(tag, 10);
      if (isFinite(n) && n > 0) return n;
    }
    var title = tagText(item, 'title') || '';
    var t = title.match(/\bEp(?:isode)?\.?\s*0*(\d+)/i) ||
            title.match(/(?:^|\s|•\s)0*(\d+)\.\s/);
    if (t) {
      var tn = parseInt(t[1], 10);
      if (isFinite(tn) && tn > 0) return tn;
    }
    return null;
  }

  function tagText(xml, tag) {
    var re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>');
    var mm = xml.match(re);
    if (!mm) return '';
    return mm[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .trim();
  }

  // ── Podcast Sat Distribution — live totals as tiles ────────────────
  // One tile per category for the chosen range (1W / 1M / ALL, measured
  // back from now on settled_at) and view:
  //
  //   Sat Splits: Rev (Net), Reed (Net), Guests, V4V Budget, Fountain,
  //     Samourai Devs. Each host's tile is their share minus half of the
  //     production costs (the * carries that explanation as a tooltip), so
  //     the six tiles sum to received minus costs. Ep 015 routes
  //     entirely to Samourai Devs (see SAMOURAI_EP). Costs accrue evenly
  //     across each bill's calendar month (COSTS), so a 1W window carries
  //     about a quarter of a month's bill and a bill dated in the future
  //     adds nothing until its month starts.
  //   By App: whatever `app` names the rows carry, largest first. The set
  //     is data-driven, so a new app (OnlyBoosts, say) appears on its own
  //     the first time someone boosts from it; only its color is a fixed
  //     map (appColorVar), and an unmapped app gets the grey "other" color.
  //
  // Every row counts (boosts, streams, zaps), as the old chart did.
  var RANGE_OPTIONS = [['1w', '1W'], ['1m', '1M'], ['all', 'All']];
  var VIEW_OPTIONS = [['splits', 'Sat Splits'], ['apps', 'By App']];
  var HOST_NET_TIP = 'Share of the sats minus half of the production costs (Fountain and Riverside) for the range.';
  var SPLIT_TILES = [
    { k: 'rev',      label: 'Rev (Net)',     c: '--bucket-rev',  tip: HOST_NET_TIP },
    { k: 'reed',     label: 'Reed (Net)',    c: '--bucket-reed', tip: HOST_NET_TIP },
    { k: 'guests',   label: 'Guests',        c: '--bucket-guests' },
    { k: 'aquafox',  label: 'V4V Budget',    c: '--bucket-adbudget' },
    { k: 'fountain', label: 'Fountain',      c: '--bucket-fountain' },
    { k: 'samourai', label: 'Samourai Devs', c: '--bucket-samourai' },
  ];
  var APP_LABELS = { 'nostr zaps': 'Nostr Zaps' };

  function renderDistribution(rows) {
    if (!canvas) return;
    var firstMs = Infinity;
    for (var i = 0; i < rows.length; i++) {
      var ms = Date.parse(rows[i].settled_at);
      if (ms < firstMs) firstMs = ms;
    }

    var state = { range: 'all', view: 'splits' };

    function rangeStart(key) {
      if (key === '1w') return Date.now() - 7 * DAY_MS;
      if (key === '1m') return Date.now() - 30 * DAY_MS;
      return -Infinity;
    }
    function rangePhrase(key) {
      if (key === '1w') return 'over the last 7 days';
      if (key === '1m') return 'over the last 30 days';
      return isFinite(firstMs) ? 'since ' + fmtDate(firstMs) : 'all time';
    }

    // Operating costs inside [start, now], each bill spread evenly over
    // the days of its calendar month (UTC).
    function costsWithin(start) {
      var now = Date.now();
      var total = 0;
      for (var c = 0; c < COSTS.length; c++) {
        var bill = COSTS[c];
        var d = new Date(bill.ms);
        var mStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        var mEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        var overlap = Math.min(now, mEnd) - Math.max(start, mStart);
        if (overlap <= 0) continue;
        total += bill.sats * (overlap / (mEnd - mStart));
      }
      return Math.round(total);
    }

    function compute(rangeKey) {
      var start = rangeStart(rangeKey);
      var splits = { reed: 0, rev: 0, guests: 0, aquafox: 0, fountain: 0, samourai: 0 };
      var apps = Object.create(null);
      var gross = 0;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (Date.parse(row.settled_at) < start) continue;
        gross += row.total_sats;
        if (parseInt(row.episode_num, 10) === SAMOURAI_EP) {
          splits.samourai += row.total_sats;
        } else {
          splits.reed     += row.reed_sats     || 0;
          splits.rev      += row.rev_sats      || 0;
          splits.guests   += row.guests_sats   || 0;
          splits.aquafox  += row.aquafox_sats  || 0;
          splits.fountain += row.fountain_sats || 0;
        }
        var app = row.app || 'Other';
        apps[app] = (apps[app] || 0) + row.total_sats;
      }
      splits.costs = costsWithin(start);
      return { gross: gross, splits: splits, apps: apps };
    }

    // `tip`, when given, adds a * after the label that explains the number
    // on hover, or on tap (the page's [data-tip] tooltip, see
    // ensureChartTooltipEl).
    function tile(label, value, colorVar, tip) {
      var t = document.createElement('div');
      t.className = 'stats-tile';
      t.style.setProperty('--c', 'var(' + colorVar + ')');
      var l = document.createElement('span');
      l.className = 'stats-tile-label';
      l.textContent = label;
      if (tip) {
        var star = document.createElement('span');
        star.className = 'stats-tile-star';
        star.textContent = '*';
        star.setAttribute('data-tip', tip);
        star.setAttribute('role', 'img');
        star.setAttribute('aria-label', tip);
        l.appendChild(star);
      }
      var v = document.createElement('span');
      v.className = 'stats-tile-value';
      v.textContent = fmtSats(value);
      var u = document.createElement('span');
      u.className = 'stats-tile-unit';
      u.textContent = 'sats';
      t.appendChild(l);
      t.appendChild(v);
      t.appendChild(u);
      return t;
    }

    function draw() {
      var data = compute(state.range);
      var grid = document.createElement('div');
      grid.className = 'stats-tiles ' + (state.view === 'splits' ? 'stats-tiles--3' : 'stats-tiles--4');
      if (state.view === 'splits') {
        // Each host absorbs half of the costs, capped at what they were paid
        // (the same rule the old cumulative chart used).
        var half = data.splits.costs / 2;
        var shown = {
          reed: Math.max(0, Math.round(data.splits.reed - half)),
          rev:  Math.max(0, Math.round(data.splits.rev - half)),
        };
        for (var t = 0; t < SPLIT_TILES.length; t++) {
          var def = SPLIT_TILES[t];
          var val = def.k in shown ? shown[def.k] : (data.splits[def.k] || 0);
          grid.appendChild(tile(def.label, val, def.c, def.tip || ''));
        }
      } else {
        var names = Object.keys(data.apps).sort(function (a, b) { return data.apps[b] - data.apps[a]; });
        if (!names.length) {
          var empty = document.createElement('p');
          empty.className = 'stats-error';
          empty.textContent = 'No boosts ' + rangePhrase(state.range) + '.';
          grid.appendChild(empty);
        }
        for (var n = 0; n < names.length; n++) {
          grid.appendChild(tile(APP_LABELS[names[n]] || names[n], data.apps[names[n]], appColorVar(names[n]), ''));
        }
      }
      // The subline is the total received for the range, on both views.
      if (subEl) subEl.textContent = fmtSats(data.gross) + ' sats received ' + rangePhrase(state.range);
      canvas.innerHTML = '';
      canvas.appendChild(grid);
    }

    if (distControlsEl) {
      distControlsEl.innerHTML = '';
      distControlsEl.appendChild(viewControl(state.view, function (key) {
        state.view = key;
        draw();
      }));
      distControlsEl.appendChild(rangeControl(state.range, function (key) {
        state.range = key;
        draw();
      }));
    }
    draw();
  }

  // Borderless 1W / 1M / All segmented control, ported from the feeds
  // page (feeds-podcasts.js rangeControl): the selected segment's faint
  // tint is the only chrome.
  function rangeControl(initialKey, onPick) {
    var wrap = document.createElement('div');
    wrap.className = 'pcast-range';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Time range');
    var btns = [];
    function setActive(key) {
      for (var i = 0; i < btns.length; i++) {
        var on = RANGE_OPTIONS[i][0] === key;
        btns[i].classList.toggle('is-active', on);
        btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    RANGE_OPTIONS.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pcast-range-btn';
      b.textContent = opt[1];
      b.title = opt[0] === 'all' ? 'All time' :
        'Last ' + (opt[0] === '1w' ? '7 days' : '30 days');
      b.addEventListener('click', function () { setActive(opt[0]); onPick(opt[0]); });
      btns.push(b);
      wrap.appendChild(b);
    });
    setActive(initialKey);
    return wrap;
  }

  // "View: Sat Splits ▾" dropdown, ported from the feeds page sort control
  // (outside-click / Escape to close). Calls onPick(key) on selection.
  function viewControl(initialKey, onPick) {
    function labelFor(k) {
      for (var i = 0; i < VIEW_OPTIONS.length; i++) if (VIEW_OPTIONS[i][0] === k) return VIEW_OPTIONS[i][1];
      return VIEW_OPTIONS[0][1];
    }
    var wrap = document.createElement('div');
    wrap.className = 'pcast-sort';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pcast-sort-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Choose a breakdown';
    var tag = document.createElement('span');
    tag.className = 'pcast-sort-tag';
    tag.textContent = 'View: ';
    var cur = document.createElement('span');
    cur.className = 'pcast-sort-cur';
    cur.textContent = labelFor(initialKey);
    var caret = document.createElement('span');
    caret.className = 'pcast-sort-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    btn.appendChild(tag); btn.appendChild(cur); btn.appendChild(caret);

    var activeKey = initialKey;
    var menu = document.createElement('div');
    menu.className = 'pcast-sort-menu';
    menu.hidden = true;
    var items = VIEW_OPTIONS.map(function (opt) {
      var it = document.createElement('button');
      it.type = 'button';
      it.className = 'pcast-sort-item';
      it.textContent = opt[1];
      it.addEventListener('click', function () {
        activeKey = opt[0];
        cur.textContent = opt[1];
        close();
        onPick(opt[0]);
      });
      menu.appendChild(it);
      return it;
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);

    function refreshActive() {
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', VIEW_OPTIONS[i][0] === activeKey);
      }
    }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    function open() {
      refreshActive();
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey);
    }
    function close() {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey);
    }
    btn.addEventListener('click', function () { if (menu.hidden) open(); else close(); });
    return wrap;
  }

  // Tile accent per app; mirrors appCls (the App Mix chart).
  function appColorVar(app) {
    switch (app) {
      case 'Fountain':            return '--app-fountain';
      case 'localbitcoiners.com': return '--app-website';
      case 'PodcastGuru':         return '--app-podguru';
      case 'CurioCaster':         return '--app-curio';
      case 'Castamatic':          return '--app-castamatic';
      case 'BoostMeBitch':        return '--app-bmb';
      case 'nostr zaps':          return '--app-nostr-zaps';
      default:                    return '--app-other';
    }
  }

  // First-of-month timestamps within [minMs, maxMs], for X-axis ticks.
  function monthTicks(minMs, maxMs) {
    var ticks = [];
    var start = new Date(minMs);
    var cur = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    while (cur <= maxMs) {
      var cd = new Date(cur);
      ticks.push({ ms: cur, label: MONTHS[cd.getUTCMonth()] });
      cur = Date.UTC(cd.getUTCFullYear(), cd.getUTCMonth() + 1, 1);
    }
    // Short ranges may straddle no month boundary — anchor with the start.
    if (!ticks.length) {
      ticks.push({ ms: minMs, label: MONTHS[start.getUTCMonth()] });
    }
    return ticks;
  }

  // ── App mix over time — multi-line per-week chart ──────────────────
  // Buckets every row's total_sats by ISO week (Mon-start UTC) × app,
  // then renders one line per app: percentage-of-week or absolute sats.
  function renderAppMix(rows) {
    if (!appmixCanvas) return;

    var WEEK_MS = 7 * DAY_MS;
    var byWeekApp = Object.create(null);        // sats sums (every kind)
    var byWeekAppBoost = Object.create(null);   // boost-row counts only
    var byWeekAppStream = Object.create(null);  // stream-row counts only
    var appsSeen = Object.create(null);
    var minWeek = Infinity, maxWeek = -Infinity;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var t = Date.parse(row.settled_at);
      if (!isFinite(t)) continue;
      var wk = weekStartMs(t);
      var app = row.app || 'Other';
      appsSeen[app] = true;
      var bucket = byWeekApp[wk] || (byWeekApp[wk] = Object.create(null));
      bucket[app] = (bucket[app] || 0) + row.total_sats;
      if (row.kind === 'boost') {
        var bb = byWeekAppBoost[wk] || (byWeekAppBoost[wk] = Object.create(null));
        bb[app] = (bb[app] || 0) + 1;
      } else if (row.kind === 'stream') {
        var bs = byWeekAppStream[wk] || (byWeekAppStream[wk] = Object.create(null));
        bs[app] = (bs[app] || 0) + 1;
      }
      if (wk < minWeek) minWeek = wk;
      if (wk > maxWeek) maxWeek = wk;
    }

    if (!isFinite(minWeek)) {
      appmixCanvas.innerHTML = '<p class="stats-error">No app data yet.</p>';
      return;
    }
    // Always extend the axis to the current week so the timeline reads
    // as current even when the latest week has no boosts.
    var nowWeek = weekStartMs(Date.now());
    if (nowWeek > maxWeek) maxWeek = nowWeek;

    var weeks = [];
    for (var w = minWeek; w <= maxWeek; w += WEEK_MS) {
      var b = byWeekApp[w] || {};
      var bc = byWeekAppBoost[w] || {};
      var sc = byWeekAppStream[w] || {};
      var totalW = 0;
      for (var aa in b) totalW += b[aa];
      weeks.push({ start: w, byApp: b, byAppBoost: bc, byAppStream: sc, total: totalW });
    }

    // Order apps by all-time total sats (descending). The highest-total
    // app draws last, ending up on top in the SVG paint order.
    var appList = Object.keys(appsSeen);
    var allTime = Object.create(null);
    var allTimeBoost = Object.create(null);
    var allTimeStream = Object.create(null);
    for (var w2 = 0; w2 < weeks.length; w2++) {
      for (var a2 in weeks[w2].byApp) {
        allTime[a2] = (allTime[a2] || 0) + weeks[w2].byApp[a2];
      }
      for (var a3 in weeks[w2].byAppBoost) {
        allTimeBoost[a3] = (allTimeBoost[a3] || 0) + weeks[w2].byAppBoost[a3];
      }
      for (var a4 in weeks[w2].byAppStream) {
        allTimeStream[a4] = (allTimeStream[a4] || 0) + weeks[w2].byAppStream[a4];
      }
    }
    appList.sort(function (a, b) { return allTime[b] - allTime[a]; });

    // The count views (Boosts / Streams) each use their own app list: only
    // apps that have ever taken that kind, ordered by all-time count. This
    // drops apps that would otherwise sit as a flat zero line (e.g. "nostr
    // zaps" in the Boosts view, or boost-only apps in the Streams view).
    function countAppList(totals) {
      return appList.filter(function (a) { return totals[a] > 0; })
        .sort(function (a, b) { return totals[b] - totals[a]; });
    }
    var boostAppList = countAppList(allTimeBoost);
    var streamAppList = countAppList(allTimeStream);

    function appsForView(view) {
      return view === 'boosts' ? boostAppList
        : view === 'streams' ? streamAppList
        : appList;
    }

    function renderLegend(list) {
      if (!appmixLegendEl) return;
      appmixLegendEl.innerHTML = '';
      for (var li = 0; li < list.length; li++) {
        var liEl = document.createElement('li');
        var sw = document.createElement('span');
        sw.className = 'stats-legend-swatch';
        sw.style.setProperty('--c', 'var(--' + appCls(list[li]).replace(/^stats-app-/, 'app-') + ')');
        liEl.appendChild(sw);
        liEl.appendChild(document.createTextNode(' ' + list[li]));
        appmixLegendEl.appendChild(liEl);
      }
    }

    function draw(view) {
      var list = appsForView(view);
      appmixCanvas.innerHTML = buildAppMixSvg(weeks, list, view);
      renderLegend(list);
    }
    draw('percent');

    var radios = document.querySelectorAll('input[name="stats-appmix-view"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (e) {
        if (e.target.checked) draw(e.target.value);
      });
    }

    setupChartTooltip(appmixCanvas);
  }

  // Custom JS tooltip system, shared by every chart on the page.
  // Wired at the DOCUMENT level via delegation — turns out per-canvas
  // listeners weren't catching reliably in Chrome on Android / the PWA
  // (events were either being swallowed inside the inline SVG's hit
  // graph or routed to body), so a single document-level handler
  // covers every chart and never misses regardless of where the touch
  // ends up retargeted to.
  //
  // Two interaction modes share the same popup:
  //   - Desktop hover — mouseover shows a transient tooltip, mouseout
  //     hides it (instant; native SVG <title> would have a ~half-second
  //     browser delay).
  //   - Tap-to-pin — clicking or tapping a [data-tip] element pins the
  //     tooltip; tapping anywhere else dismisses it.
  var chartTooltipEl = null;
  var chartTooltipPinned = false;

  function ensureChartTooltipEl() {
    if (chartTooltipEl) return chartTooltipEl;
    var tip = document.createElement('div');
    tip.className = 'stats-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
    chartTooltipEl = tip;

    function positionTip(coord) {
      // Accepts MouseEvent or Touch (both have .clientX / .clientY).
      var pad = 12;
      var px = coord.clientX + pad;
      var py = coord.clientY - tip.offsetHeight - 8;
      if (py < 4) py = coord.clientY + pad;
      var maxX = window.innerWidth - tip.offsetWidth - 4;
      var maxY = window.innerHeight - tip.offsetHeight - 4;
      if (px > maxX) px = maxX;
      if (px < 4) px = 4;
      if (py > maxY) py = maxY;
      if (py < 4) py = 4;
      tip.style.left = px + 'px';
      tip.style.top = py + 'px';
    }

    // Hover layer — desktop mouse only. mouseover on touch is unreliable
    // (sometimes synthesized, sometimes not), so it's just additive.
    document.addEventListener('mouseover', function (e) {
      if (chartTooltipPinned) return;
      var hit = e.target.closest && e.target.closest('[data-tip]');
      if (!hit) return;
      var text = hit.getAttribute('data-tip');
      if (!text) return;
      tip.textContent = text;
      tip.hidden = false;
      positionTip(e);
    });
    document.addEventListener('mousemove', function (e) {
      if (chartTooltipPinned) return;
      if (tip.hidden) return;
      if (!(e.target.closest && e.target.closest('[data-tip]'))) return;
      positionTip(e);
    });
    document.addEventListener('mouseout', function (e) {
      if (chartTooltipPinned) return;
      var hit = e.target.closest && e.target.closest('[data-tip]');
      if (!hit) return;
      var to = e.relatedTarget;
      if (to && hit.contains(to)) return;
      if (to && to.closest && to.closest('[data-tip]')) return;
      tip.hidden = true;
    });

    // Tap/click layer — pin if hitting a [data-tip], dismiss otherwise.
    // Three event types so we catch whichever the browser actually
    // fires reliably on this platform. Each is idempotent; multiple
    // can fire on the same gesture without harm.
    function pinOrDismiss(e) {
      var hit = e.target.closest && e.target.closest('[data-tip]');
      if (hit) {
        var text = hit.getAttribute('data-tip');
        if (!text) return;
        if (e.cancelable) {
          try { e.preventDefault(); } catch (_) {}
        }
        var coord = (e.changedTouches && e.changedTouches[0]) || e;
        chartTooltipPinned = true;
        tip.textContent = text;
        tip.hidden = false;
        positionTip(coord);
      } else if (chartTooltipPinned) {
        chartTooltipPinned = false;
        tip.hidden = true;
      }
    }
    document.addEventListener('click', pinOrDismiss);
    document.addEventListener('pointerup', pinOrDismiss);
    document.addEventListener('touchend', pinOrDismiss, { passive: false });

    return tip;
  }

  // Kept as the public API the chart renders call. The document-level
  // listeners in ensureChartTooltipEl cover everything, so this is now
  // just an idempotent setup hook.
  function setupChartTooltip(_canvas) {
    ensureChartTooltipEl();
  }

  function buildAppMixSvg(weeks, apps, view) {
    if (weeks.length < 2) {
      return '<p class="stats-error">Not enough data yet.</p>';
    }
    var W = 960, H = 320;
    var mL = 64, mR = 20, mT = 18, mB = 38;
    var pw = W - mL - mR, ph = H - mT - mB;
    var minMs = weeks[0].start;
    var maxMs = weeks[weeks.length - 1].start;
    var spanMs = Math.max(maxMs - minMs, DAY_MS);

    // Per-app per-week values (% or absolute sats).
    var seriesByApp = Object.create(null);
    for (var a = 0; a < apps.length; a++) {
      var app = apps[a];
      var pts = [];
      for (var w = 0; w < weeks.length; w++) {
        var wk = weeks[w];
        var v = view === 'boosts' ? (wk.byAppBoost[app] || 0)
          : view === 'streams' ? (wk.byAppStream[app] || 0)
          : (wk.byApp[app] || 0);
        if (view === 'percent') v = wk.total > 0 ? (v / wk.total) * 100 : 0;
        pts.push({ ms: wk.start, val: v });
      }
      seriesByApp[app] = pts;
    }

    var yMax;
    if (view === 'percent') {
      yMax = 100;
    } else if (view === 'boosts') {
      // Fixed scale so the boosts chart stays comparable week-to-week:
      // 25 max, gridlines every 5. (Peak per-app weekly count is ~23.)
      yMax = 25;
    } else if (view === 'streams') {
      // Fixed scale, same rationale: 10 max, gridlines every 2. (Peak
      // per-app weekly count is ~6.)
      yMax = 10;
    } else {
      yMax = 0;
      for (var aa = 0; aa < apps.length; aa++) {
        var sa = seriesByApp[apps[aa]];
        for (var ii = 0; ii < sa.length; ii++) {
          if (sa[ii].val > yMax) yMax = sa[ii].val;
        }
      }
      yMax = niceCeil(yMax > 0 ? yMax : 1);
    }

    function x(ms) { return mL + ((ms - minMs) / spanMs) * pw; }
    function y(v) { return mT + ph - (v / yMax) * ph; }

    var parts = [];

    // Y gridlines + labels.
    var ySteps = view === 'percent' ? [0, 0.25, 0.5, 0.75, 1]
      : view === 'boosts' || view === 'streams' ? [0, 0.2, 0.4, 0.6, 0.8, 1]
      : [0, 0.5, 1];
    for (var s = 0; s < ySteps.length; s++) {
      var yv = yMax * ySteps[s];
      var yy = y(yv);
      parts.push('<line class="stats-chart-grid" x1="' + mL + '" y1="' + yy +
        '" x2="' + (W - mR) + '" y2="' + yy + '"/>');
      var lbl = view === 'percent' ? Math.round(yv) + '%' : fmtSats(Math.round(yv));
      parts.push('<text class="stats-chart-ylabel" x="' + (mL - 8) + '" y="' +
        (yy + 4) + '">' + lbl + '</text>');
    }

    // X axis: month boundaries.
    var months = monthTicks(minMs, maxMs);
    for (var mi = 0; mi < months.length; mi++) {
      var mx = x(months[mi].ms);
      parts.push('<line class="stats-chart-grid" x1="' + mx + '" y1="' + mT +
        '" x2="' + mx + '" y2="' + (mT + ph) + '"/>');
      parts.push('<text class="stats-chart-xlabel" x="' + mx + '" y="' +
        (H - mB + 20) + '">' + months[mi].label + '</text>');
    }

    // Lines per app + dots with tooltips. Bottom-up paint order so the
    // largest-total app draws last and sits on top.
    for (var ai = apps.length - 1; ai >= 0; ai--) {
      var app2 = apps[ai];
      var cls = appCls(app2);
      var spts = seriesByApp[app2];
      var ptsStr = [];
      for (var p = 0; p < spts.length; p++) {
        ptsStr.push(x(spts[p].ms) + ',' + y(spts[p].val));
      }
      parts.push('<polyline class="stats-appmix-line ' + cls +
        '" points="' + ptsStr.join(' ') + '"/>');
      for (var p2 = 0; p2 < spts.length; p2++) {
        var sp = spts[p2];
        // Skip 0-value dots in every view — many inactive apps would
        // otherwise pile dots on top of each other along the x-axis.
        // The line still rests at zero to show the app had nothing.
        if (sp.val <= 0) continue;
        var labelTxt;
        if (view === 'percent') {
          labelTxt = app2 + ' — ' + sp.val.toFixed(1) + '% (' + fmtWeekRange(sp.ms) + ')';
        } else if (view === 'boosts') {
          var nb = Math.round(sp.val);
          labelTxt = app2 + ' — ' + nb + (nb === 1 ? ' boost' : ' boosts') +
            ' (' + fmtWeekRange(sp.ms) + ')';
        } else if (view === 'streams') {
          var ns = Math.round(sp.val);
          labelTxt = app2 + ' — ' + ns + (ns === 1 ? ' stream' : ' streams') +
            ' (' + fmtWeekRange(sp.ms) + ')';
        } else {
          labelTxt = app2 + ' — ' + fmtSats(Math.round(sp.val)) + ' sats (' + fmtWeekRange(sp.ms) + ')';
        }
        var dx = x(sp.ms), dy = y(sp.val);
        // <g> wraps an invisible-hit-testable halo + visible inner dot;
        // the halo grows visible on hover via CSS, and setupChartTooltip
        // reads data-tip to show the popup (hover OR tap-to-pin).
        parts.push('<g class="stats-appmix-dotgrp ' + cls +
          '" data-tip="' + xmlEsc(labelTxt) + '">' +
          '<circle class="stats-appmix-halo" cx="' + dx + '" cy="' + dy + '" r="11"/>' +
          '<circle class="stats-appmix-dot" cx="' + dx + '" cy="' + dy + '" r="4.5"/>' +
          '</g>');
      }
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stats-chart-svg" ' +
      'role="img" preserveAspectRatio="xMidYMid meet" ' +
      'aria-label="App mix over time">' + parts.join('') + '</svg>';
  }

  function weekStartMs(ms) {
    var d = new Date(ms);
    var dow = d.getUTCDay();  // 0=Sun, 6=Sat
    var mondayOffset = (dow === 0) ? -6 : 1 - dow;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset);
  }

  function fmtWeekRange(weekMs) {
    var s = new Date(weekMs);
    var e = new Date(weekMs + 6 * DAY_MS);
    var sm = MONTHS[s.getUTCMonth()];
    var em = MONTHS[e.getUTCMonth()];
    if (sm === em) return sm + ' ' + s.getUTCDate() + '–' + e.getUTCDate();
    return sm + ' ' + s.getUTCDate() + '–' + em + ' ' + e.getUTCDate();
  }

  function appCls(app) {
    switch (app) {
      case 'Fountain':            return 'stats-app-fountain';
      case 'localbitcoiners.com': return 'stats-app-website';
      case 'PodcastGuru':         return 'stats-app-podguru';
      case 'CurioCaster':         return 'stats-app-curio';
      case 'Castamatic':          return 'stats-app-castamatic';
      case 'BoostMeBitch':        return 'stats-app-bmb';
      case 'nostr zaps':          return 'stats-app-nostr-zaps';
      default:                    return 'stats-app-other';
    }
  }

  // Always show one decimal place so tooltips read consistently across
  // dominant apps and sub-percent slivers (e.g. "87.3%" + "0.1%").
  function fmtPct(n) {
    return n.toFixed(1) + '%';
  }

  // ── Episode leaderboard — horizontal bar chart ─────────────────────
  function renderLeaderboard(rows) {
    if (!boardCanvas) return;

    // Group episode-attributed rows by episode number. A "supporter" is
    // keyed by npub, else display name; rows with neither (truly anon)
    // each count as their own supporter.
    var byEp = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.episode_num == null) continue;  // show-level rows get no bar
      var num = parseInt(row.episode_num, 10);
      if (!isFinite(num) || num <= 0) continue;
      var ep = byEp[num] ||
        (byEp[num] = { num: num, sats: 0, keys: Object.create(null), anon: 0 });
      ep.sats += row.total_sats;
      var key = row.sender_npub || row.sender_name;
      if (key) ep.keys[key] = true;
      else ep.anon += 1;
    }

    var episodes = [];
    for (var k in byEp) {
      episodes.push({
        num: byEp[k].num,
        sats: byEp[k].sats,
        supporters: Object.keys(byEp[k].keys).length + byEp[k].anon,
      });
    }
    if (!episodes.length) {
      boardCanvas.innerHTML = '<p class="stats-error">No episode data yet.</p>';
      return;
    }

    function draw(metric) {
      if (metric === 'mine') { drawMine(); return; }
      var sorted = episodes.slice()
        .sort(function (a, b) { return b[metric] - a[metric]; })
        .slice(0, 10);
      var items = sorted.map(function (e) {
        return { label: 'Ep ' + e.num, value: e[metric], href: epHref(e.num) };
      });
      boardCanvas.innerHTML = buildBarSvg(items, metric === 'sats'
        ? 'Episodes ranked by total sats received'
        : 'Episodes ranked by unique supporters',
        { breakOutlier: metric === 'sats' });
      if (boardSubEl) {
        boardSubEl.textContent = metric === 'sats'
          ? 'Top ' + sorted.length + ' episodes by total sats received (boosts + streams)'
          : 'Top ' + sorted.length + ' episodes by unique supporters (boosts + streams)';
      }
    }

    // "My Stats" — the signed-in user's own per-episode boost totals.
    // Not logged in → show a prompt and open the login modal; the
    // onChange hook below redraws the moment they sign in (or a session
    // restore completes). Anonymous (burner-signed) boosts carry no
    // sender_npub, so they correctly never show up as "yours".
    function drawMine() {
      if (boardSubEl) boardSubEl.textContent = 'Sats you’ve boosted to each episode';
      var user = window.LBLogin && typeof window.LBLogin.getUser === 'function'
        ? window.LBLogin.getUser() : null;
      if (!user || !user.npub) {
        boardCanvas.innerHTML = '<p class="stats-error">Sign in with Nostr to see the sats you’ve boosted to each episode.</p>';
        if (window.LBLogin && typeof window.LBLogin.requestLogin === 'function') {
          window.LBLogin.requestLogin();
        }
        return;
      }
      var mineByEp = Object.create(null);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.episode_num == null) continue;
        if (row.sender_npub !== user.npub) continue;
        var num = parseInt(row.episode_num, 10);
        if (!isFinite(num) || num <= 0) continue;
        mineByEp[num] = (mineByEp[num] || 0) + (row.total_sats || 0);
      }
      var mine = [];
      for (var k in mineByEp) mine.push({ num: parseInt(k, 10), sats: mineByEp[k] });
      if (!mine.length) {
        boardCanvas.innerHTML = '<p class="stats-error">You haven’t boosted any episodes yet — boost one and it’ll show up here.</p>';
        return;
      }
      mine.sort(function (a, b) { return b.sats - a.sats; });
      var items = mine.map(function (e) {
        return { label: 'Ep ' + e.num, value: e.sats, href: epHref(e.num) };
      });
      boardCanvas.innerHTML = buildBarSvg(items, 'Sats you have boosted to each episode');
      if (boardSubEl) {
        boardSubEl.textContent = 'You’ve boosted ' + items.length +
          (items.length === 1 ? ' episode' : ' episodes');
      }
    }
    draw('sats');

    var radios = document.querySelectorAll('input[name="stats-board-view"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (e) {
        if (e.target.checked) draw(e.target.value);
      });
    }

    // Show the signed-in user's pfp inside the "My Stats" toggle. Pulls the
    // image straight off the live LBLogin user (profile.image); hides the
    // <img> when logged out or when no avatar is set, and on a broken URL so
    // the pill never shows a busted-image glyph.
    var mineAvatarEl = document.querySelector('[data-mine-avatar]');
    if (mineAvatarEl) {
      mineAvatarEl.addEventListener('error', function () { mineAvatarEl.hidden = true; });
    }
    function updateMineAvatar() {
      if (!mineAvatarEl) return;
      var u = window.LBLogin && typeof window.LBLogin.getUser === 'function'
        ? window.LBLogin.getUser() : null;
      var img = u && u.profile && u.profile.image;
      if (img) {
        mineAvatarEl.src = img;
        mineAvatarEl.hidden = false;
      } else {
        mineAvatarEl.removeAttribute('src');
        mineAvatarEl.hidden = true;
      }
    }
    updateMineAvatar();

    // Redraw the "My Stats" view on login/logout so it reflects the
    // current user as soon as a sign-in (or session restore) lands, and
    // refresh the toggle's avatar to match.
    if (window.LBLogin && typeof window.LBLogin.onChange === 'function') {
      window.LBLogin.onChange(function () {
        updateMineAvatar();
        var sel = document.querySelector('input[name="stats-board-view"]:checked');
        if (sel && sel.value === 'mine') drawMine();
      });
    }
  }

  // Horizontal bar chart. `items` is a pre-sorted [{ label, value,
  // isAnon?, href? }] array, drawn top to bottom; the left margin auto-fits
  // the longest label. Used by the episode leaderboard (the supporter board
  // renders HTML rows, see buildBarRows). A label with `href` links there;
  // plain labels stay plain.
  // opts.breakOutlier: when the top bar(s) dwarf the rest, draw the other
  // bars to scale against the largest NON-outlier value so they stay
  // readable, and render each outlier as a fixed-length "torn" bar (a broken
  // axis) rather than to scale. How many bars get torn is data-driven: we
  // break at the single biggest relative cliff among the first MAX_BREAK
  // rows — so one giant episode (Ep 015's donated 2.1M) breaks just the top
  // bar, while two whales atop the supporter board (adminpacman + sovreign,
  // both dwarfing #3) break the top two. The true value still labels each
  // bar's end, so the number tells the real story even off-scale.
  // Broken-axis geometry shared by the SVG bars (episode board) and the
  // HTML rows (supporter board). When breaking: normal bars scale so the
  // largest NON-outlier fills NORM_FRAC of the track; each outlier's main
  // segment runs to OUT_MAIN, a GAP_W tear, then a short tip staggered by
  // OUT_STAGGER per rank so a bigger outlier still reads as the longer bar.
  var BAR_LAYOUT = { NORM_FRAC: 0.70, OUT_MAIN: 0.80, OUT_END: 0.90, OUT_STAGGER: 0.04, GAP_W: 14 };

  // Rank the rows by value (descending) to find the "outlier group": the
  // leading bars that dwarf the rest. We break at the single biggest
  // relative cliff among the first MAX_BREAK boundaries — data-driven, so
  // the count of torn bars matches the shape of the data and self-disables
  // when the leaderboard evens out. Returns { doBreak, breakRank, scaleMax }
  // where breakRank[originalIdx] is the 0-based rank inside the outlier group.
  function barPlan(values, breakOutlier) {
    var order = values.map(function (v, idx) { return idx; })
      .sort(function (a, b) { return values[b] - values[a]; });
    var BREAK_RATIO = 1.8, MAX_BREAK = 2;
    var nBreak = 0, bestRatio = 0;
    if (breakOutlier) {
      var lastC = Math.min(MAX_BREAK, order.length - 1);
      for (var c = 1; c <= lastC; c++) {
        var hi = values[order[c - 1]], lo = values[order[c]];
        if (lo <= 0) break;
        var ratio = hi / lo;
        if (ratio >= BREAK_RATIO && ratio > bestRatio) { bestRatio = ratio; nBreak = c; }
      }
    }
    var breakRank = Object.create(null);
    for (var b = 0; b < nBreak; b++) breakRank[order[b]] = b;
    var doBreak = nBreak > 0;
    var scaleMax = doBreak ? values[order[nBreak]] : values[order[0]];
    if (scaleMax <= 0) scaleMax = 1;
    return { doBreak: doBreak, breakRank: breakRank, scaleMax: scaleMax };
  }

  function buildBarSvg(items, ariaLabel, opts) {
    opts = opts || {};
    var W = 720;
    var rowH = 30, barH = 18, mT = 14, mB = 14, mR = 92;
    var longest = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].label.length > longest) longest = items[i].label.length;
    }
    var mL = Math.min(Math.max(longest * 7 + 16, 58), 180);
    var H = mT + mB + items.length * rowH;
    var tw = W - mL - mR;

    var plan = barPlan(items.map(function (it) { return it.value; }), opts.breakOutlier);
    var doBreak = plan.doBreak, breakRank = plan.breakRank, scaleMax = plan.scaleMax;
    var OUT_MAIN = BAR_LAYOUT.OUT_MAIN, OUT_END = BAR_LAYOUT.OUT_END,
        OUT_STAGGER = BAR_LAYOUT.OUT_STAGGER, GAP_W = BAR_LAYOUT.GAP_W;
    var normFullW = doBreak ? tw * BAR_LAYOUT.NORM_FRAC : tw;

    var parts = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var cy = mT + k * rowH + rowH / 2;
      var cls = it.isAnon ? 'stats-bar stats-bar-anon' : 'stats-bar';
      var labelEl = '<text class="stats-bar-label" x="' + (mL - 8) + '" y="' +
        (cy + 4) + '">' + svgEsc(it.label) + '</text>';
      if (it.href) {
        parts.push('<a class="stats-bar-link" href="' + svgEsc(it.href) + '">' +
          labelEl + '</a>');
      } else {
        parts.push(labelEl);
      }

      if (doBreak && k in breakRank) {
        // Torn outlier bar: main segment + staggered tip, two break slashes between.
        var r = breakRank[k];
        var mainW = tw * OUT_MAIN;
        var gapStart = mL + mainW;
        var gapEnd = gapStart + GAP_W;
        var tipEnd = mL + tw * (OUT_END - r * OUT_STAGGER);
        var top = cy - barH / 2;
        parts.push('<rect class="' + cls + '" x="' + mL + '" y="' + top +
          '" width="' + mainW + '" height="' + barH + '" rx="3"/>');
        parts.push('<rect class="' + cls + '" x="' + gapEnd + '" y="' + top +
          '" width="' + (tipEnd - gapEnd) + '" height="' + barH + '" rx="3"/>');
        parts.push('<path class="stats-bar-break" d="M' + (gapStart + 2) + ',' +
          (cy + barH / 2 + 3) + ' L' + (gapStart + 8) + ',' + (cy - barH / 2 - 3) +
          ' M' + (gapStart + 8) + ',' + (cy + barH / 2 + 3) + ' L' +
          (gapStart + 14) + ',' + (cy - barH / 2 - 3) + '"/>');
        parts.push('<text class="stats-bar-value" x="' + (tipEnd + 8) + '" y="' +
          (cy + 4) + '">' + fmtSats(it.value) + '</text>');
        continue;
      }

      var bw = Math.max((it.value / scaleMax) * normFullW, 2);
      if (bw > normFullW) bw = normFullW;   // guard rounding past the cap
      parts.push('<rect class="' + cls + '" x="' + mL + '" y="' + (cy - barH / 2) +
        '" width="' + bw + '" height="' + barH + '" rx="3"/>');
      parts.push('<text class="stats-bar-value" x="' + (mL + bw + 8) + '" y="' +
        (cy + 4) + '">' + fmtSats(it.value) + '</text>');
    }
    // role="group", not "img": the labels are links and buttons, and an
    // image role would hide them from assistive tech.
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stats-bar-svg" ' +
      'role="group" preserveAspectRatio="xMidYMid meet" aria-label="' +
      svgEsc(ariaLabel) + '">' + parts.join('') + '</svg>';
  }

  // Horizontal bars as HTML rows, one identity chip (avatar + name, the
  // same chip the Streamers and Top Zappers cards use) per row with the
  // bar beside it. Same broken-axis treatment as buildBarSvg, expressed in
  // percentages of the track. `items` is a pre-sorted [{ label, value,
  // isAnon?, npub?, picture? }] array. Chips with an npub open the person's
  // OnlyBoosts page or copy the npub (wireIdentity); the rest stay plain.
  function buildBarRows(items, ariaLabel, opts) {
    opts = opts || {};
    var plan = barPlan(items.map(function (it) { return it.value; }), opts.breakOutlier);
    var L = BAR_LAYOUT;
    var wrap = document.createElement('div');
    wrap.className = 'stats-hbars';
    wrap.setAttribute('role', 'list');
    wrap.setAttribute('aria-label', ariaLabel);
    // The value column is reserved at the right of every track so bars
    // scale against the same usable width the SVG version uses.
    var usable = '(100% - 92px)';

    function seg(frac, anon) {
      var b = document.createElement('span');
      b.className = anon ? 'stats-hbar stats-hbar-anon' : 'stats-hbar';
      b.style.width = 'calc(' + usable + ' * ' + frac.toFixed(4) + ')';
      return b;
    }

    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var row = document.createElement('div');
      row.className = 'stats-hbar-row';
      row.setAttribute('role', 'listitem');
      row.appendChild(buildIdentityChip(it));

      var track = document.createElement('div');
      track.className = 'stats-hbar-track';
      if (plan.doBreak && k in plan.breakRank) {
        // Torn outlier bar: main segment, two break slashes, staggered tip.
        var r = plan.breakRank[k];
        track.appendChild(seg(L.OUT_MAIN, it.isAnon));
        var tear = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        tear.setAttribute('class', 'stats-hbar-tear');
        tear.setAttribute('viewBox', '0 0 14 24');
        tear.setAttribute('aria-hidden', 'true');
        tear.innerHTML = '<path d="M2,24 L8,0 M8,24 L14,0"/>';
        track.appendChild(tear);
        var tipFrac = L.OUT_END - r * L.OUT_STAGGER - L.OUT_MAIN;
        var tip = seg(tipFrac, it.isAnon);
        tip.style.width = 'calc(' + usable + ' * ' + tipFrac.toFixed(4) + ' - ' + L.GAP_W + 'px)';
        track.appendChild(tip);
      } else {
        var cap = plan.doBreak ? L.NORM_FRAC : 1;
        var frac = (it.value / plan.scaleMax) * cap;
        if (frac > cap) frac = cap;   // guard rounding past the cap
        var bar = seg(frac, it.isAnon);
        bar.style.minWidth = '2px';
        track.appendChild(bar);
      }
      var val = document.createElement('span');
      val.className = 'stats-hbar-value';
      val.textContent = fmtSats(it.value);
      track.appendChild(val);
      row.appendChild(track);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // The avatar + name chip shared with the Streamers / Top Zappers cards
  // (buildShoutoutRow builds the same shape inline). Wired to OnlyBoosts or
  // copy-npub when the person has an npub.
  function buildIdentityChip(it) {
    var ident = document.createElement('span');
    ident.className = 'ep-supporter-identity';
    var avatar = document.createElement('span');
    avatar.className = 'ep-supporter-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    if (it.picture) {
      avatar.style.backgroundImage = 'url("' + it.picture.replace(/"/g, '%22') + '")';
    }
    var name = document.createElement('span');
    name.className = 'ep-supporter-name';
    name.textContent = it.label;
    name.title = it.label;
    ident.appendChild(avatar);
    ident.appendChild(name);
    if (it.npub) {
      ident.setAttribute('data-npub', it.npub);
      wireIdentity(ident, avatar, it.npub, it.label);
    }
    return ident;
  }

  // ── Supporter leaderboard — horizontal bars by identity ────────────
  function renderIdentityBoard(rows) {
    if (!peopleCanvas) return;

    // Group by identity: keyed by npub, else display name. Rows with
    // neither (truly anonymous) all collapse into one shared bucket,
    // pinned to the bottom of the chart regardless of rank.
    var ANON = '__anon__';
    var byId = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.sender_npub && HOST_NPUBS[row.sender_npub]) continue;  // hosts don't rank
      var npub = row.sender_npub || '';
      var key = npub || row.sender_name || ANON;
      var id = byId[key] || (byId[key] = {
        npub: npub,
        isAnon: key === ANON,
        label: key === ANON ? 'Anonymous' : (row.sender_name || shortNpub(npub)),
        sats: 0,
        episodes: Object.create(null),
      });
      id.sats += row.total_sats;
      if (row.episode_num != null) {
        var num = parseInt(row.episode_num, 10);
        if (isFinite(num) && num > 0) id.episodes[num] = true;
      }
    }

    var anon = null;
    var people = [];
    for (var k in byId) {
      var rec = byId[k];
      rec.episodeCount = Object.keys(rec.episodes).length;
      if (rec.isAnon) anon = rec;
      else people.push(rec);
    }
    if (!people.length && !anon) {
      peopleCanvas.innerHTML = '<p class="stats-error">No supporter data yet.</p>';
      return;
    }

    // Sync pre-resolve labels from the localStorage cache so the
    // initial bar-chart paint already shows display names. The async
    // fetch below then only needs to update the few cache misses.
    var preNpubs = [];
    for (var pp = 0; pp < people.length; pp++) {
      if (people[pp].npub) preNpubs.push(people[pp].npub);
    }
    var preCached = syncCachedProfiles(preNpubs);
    for (var pq = 0; pq < people.length; pq++) {
      var pc = people[pq].npub && preCached[people[pq].npub];
      if (pc && pc.name) people[pq].label = pc.name;
      if (pc && pc.picture) people[pq].picture = pc.picture;
    }

    var fieldOf = { sats: 'sats', episodes: 'episodeCount' };

    function draw(metric) {
      var field = fieldOf[metric] || 'sats';
      var sorted = people.slice()
        .sort(function (a, b) { return b[field] - a[field]; })
        .slice(0, 10);
      // The anonymous bucket is pinned to the bottom of the sats view only.
      // On the episodes view it's dropped: nearly everyone boosts with an
      // npub now, so "how many episodes had anonymous supporters" stopped
      // being a question anyone asks.
      if (anon && metric === 'sats') sorted = sorted.concat([anon]);
      var items = sorted.map(function (p) {
        return { label: p.label, value: p[field], isAnon: p.isAnon,
                 npub: p.npub || '', picture: p.picture || '' };
      });
      peopleCanvas.innerHTML = '';
      peopleCanvas.appendChild(buildBarRows(items, metric === 'sats'
        ? 'Supporters ranked by total sats sent'
        : 'Supporters ranked by episodes supported',
        { breakOutlier: metric === 'sats' }));
      if (peopleSubEl) {
        peopleSubEl.textContent = metric === 'sats'
          ? 'Top 10 supporters by total sats sent (boosts + streams)'
          : 'Top 10 supporters by episodes supported (boosts + streams)';
      }
    }
    draw('episodes');

    var radios = document.querySelectorAll('input[name="stats-people-view"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (e) {
        if (e.target.checked) draw(e.target.value);
      });
    }

    // Upgrade npub labels to display names via episode-enhance.js's
    // shared relay helper, then re-draw so the current metric picks
    // them up. Degrades silently to the truncated-npub fallback.
    var npubs = [];
    for (var p = 0; p < people.length; p++) {
      if (people[p].npub) npubs.push(people[p].npub);
    }
    if (npubs.length && window.LBEpisodeEnhance &&
        typeof window.LBEpisodeEnhance.fetchProfilesByNpub === 'function') {
      window.LBEpisodeEnhance.fetchProfilesByNpub(npubs).then(function (profiles) {
        var changed = false;
        for (var q = 0; q < people.length; q++) {
          var prof = people[q].npub && profiles[people[q].npub];
          if (!prof) continue;
          // Only re-draw if a resolved name or avatar actually differs from
          // the (possibly already-cached) current one — avoids a wasted
          // full re-render when every profile was a cache hit.
          if (prof.name && people[q].label !== prof.name) {
            people[q].label = prof.name;
            changed = true;
          }
          if (prof.picture && people[q].picture !== prof.picture) {
            people[q].picture = prof.picture;
            changed = true;
          }
        }
        if (changed) {
          var checked = document.querySelector('input[name="stats-people-view"]:checked');
          draw(checked ? checked.value : 'sats');
        }
      }).catch(function () {});
    }
  }

  // ── Episodes You’ve Supported — every episode as a tile grid ───────────────────
  // Answers "which episodes have I boosted" the way a ranking can't: one
  // tile per episode in numeric order, so the gaps are visible. Signed in,
  // boosted tiles are filled with the sats you sent and unboosted tiles
  // carry a Boost bolt; signed out, every tile is neutral and a sign-in
  // line sits above the grid. Every tile links to its /ep### page, where
  // the episode boost lives. Anonymous (burner-signed) boosts carry no
  // sender_npub, so they correctly never show up as yours.
  function renderEpisodeGrid(rows, rssEpisodes) {
    if (!epgridCanvas) return;

    // Every episode, numeric order. The RSS is the source of truth; if it
    // failed to load, fall back to the episodes the ledger has seen so the
    // grid still renders (it just can't show episodes nobody has boosted).
    var byNum = Object.create(null);
    var list = rssEpisodes && rssEpisodes.length ? rssEpisodes : [];
    for (var i = 0; i < list.length; i++) {
      byNum[list[i].num] = { num: list[i].num, title: list[i].title || '' };
    }
    if (!list.length) {
      for (var j = 0; j < rows.length; j++) {
        var n = parseInt(rows[j].episode_num, 10);
        if (isFinite(n) && n > 0 && !byNum[n]) byNum[n] = { num: n, title: '' };
      }
    }
    var all = [];
    for (var k in byNum) all.push(byNum[k]);
    all.sort(function (a, b) { return a.num - b.num; });
    if (!all.length) {
      epgridCanvas.innerHTML = '<p class="stats-error">No episode data yet.</p>';
      return;
    }

    var BOLT = '<svg class="stats-ep-bolt" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>';

    function currentUser() {
      var u = window.LBLogin && typeof window.LBLogin.getUser === 'function'
        ? window.LBLogin.getUser() : null;
      return u && u.npub ? u : null;
    }

    function tile(ep, sats, signedIn) {
      var pad = String(ep.num).padStart(3, '0');
      var title = ep.title ? svgEsc(ep.title) : ('Episode ' + pad);
      var cls = 'stats-ep-tile' + (sats > 0 ? ' is-boosted' : '');
      var sub = '';
      if (sats > 0) sub = fmtSats(sats) + ' sats';
      else if (signedIn) sub = BOLT + 'Boost';
      return '<a class="' + cls + '" href="/ep' + pad + '" title="' + title + '">' +
        '<span class="stats-ep-num">Ep ' + pad + '</span>' +
        (sub ? '<span class="stats-ep-sats">' + sub + '</span>' : '') +
        '</a>';
    }

    function draw() {
      var user = currentUser();
      var mineByEp = Object.create(null);
      var boosted = 0;
      if (user) {
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          if (row.episode_num == null || row.sender_npub !== user.npub) continue;
          var num = parseInt(row.episode_num, 10);
          if (!isFinite(num) || num <= 0) continue;
          mineByEp[num] = (mineByEp[num] || 0) + (row.total_sats || 0);
        }
        for (var m in mineByEp) if (mineByEp[m] > 0) boosted += 1;
      }

      var html = '';
      if (!user) {
        html += '<p class="stats-epgrid-login">Sign in with Nostr to see which episodes you’ve boosted. ' +
          '<a href="#" data-epgrid-login>Sign in</a></p>';
      }
      html += '<div class="stats-ep-grid">';
      for (var t = 0; t < all.length; t++) {
        html += tile(all[t], mineByEp[all[t].num] || 0, !!user);
      }
      html += '</div>';
      if (user) {
        html += '<p class="stats-ep-grid-note">Boosts sent anonymously carry no npub and can’t be matched to you.</p>';
      }
      epgridCanvas.innerHTML = html;

      if (epgridSubEl) {
        epgridSubEl.textContent = user
          ? 'You’ve boosted ' + boosted + ' of ' + all.length + ' episodes'
          : 'Every episode of the show; the ones you’ve boosted light up once you sign in';
      }

      var loginLink = epgridCanvas.querySelector('[data-epgrid-login]');
      if (loginLink) {
        loginLink.addEventListener('click', function (e) {
          e.preventDefault();
          if (window.LBLogin && typeof window.LBLogin.requestLogin === 'function') {
            window.LBLogin.requestLogin();
          }
        });
      }
    }
    draw();

    // Redraw on login/logout so the grid reflects the current user as
    // soon as a sign-in (or session restore) lands.
    if (window.LBLogin && typeof window.LBLogin.onChange === 'function') {
      window.LBLogin.onChange(draw);
    }
  }

  // ── Biggest pre-Nostr boosts — mini-card feed ──────────────────────
  // The 10k+ counterpart to the episode pages' "Pre-Nostr Boosts
  // Received" section, aggregated across every episode (and show-level
  // boosts), largest-first. Only boosts settled before the bot cutoff.
  function renderBigPreNostr(rows) {
    if (!preNostrCanvas) return;

    var boosts = rows.filter(function (row) {
      if (row.kind !== 'boost' || row.total_sats < BIG_BOOST_MIN) return false;
      if (PRE_NOSTR_EXCLUDE[row.payment_hash]) return false;  // backfilled — has a note
      var t = Date.parse(row.settled_at);
      return isFinite(t) && t < PRE_NOSTR_CUTOFF_MS;
    });
    if (!boosts.length) {
      preNostrCanvas.innerHTML =
        '<p class="stats-error">No 10,000+ sat pre-Nostr boosts.</p>';
      return;
    }
    boosts.sort(function (a, b) { return b.total_sats - a.total_sats; });

    // Sync pre-resolve from the localStorage cache so cached supporters
    // render with their display names + avatars on the first paint.
    var preNpubsBP = [];
    for (var bi = 0; bi < boosts.length; bi++) {
      if (boosts[bi].sender_npub) preNpubsBP.push(boosts[bi].sender_npub);
    }
    var cachedBP = syncCachedProfiles(preNpubsBP);

    var list = document.createElement('ul');
    list.className = 'ep-supporter-list';
    var npubEls = [];
    for (var i = 0; i < boosts.length; i++) {
      var built = buildPreNostrRow(boosts[i], cachedBP);
      list.appendChild(built.li);
      if (built.npubEl) npubEls.push(built.npubEl);
    }
    preNostrCanvas.innerHTML = '';
    preNostrCanvas.appendChild(list);

    // Resolve npub labels via the shared relay helper, same as the
    // episode pages and the supporter leaderboard.
    var npubs = [];
    var seen = Object.create(null);
    for (var n = 0; n < npubEls.length; n++) {
      if (!seen[npubEls[n].npub]) {
        seen[npubEls[n].npub] = 1;
        npubs.push(npubEls[n].npub);
      }
    }
    if (npubs.length && window.LBEpisodeEnhance &&
        typeof window.LBEpisodeEnhance.fetchProfilesByNpub === 'function') {
      window.LBEpisodeEnhance.fetchProfilesByNpub(npubs).then(function (profiles) {
        for (var m = 0; m < npubEls.length; m++) {
          var prof = profiles[npubEls[m].npub];
          if (!prof) continue;
          if (prof.name) {
            npubEls[m].nameEl.textContent = prof.name;
            if (npubEls[m].linked && npubEls[m].identEl) {
              npubEls[m].identEl.title = 'View ' + prof.name + ' on OnlyBoosts';
              npubEls[m].identEl.setAttribute('aria-label', 'View ' + prof.name + ' on OnlyBoosts');
            }
          }
          if (prof.picture) {
            npubEls[m].avatarEl.style.backgroundImage =
              'url("' + prof.picture.replace(/"/g, '%22') + '")';
          }
        }
      }).catch(function () {});
    }
  }

  function buildPreNostrRow(row, cached) {
    var li = document.createElement('li');
    li.className = 'ep-supporter-row';

    var head = document.createElement('div');
    head.className = 'ep-supporter-head';

    var ident = document.createElement('span');
    ident.className = 'ep-supporter-identity';
    var avatar = document.createElement('span');
    avatar.className = 'ep-supporter-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.className = 'ep-supporter-name';
    var cEntry = cached && row.sender_npub && cached[row.sender_npub];
    if (cEntry && cEntry.name) name.textContent = cEntry.name;
    else if (row.sender_name) name.textContent = row.sender_name;
    else if (row.sender_npub) name.textContent = shortNpub(row.sender_npub);
    else name.textContent = 'Anonymous';
    if (cEntry && cEntry.picture) {
      avatar.style.backgroundImage =
        'url("' + cEntry.picture.replace(/"/g, '%22') + '")';
    }
    ident.appendChild(avatar);
    ident.appendChild(name);

    var npubEl = null;
    if (row.sender_npub) {
      ident.setAttribute('data-npub', row.sender_npub);
      npubEl = { npub: row.sender_npub, nameEl: name, avatarEl: avatar };
    }

    var meta = document.createElement('span');
    meta.className = 'ep-supporter-meta';
    var epBadge = document.createElement('span');
    epBadge.className = 'stats-prenostr-ep';
    epBadge.textContent = row.episode_num != null
      ? 'Ep ' + parseInt(row.episode_num, 10)
      : 'Show';
    meta.appendChild(epBadge);
    var sats = document.createElement('span');
    sats.className = 'ep-supporter-sats';
    sats.textContent = fmtSats(row.total_sats) + ' sats';
    meta.appendChild(sats);
    if (row.app) {
      var app = document.createElement('span');
      app.className = 'ep-supporter-app';
      app.textContent = row.app;
      meta.appendChild(app);
    }

    head.appendChild(ident);
    head.appendChild(meta);
    li.appendChild(head);

    var msg = cleanMessage(row.message);
    if (msg) {
      var p = document.createElement('p');
      p.className = 'ep-supporter-msg';
      p.textContent = msg;
      li.appendChild(p);
    }
    return { li: li, npubEl: npubEl };
  }

  // Strip Fountain's auto-appended episode link / bare nevent lines and
  // the "*no comment with boost*" sentinel; normalise the ledger's
  // literal "\n" sequences to real newlines. (Mirrors ep-sats.js.)
  function cleanMessage(raw) {
    if (!raw) return '';
    if (raw.trim() === '*no comment with boost*') return '';
    var lines = raw.replace(/\\r\\n|\\n|\\r/g, '\n').split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) {
        if (!l) return false;
        if (/^https:\/\/fountain\.fm\/\S*$/i.test(l)) return false;
        if (/^nostr:[a-z0-9]+$/i.test(l)) return false;
        return true;
      });
    return lines.join('\n')
      .replace(/nostr:((?:npub1|nprofile1)[a-z0-9]+)/gi, function (whole, id) {
        return '@' + id.slice(0, 12) + '…';
      })
      .replace(/nostr:(?:note1|nevent1|naddr1)[a-z0-9]+/gi, '[note]');
  }

  // ── Shoutout to the Streamers — all-time totals per supporter ──────
  // Aggregates every stream row across every episode by identity (npub
  // > display name > each truly-anon row its own). Hosts excluded for
  // the same reason as the supporter leaderboard. Sorted largest-first
  // and rendered as the same mini-cards the episode pages use.
  function renderStreamerShoutout(rows) {
    if (!streamersCanvas) return;

    var byId = Object.create(null);
    var anonIdx = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.kind !== 'stream') continue;
      if (row.sender_npub && HOST_NPUBS[row.sender_npub]) continue;
      var npub = row.sender_npub || '';
      var key = npub || row.sender_name || ('__anon__' + (anonIdx++));
      var rec = byId[key] || (byId[key] = {
        npub: npub,
        label: row.sender_name || (npub ? shortNpub(npub) : 'Anonymous'),
        sats: 0,
        appBySats: Object.create(null),
      });
      rec.sats += row.total_sats;
      if (row.app) rec.appBySats[row.app] = (rec.appBySats[row.app] || 0) + row.total_sats;
    }

    var streamers = [];
    for (var k in byId) {
      var s = byId[k];
      // Pick the supporter's most-used app (by sats) as the badge.
      var topApp = '', topAppSats = 0;
      for (var a in s.appBySats) {
        if (s.appBySats[a] > topAppSats) { topAppSats = s.appBySats[a]; topApp = a; }
      }
      s.app = topApp;
      streamers.push(s);
    }
    if (!streamers.length) {
      streamersCanvas.innerHTML = '<p class="stats-error">No streams yet.</p>';
      return;
    }
    streamers.sort(function (a, b) { return b.sats - a.sats; });
    streamers = streamers.slice(0, 10);   // shoutout shows the top 10 only

    // Sync pre-resolve from cache so the first paint already shows
    // names + avatars for known supporters.
    var preNpubsSO = [];
    for (var sn = 0; sn < streamers.length; sn++) {
      if (streamers[sn].npub) preNpubsSO.push(streamers[sn].npub);
    }
    var cachedSO = syncCachedProfiles(preNpubsSO);

    var list = document.createElement('ul');
    list.className = 'ep-supporter-list';
    var npubEls = [];
    for (var j = 0; j < streamers.length; j++) {
      var built = buildShoutoutRow(streamers[j], cachedSO);
      list.appendChild(built.li);
      if (built.npubEl) npubEls.push(built.npubEl);
    }
    streamersCanvas.innerHTML = '';
    streamersCanvas.appendChild(list);

    // Resolve npub → display name + avatar via the shared relay helper.
    var npubs = [], seen = Object.create(null);
    for (var n = 0; n < npubEls.length; n++) {
      if (!seen[npubEls[n].npub]) {
        seen[npubEls[n].npub] = 1;
        npubs.push(npubEls[n].npub);
      }
    }
    if (npubs.length && window.LBEpisodeEnhance &&
        typeof window.LBEpisodeEnhance.fetchProfilesByNpub === 'function') {
      window.LBEpisodeEnhance.fetchProfilesByNpub(npubs).then(function (profiles) {
        for (var m = 0; m < npubEls.length; m++) {
          var prof = profiles[npubEls[m].npub];
          if (!prof) continue;
          if (prof.name) {
            npubEls[m].nameEl.textContent = prof.name;
            if (npubEls[m].linked && npubEls[m].identEl) {
              npubEls[m].identEl.title = 'View ' + prof.name + ' on OnlyBoosts';
              npubEls[m].identEl.setAttribute('aria-label', 'View ' + prof.name + ' on OnlyBoosts');
            }
          }
          if (prof.picture) {
            npubEls[m].avatarEl.style.backgroundImage =
              'url("' + prof.picture.replace(/"/g, '%22') + '")';
          }
        }
      }).catch(function () {});
    }
  }

  function buildShoutoutRow(s, cached) {
    var li = document.createElement('li');
    li.className = 'ep-supporter-row';

    var head = document.createElement('div');
    head.className = 'ep-supporter-head';

    var ident = document.createElement('span');
    ident.className = 'ep-supporter-identity';
    var avatar = document.createElement('span');
    avatar.className = 'ep-supporter-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.className = 'ep-supporter-name';
    var cEntry = cached && s.npub && cached[s.npub];
    name.textContent = (cEntry && cEntry.name) ? cEntry.name : s.label;
    if (cEntry && cEntry.picture) {
      avatar.style.backgroundImage =
        'url("' + cEntry.picture.replace(/"/g, '%22') + '")';
    }
    ident.appendChild(avatar);
    ident.appendChild(name);

    var npubEl = null;
    if (s.npub) {
      ident.setAttribute('data-npub', s.npub);
      npubEl = { npub: s.npub, nameEl: name, avatarEl: avatar, identEl: ident };
      npubEl.linked = wireIdentity(ident, avatar, s.npub, name.textContent);
    }

    var meta = document.createElement('span');
    meta.className = 'ep-supporter-meta';
    var sats = document.createElement('span');
    sats.className = 'ep-supporter-sats';
    sats.textContent = fmtSats(s.sats) + ' sats';
    meta.appendChild(sats);
    if (s.app) {
      var app = document.createElement('span');
      app.className = 'ep-supporter-app';
      app.textContent = s.app;
      meta.appendChild(app);
    }

    head.appendChild(ident);
    head.appendChild(meta);
    li.appendChild(head);
    return { li: li, npubEl: npubEl };
  }

  // ── Top Zappers — all-time totals per zap-sender ───────────────────
  // Filters sats.json rows by source === 'zap', aggregates total_sats per
  // sender_npub, sorts largest-first and renders the same compact mini-cards
  // the streamers shoutout uses. Hosts left in deliberately — zaps from hosts
  // go to the ad budget, not back to themselves.
  function renderTopZappers(allRows) {
    if (!zappersCanvas) return;

    var byId = Object.create(null);
    var anonIdx = 0;
    for (var i = 0; i < allRows.length; i++) {
      var row = allRows[i];
      if (row.source !== 'zap') continue;
      if (typeof row.total_sats !== 'number' || row.total_sats <= 0) continue;
      var npub = row.sender_npub || '';
      var key = npub || ('__anon__' + (anonIdx++));
      var rec = byId[key] || (byId[key] = {
        npub: npub,
        label: row.sender_name || (npub ? shortNpub(npub) : 'Anonymous'),
        sats: 0,
      });
      rec.sats += row.total_sats;
    }

    var zappers = [];
    for (var k in byId) zappers.push(byId[k]);
    if (!zappers.length) {
      zappersCanvas.innerHTML = '<p class="stats-error">No zaps yet.</p>';
      return;
    }
    zappers.sort(function (a, b) { return b.sats - a.sats; });
    zappers = zappers.slice(0, 10);

    // Sync pre-resolve from cache so cached zappers render with names
    // on the first paint instead of a truncated-npub flash.
    var preNpubsZ = [];
    for (var z = 0; z < zappers.length; z++) {
      if (zappers[z].npub) preNpubsZ.push(zappers[z].npub);
    }
    var cachedZ = syncCachedProfiles(preNpubsZ);

    var list = document.createElement('ul');
    list.className = 'ep-supporter-list';
    var npubEls = [];
    for (var j = 0; j < zappers.length; j++) {
      // buildShoutoutRow skips the app badge when s.app is falsy.
      var built = buildShoutoutRow(zappers[j], cachedZ);
      list.appendChild(built.li);
      if (built.npubEl) npubEls.push(built.npubEl);
    }
    zappersCanvas.innerHTML = '';
    zappersCanvas.appendChild(list);

    // Async resolve the rest via the shared relay helper.
    var npubs = [], seen = Object.create(null);
    for (var n = 0; n < npubEls.length; n++) {
      if (!seen[npubEls[n].npub]) {
        seen[npubEls[n].npub] = 1;
        npubs.push(npubEls[n].npub);
      }
    }
    if (npubs.length && window.LBEpisodeEnhance &&
        typeof window.LBEpisodeEnhance.fetchProfilesByNpub === 'function') {
      window.LBEpisodeEnhance.fetchProfilesByNpub(npubs).then(function (profiles) {
        for (var m = 0; m < npubEls.length; m++) {
          var prof = profiles[npubEls[m].npub];
          if (!prof) continue;
          if (prof.name) {
            npubEls[m].nameEl.textContent = prof.name;
            if (npubEls[m].linked && npubEls[m].identEl) {
              npubEls[m].identEl.title = 'View ' + prof.name + ' on OnlyBoosts';
              npubEls[m].identEl.setAttribute('aria-label', 'View ' + prof.name + ' on OnlyBoosts');
            }
          }
          if (prof.picture) {
            npubEls[m].avatarEl.style.backgroundImage =
              'url("' + prof.picture.replace(/"/g, '%22') + '")';
          }
        }
      }).catch(function () {});
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function fmtDate(ms) {
    try {
      return new Date(ms).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      });
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function epHref(num) {
    return '/ep' + String(num).padStart(3, '0');
  }

  // Make a person's identity chip (avatar + name) act like every other
  // person on the site: opens their OnlyBoosts page in a new tab if they
  // have one (blue dot on the avatar), otherwise copies their npub.
  // Returns true when linked. Keyboard-reachable either way.
  function wireIdentity(ident, avatar, npub, name) {
    ident.classList.add('is-clickable');
    ident.setAttribute('role', 'button');
    ident.setAttribute('tabindex', '0');
    ident.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ident.click(); }
    });
    var ob = window.LBOnlyBoosts || null;
    var linked = false;
    if (ob && typeof ob.wireBoosterAction === 'function') {
      linked = ob.wireBoosterAction(ident, {
        id: npub, name: name, avatar: avatar,
        onCopy: function () { copyNpub(npub); },
      });
    } else {
      ident.addEventListener('click', function () { copyNpub(npub); });
    }
    if (!linked) {
      ident.title = 'Copy npub';
      ident.setAttribute('aria-label', 'Copy npub for ' + (name || 'this supporter'));
    }
    return linked;
  }

  // ── Copy-to-clipboard + toast (mirrors supporters.js) ──────────────
  // execCommand fallback for when navigator.clipboard is unavailable or
  // rejected (e.g. Firefox on Android gates the async clipboard). The
  // textarea must be ON-SCREEN with real size, and we honour the actual
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
    if (!npub) return;
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
      toastEl.className = 'stats-toast';
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

  function xmlEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shortNpub(npub) {
    return npub.length > 20 ? npub.slice(0, 12) + '…' + npub.slice(-6) : npub;
  }

  // Sync read of the localStorage profile cache populated by
  // episode-enhance.js. Used to fill in display names + avatars BEFORE
  // the initial paint, so cached supporters never flash as truncated
  // npubs (the supporter leaderboard's full SVG re-render in particular
  // made that flash painfully obvious).
  function syncCachedProfiles(npubs) {
    if (!npubs || !npubs.length) return Object.create(null);
    if (!window.LBEpisodeEnhance ||
        typeof window.LBEpisodeEnhance.getCachedProfilesByNpub !== 'function') {
      return Object.create(null);
    }
    return window.LBEpisodeEnhance.getCachedProfilesByNpub(npubs);
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).replace(/\s+$/, '') + '…' : s;
  }

  function svgEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Round up to a clean axis bound (1/2/5 * 10^n).
  function niceCeil(n) {
    if (n <= 10) return Math.ceil(n);
    var mag = Math.pow(10, Math.floor(Math.log(n) / Math.LN10));
    var norm = n / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function fmtSats(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
})();
