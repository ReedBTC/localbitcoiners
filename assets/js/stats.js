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

  var SATS_URL = '/data/sats.json';
  var RSS_URL = '/api/rss';
  var ZAPS_URL = '/data/zaps.json';
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
    { ms: Date.parse('2026-02-02T00:00:00Z'), dollars: 60, sats: 78027 }, // initial setup
    { ms: Date.parse('2026-03-02T00:00:00Z'), dollars: 49, sats: 74500 },
    { ms: Date.parse('2026-04-02T00:00:00Z'), dollars: 49, sats: 71940 },
    { ms: Date.parse('2026-05-02T00:00:00Z'), dollars: 49, sats: 62633 },
    { ms: Date.parse('2026-06-01T00:00:00Z'), dollars: 49, sats: 66599 },
  ];

  var canvas = document.querySelector('[data-stats-canvas]');
  var subEl = document.querySelector('[data-stats-sub]');
  var boardCanvas = document.querySelector('[data-stats-leaderboard]');
  var boardSubEl = document.querySelector('[data-board-sub]');
  var peopleCanvas = document.querySelector('[data-stats-people]');
  var peopleSubEl = document.querySelector('[data-people-sub]');
  var preNostrCanvas = document.querySelector('[data-stats-prenostr]');
  var streamersCanvas = document.querySelector('[data-stats-streamers]');
  var zappersCanvas = document.querySelector('[data-stats-zappers]');
  var appmixCanvas = document.querySelector('[data-stats-appmix]');
  var appmixSubEl = document.querySelector('[data-appmix-sub]');
  var appmixLegendEl = document.querySelector('[data-appmix-legend]');
  if (!canvas && !boardCanvas && !peopleCanvas && !preNostrCanvas &&
      !streamersCanvas && !zappersCanvas && !appmixCanvas) return;

  Promise.all([
    fetch(SATS_URL).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
    fetch(RSS_URL).then(function (r) { return r.ok ? r.text() : null; })
      .catch(function () { return null; }),
    fetch(ZAPS_URL).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }),
  ]).then(function (results) {
    var doc = results[0];
    var rssXml = results[1];
    var zapsDoc = results[2];
    if (!doc || !Array.isArray(doc.rows)) { showError(); return; }
    var rows = doc.rows.filter(function (row) {
      return typeof row.total_sats === 'number' && row.total_sats > 0 &&
        isFinite(Date.parse(row.settled_at));
    });
    if (!rows.length) { showError(); return; }
    var zaps = (zapsDoc && Array.isArray(zapsDoc.rows)) ? zapsDoc.rows : [];
    render(rows, rssXml ? parseEpisodes(rssXml) : []);
    renderAppMix(rows);
    renderLeaderboard(rows);
    renderIdentityBoard(rows);
    renderStreamerShoutout(rows);
    renderTopZappers(zaps);
    renderBigPreNostr(rows);
  });

  function showError() {
    var msg = '<p class="stats-error">Couldn\'t load sats data right now — try again later.</p>';
    if (canvas) canvas.innerHTML = msg;
    if (boardCanvas) boardCanvas.innerHTML = msg;
    if (peopleCanvas) peopleCanvas.innerHTML = msg;
    if (preNostrCanvas) preNostrCanvas.innerHTML = msg;
    if (streamersCanvas) streamersCanvas.innerHTML = msg;
    if (zappersCanvas) zappersCanvas.innerHTML = msg;
    if (appmixCanvas) appmixCanvas.innerHTML = msg;
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

  // ── Sats-over-time chart ───────────────────────────────────────────
  function render(rows, episodes) {
    if (!canvas) return;
    // Bucket every row's total_sats by UTC calendar day, plus the same
    // breakdown into the 5 recipient buckets so the cumulative view can
    // render them as stacked bands. Bucket sums equal total_sats on
    // every row (other-agent guarantee), so the stack's top edge tracks
    // the cumulative total line exactly.
    var byDay = Object.create(null);
    var byDayBuckets = Object.create(null);
    var byDayApps = Object.create(null);   // dayMs -> { appName: sats }
    var seenApps = Object.create(null);
    var minMs = Infinity, maxMs = -Infinity;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var dayMs = Math.floor(Date.parse(row.settled_at) / DAY_MS) * DAY_MS;
      byDay[dayMs] = (byDay[dayMs] || 0) + row.total_sats;
      var bkt = byDayBuckets[dayMs] || (byDayBuckets[dayMs] =
        { reed: 0, rev: 0, guests: 0, aquafox: 0, fountain: 0 });
      bkt.reed     += row.reed_sats     || 0;
      bkt.rev      += row.rev_sats      || 0;
      bkt.guests   += row.guests_sats   || 0;
      bkt.aquafox  += row.aquafox_sats  || 0;
      bkt.fountain += row.fountain_sats || 0;
      var app = row.app || 'Other';
      seenApps[app] = true;
      var appBkt = byDayApps[dayMs] || (byDayApps[dayMs] = Object.create(null));
      appBkt[app] = (appBkt[app] || 0) + row.total_sats;
      if (dayMs < minMs) minMs = dayMs;
      if (dayMs > maxMs) maxMs = dayMs;
    }
    // Stretch the axis to cover every episode release too — episode 1
    // published a day before its first boost, so without this its
    // marker would fall off the left edge of the chart.
    for (var ei = 0; ei < episodes.length; ei++) {
      var epDay = Math.floor(episodes[ei].pubMs / DAY_MS) * DAY_MS;
      if (epDay < minMs) minMs = epDay;
      if (epDay > maxMs) maxMs = epDay;
    }
    // Extend the axis to today so the timeline reads as current.
    var todayMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    if (todayMs > maxMs) maxMs = todayMs;

    // Daily + cumulative series across every day in [minMs, maxMs],
    // including each recipient bucket's running cumulative. Reed and
    // Rev each eat half of the running operating cost from their bucket
    // before anything counts as "profit"; the Costs band shows the sats
    // actually consumed (capped by what each host has been paid). The
    // sum of all six bands at every day still equals `cumulative`.
    var days = [];
    var run = 0;
    var rReedRaw = 0, rRevRaw = 0, rGuests = 0, rAquafox = 0, rFountain = 0;
    var costIdx = 0, cumCostSats = 0;
    var rApps = Object.create(null);  // running per-app cumulative
    for (var d = minMs; d <= maxMs; d += DAY_MS) {
      var v = byDay[d] || 0;
      run += v;
      var bktD = byDayBuckets[d];
      if (bktD) {
        rReedRaw  += bktD.reed;
        rRevRaw   += bktD.rev;
        rGuests   += bktD.guests;
        rAquafox  += bktD.aquafox;
        rFountain += bktD.fountain;
      }
      var appBktD = byDayApps[d];
      if (appBktD) {
        for (var aname in appBktD) {
          rApps[aname] = (rApps[aname] || 0) + appBktD[aname];
        }
      }
      // Step costs forward through any bills whose date is now reached.
      while (costIdx < COSTS.length && COSTS[costIdx].ms <= d) {
        cumCostSats += COSTS[costIdx].sats;
        costIdx++;
      }
      var costShare = cumCostSats / 2;
      var reedNet = Math.max(0, rReedRaw - costShare);
      var revNet  = Math.max(0, rRevRaw - costShare);
      var costsActual = Math.min(rReedRaw, costShare) + Math.min(rRevRaw, costShare);
      // Snapshot the running per-app cumulative for the apps view.
      var appsSnap = Object.create(null);
      for (var sName in seenApps) appsSnap[sName] = rApps[sName] || 0;
      days.push({
        ms: d, daily: v, cumulative: run,
        reed: reedNet, rev: revNet, costs: costsActual,
        guests: rGuests, aquafox: rAquafox, fountain: rFountain,
        apps: appsSnap,
      });
    }
    var grandTotal = run;

    if (subEl) {
      subEl.textContent = fmtSats(grandTotal) + ' sats received' +
        (episodes.length ? ' across ' + episodes.length + ' episodes' : '') +
        ' since ' + fmtDate(minMs);
    }

    var legendEl = document.querySelector('[data-stats-legend]');
    var legendAppsEl = document.querySelector('[data-stats-legend-apps]');
    function draw(view) {
      canvas.innerHTML = buildSvg(days, episodes, view, minMs, maxMs);
      // Show the matching legend per view; both hidden on daily.
      if (legendEl) {
        if (view === 'splits') legendEl.removeAttribute('hidden');
        else legendEl.setAttribute('hidden', '');
      }
      if (legendAppsEl) {
        if (view === 'apps') legendAppsEl.removeAttribute('hidden');
        else legendAppsEl.setAttribute('hidden', '');
      }
    }
    draw('splits');

    var radios = document.querySelectorAll('input[name="stats-chart-view"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (e) {
        if (e.target.checked) draw(e.target.value);
      });
    }

    setupChartTooltip(canvas);
  }

  // ── Inline-SVG chart renderer ──────────────────────────────────────
  function buildSvg(days, episodes, view, minMs, maxMs) {
    var W = 960, H = 360;
    var mL = 64, mR = 20, mT = 30, mB = 44;
    var pw = W - mL - mR, ph = H - mT - mB;
    var spanMs = Math.max(maxMs - minMs, DAY_MS);
    // Both stacked views (splits + apps) sum to the cumulative line, so
    // they share its y-axis; daily has its own (smaller) per-day max.
    var key = view === 'daily' ? 'daily' : 'cumulative';

    var yMax = 0;
    for (var i = 0; i < days.length; i++) if (days[i][key] > yMax) yMax = days[i][key];
    yMax = niceCeil(yMax > 0 ? yMax : 1);

    function x(ms) { return mL + ((ms - minMs) / spanMs) * pw; }
    function y(val) { return mT + ph - (val / yMax) * ph; }

    var parts = [];

    // Horizontal gridlines + Y labels at 0 / 25 / 50 / 75 / 100%.
    var ySteps = [0, 0.25, 0.5, 0.75, 1];
    for (var s = 0; s < ySteps.length; s++) {
      var yv = yMax * ySteps[s];
      var yy = y(yv);
      parts.push('<line class="stats-chart-grid" x1="' + mL + '" y1="' + yy +
        '" x2="' + (W - mR) + '" y2="' + yy + '"/>');
      parts.push('<text class="stats-chart-ylabel" x="' + (mL - 8) + '" y="' +
        (yy + 4) + '">' + fmtSats(Math.round(yv)) + '</text>');
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

    if (view === 'splits' || view === 'apps') {
      // Stacked cumulative bands. Two flavors share the same algorithm:
      //   splits — recipient breakdown (Costs/Fountain/AdBudget/Guests/
      //            Reed/Rev), bottom-up.
      //   apps   — boost/stream source breakdown, ordered smallest at
      //            the bottom up to biggest, derived from days[].apps.
      // Each band sums into the cumulative total; the orange total line
      // draws on top for crisp definition.
      var BUCKETS;
      if (view === 'splits') {
        BUCKETS = [
          { k: 'costs',    cls: 'stats-band-costs',    label: 'Costs' },
          { k: 'fountain', cls: 'stats-band-fountain', label: 'Fountain' },
          { k: 'aquafox',  cls: 'stats-band-adbudget', label: 'V4V Budget' },
          { k: 'guests',   cls: 'stats-band-guests',   label: 'Guests' },
          { k: 'reed',     cls: 'stats-band-reed',     label: 'Reed' },
          { k: 'rev',      cls: 'stats-band-rev',      label: 'Rev' },
        ];
      } else {
        // Discover apps from the final day's snapshot. Fountain anchors
        // the bottom (it's so dominant that putting it on top buries
        // the smaller apps); the rest sort ascending by total so the
        // tiniest sliver sits just above Fountain and the biggest non-
        // Fountain app crowns the stack against the cumulative line.
        var lastApps = days[days.length - 1].apps || {};
        var appNames = Object.keys(lastApps);
        appNames.sort(function (a, b) {
          if (a === 'Fountain' && b !== 'Fountain') return -1;
          if (b === 'Fountain' && a !== 'Fountain') return 1;
          return lastApps[a] - lastApps[b];
        });
        BUCKETS = [];
        for (var an = 0; an < appNames.length; an++) {
          BUCKETS.push({
            k: '__app__' + appNames[an],   // sentinel so getter knows to look in .apps
            app: appNames[an],
            cls: appBandCls(appNames[an]),
            label: appNames[an],
          });
        }
      }

      var bottoms = new Array(days.length);
      for (var bz = 0; bz < bottoms.length; bz++) bottoms[bz] = 0;
      for (var bi = 0; bi < BUCKETS.length; bi++) {
        var bk = BUCKETS[bi];
        var bottomPath = [], topPath = [];
        for (var d2 = 0; d2 < days.length; d2++) {
          var bot = bottoms[d2];
          var add = bk.app
            ? ((days[d2].apps && days[d2].apps[bk.app]) || 0)
            : days[d2][bk.k];
          var top = bot + add;
          bottomPath.push(x(days[d2].ms) + ',' + y(bot));
          topPath.push(x(days[d2].ms) + ',' + y(top));
          bottoms[d2] = top;
        }
        var pathD = 'M' + bottomPath.join(' L') +
          ' L' + topPath.reverse().join(' L') + ' Z';
        var grand = bk.app
          ? ((days[days.length - 1].apps && days[days.length - 1].apps[bk.app]) || 0)
          : days[days.length - 1][bk.k];
        var tipText;
        if (bk.k === 'costs') {
          // Show what's been billed in dollars alongside the sat amount
          // actually consumed (the band's height).
          var totalDollars = 0;
          for (var ci = 0; ci < COSTS.length; ci++) totalDollars += COSTS[ci].dollars;
          tipText = bk.label + ' — $' + fmtSats(totalDollars) +
            ' (' + fmtSats(grand) + ' sats)';
        } else if (bk.app) {
          var grandTotal = days[days.length - 1].cumulative || 1;
          var pct = (grand / grandTotal) * 100;
          tipText = bk.label + ' — ' + fmtSats(grand) + ' sats (' + fmtPct(pct) + ')';
        } else {
          tipText = bk.label + ' — ' + fmtSats(grand) + ' sats';
        }
        parts.push('<path class="stats-chart-band ' + bk.cls + '" d="' + pathD +
          '" data-tip="' + xmlEsc(tipText) + '"></path>');
      }
      var ptsCum = [];
      for (var dc = 0; dc < days.length; dc++) {
        ptsCum.push(x(days[dc].ms) + ',' + y(days[dc].cumulative));
      }
      parts.push('<polyline class="stats-chart-line" points="' + ptsCum.join(' ') + '"/>');
    } else {
      // Daily view — single-color area + spiky line; dots are added
      // further below.
      var pts = [];
      for (var dd = 0; dd < days.length; dd++) {
        pts.push(x(days[dd].ms) + ',' + y(days[dd].daily));
      }
      var areaD = 'M' + x(days[0].ms) + ',' + y(0) + ' L' + pts.join(' L') +
        ' L' + x(days[days.length - 1].ms) + ',' + y(0) + ' Z';
      parts.push('<path class="stats-chart-area" d="' + areaD + '"/>');
      parts.push('<polyline class="stats-chart-line" points="' + pts.join(' ') + '"/>');
    }

    // Episode publish markers — a wide, faint highlight band per release
    // plus an "Ep N" label; both brighten on hover (CSS, via the <g>
    // wrapper). Bands are clamped to the plot so edge episodes don't
    // overhang the axes. Labels may crowd once there are many episodes.
    var bandW = 5;
    for (var e = 0; e < episodes.length; e++) {
      var ep = episodes[e];
      // Snap the marker to the same UTC day-bucket the sats data uses,
      // so a release lines up with that day's dot/step instead of
      // sitting hours to its right.
      var epDayMs = Math.floor(ep.pubMs / DAY_MS) * DAY_MS;
      if (epDayMs < minMs || epDayMs > maxMs) continue;
      var ex = x(epDayMs);
      var bx = Math.max(mL, ex - bandW / 2);
      var bxEnd = Math.min(mL + pw, ex + bandW / 2);
      var tip = 'Ep ' + ep.num + ' — ' + fmtDateET(ep.pubMs);
      parts.push('<g class="stats-chart-epmark" data-tip="' + xmlEsc(tip) + '">' +
        '<rect class="stats-chart-epband" x="' + bx + '" y="' + mT +
        '" width="' + (bxEnd - bx) + '" height="' + ph + '" rx="2"/>' +
        '<text class="stats-chart-eplabel" x="' + ex + '" y="' + (mT - 9) +
        '">Ep ' + ep.num + '</text></g>');
    }

    // Daily view: mark every day that actually received sats with a
    // dot, tooltipped with its date + amount.
    if (view === 'daily') {
      for (var di = 0; di < days.length; di++) {
        if (days[di].daily <= 0) continue;
        var dailyTip = fmtDate(days[di].ms) + ': ' + fmtSats(days[di].daily) + ' sats';
        parts.push('<circle class="stats-chart-dot" cx="' + x(days[di].ms) +
          '" cy="' + y(days[di].daily) + '" r="3.5" data-tip="' +
          xmlEsc(dailyTip) + '"></circle>');
      }
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stats-chart-svg" ' +
      'role="img" preserveAspectRatio="xMidYMid meet" ' +
      'aria-label="Sats received over time across the podcast">' +
      parts.join('') + '</svg>';
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
    var byWeekApp = Object.create(null);
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
      var totalW = 0;
      for (var aa in b) totalW += b[aa];
      weeks.push({ start: w, byApp: b, total: totalW });
    }

    // Order apps by all-time total sats (descending). The highest-total
    // app draws last, ending up on top in the SVG paint order.
    var appList = Object.keys(appsSeen);
    var allTime = Object.create(null);
    for (var w2 = 0; w2 < weeks.length; w2++) {
      for (var a2 in weeks[w2].byApp) {
        allTime[a2] = (allTime[a2] || 0) + weeks[w2].byApp[a2];
      }
    }
    appList.sort(function (a, b) { return allTime[b] - allTime[a]; });

    function draw(view) {
      appmixCanvas.innerHTML = buildAppMixSvg(weeks, appList, view);
      if (appmixSubEl) {
        appmixSubEl.textContent = view === 'percent'
          ? "Per-week share of sats received, by app"
          : "Per-week sats received, by app";
      }
    }
    draw('percent');

    if (appmixLegendEl) {
      appmixLegendEl.innerHTML = '';
      for (var li = 0; li < appList.length; li++) {
        var liEl = document.createElement('li');
        var sw = document.createElement('span');
        sw.className = 'stats-legend-swatch';
        sw.style.setProperty('--c', 'var(--' + appCls(appList[li]).replace(/^stats-app-/, 'app-') + ')');
        liEl.appendChild(sw);
        liEl.appendChild(document.createTextNode(' ' + appList[li]));
        appmixLegendEl.appendChild(liEl);
      }
    }

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
        var v = wk.byApp[app] || 0;
        if (view === 'percent') v = wk.total > 0 ? (v / wk.total) * 100 : 0;
        pts.push({ ms: wk.start, val: v });
      }
      seriesByApp[app] = pts;
    }

    var yMax;
    if (view === 'percent') {
      yMax = 100;
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
    var ySteps = view === 'percent' ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
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
        // Skip 0-value dots in both views — many inactive apps would
        // otherwise pile dots on top of each other along the x-axis.
        // The line still rests at zero to show the app had nothing.
        if (sp.val <= 0) continue;
        var labelTxt = view === 'percent'
          ? app2 + ' — ' + sp.val.toFixed(1) + '% (' + fmtWeekRange(sp.ms) + ')'
          : app2 + ' — ' + fmtSats(Math.round(sp.val)) + ' sats (' + fmtWeekRange(sp.ms) + ')';
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
      default:                    return 'stats-app-other';
    }
  }

  // App-band variant for the cumulative "By App" view.
  function appBandCls(app) {
    switch (app) {
      case 'Fountain':            return 'stats-band-app-fountain';
      case 'localbitcoiners.com': return 'stats-band-app-website';
      case 'PodcastGuru':         return 'stats-band-app-podguru';
      case 'CurioCaster':         return 'stats-band-app-curio';
      case 'Castamatic':          return 'stats-band-app-castamatic';
      case 'BoostMeBitch':        return 'stats-band-app-bmb';
      default:                    return 'stats-band-app-other';
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
        return { label: 'Ep ' + e.num, value: e[metric] };
      });
      boardCanvas.innerHTML = buildBarSvg(items, metric === 'sats'
        ? 'Episodes ranked by total sats received'
        : 'Episodes ranked by unique supporters');
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
        return { label: 'Ep ' + e.num, value: e.sats };
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
  // isAnon? }] array, drawn top to bottom; the left margin auto-fits the
  // longest label. Shared by the episode + supporter leaderboards.
  function buildBarSvg(items, ariaLabel) {
    var W = 720;
    var rowH = 30, barH = 18, mT = 14, mB = 14, mR = 92;
    var longest = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].label.length > longest) longest = items[i].label.length;
    }
    var mL = Math.min(Math.max(longest * 7 + 16, 58), 180);
    var H = mT + mB + items.length * rowH;
    var tw = W - mL - mR;

    var maxVal = 0;
    for (var j = 0; j < items.length; j++) {
      if (items[j].value > maxVal) maxVal = items[j].value;
    }
    if (maxVal <= 0) maxVal = 1;

    var parts = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var cy = mT + k * rowH + rowH / 2;
      var bw = Math.max((it.value / maxVal) * tw, 2);
      var cls = it.isAnon ? 'stats-bar stats-bar-anon' : 'stats-bar';
      parts.push('<text class="stats-bar-label" x="' + (mL - 8) + '" y="' +
        (cy + 4) + '">' + svgEsc(it.label) + '</text>');
      parts.push('<rect class="' + cls + '" x="' + mL + '" y="' + (cy - barH / 2) +
        '" width="' + bw + '" height="' + barH + '" rx="3"/>');
      parts.push('<text class="stats-bar-value" x="' + (mL + bw + 8) + '" y="' +
        (cy + 4) + '">' + fmtSats(it.value) + '</text>');
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="stats-bar-svg" ' +
      'role="img" preserveAspectRatio="xMidYMid meet" aria-label="' +
      svgEsc(ariaLabel) + '">' + parts.join('') + '</svg>';
  }

  // ── Supporter leaderboard — horizontal bar chart by identity ───────
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
    }

    var fieldOf = { sats: 'sats', episodes: 'episodeCount' };

    function draw(metric) {
      var field = fieldOf[metric] || 'sats';
      var sorted = people.slice()
        .sort(function (a, b) { return b[field] - a[field]; })
        .slice(0, 10);
      // The anonymous bucket is always shown, pinned to the bottom.
      if (anon) sorted = sorted.concat([anon]);
      var items = sorted.map(function (p) {
        return { label: truncate(p.label, 22), value: p[field], isAnon: p.isAnon };
      });
      peopleCanvas.innerHTML = buildBarSvg(items, metric === 'sats'
        ? 'Supporters ranked by total sats sent'
        : 'Supporters ranked by episodes supported');
      if (peopleSubEl) {
        peopleSubEl.textContent = metric === 'sats'
          ? 'Top 10 supporters by total sats sent (boosts + streams)'
          : 'Top 10 supporters by episodes supported (boosts + streams)';
      }
    }
    draw('sats');

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
          // Only re-draw if the resolved name actually differs from the
          // (possibly already-cached) current label — avoids a wasted
          // full-SVG re-render when every name was a cache hit.
          if (prof && prof.name && people[q].label !== prof.name) {
            people[q].label = prof.name;
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
          if (prof.name) npubEls[m].nameEl.textContent = prof.name;
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
          if (prof.name) npubEls[m].nameEl.textContent = prof.name;
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
      npubEl = { npub: s.npub, nameEl: name, avatarEl: avatar };
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
  // Aggregates zaps.json by sender_npub, sums sats, sorts largest-first
  // and renders the same compact mini-cards the streamers shoutout uses.
  // No app badge (zaps don't have one). Hosts left in deliberately —
  // zaps from hosts go to the ad budget, not back to themselves.
  function renderTopZappers(zapRows) {
    if (!zappersCanvas) return;

    var byId = Object.create(null);
    var anonIdx = 0;
    for (var i = 0; i < zapRows.length; i++) {
      var row = zapRows[i];
      if (typeof row.sats !== 'number' || row.sats <= 0) continue;
      var npub = row.sender_npub || '';
      var key = npub || ('__anon__' + (anonIdx++));
      var rec = byId[key] || (byId[key] = {
        npub: npub,
        label: row.sender_name || (npub ? shortNpub(npub) : 'Anonymous'),
        sats: 0,
      });
      rec.sats += row.sats;
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
          if (prof.name) npubEls[m].nameEl.textContent = prof.name;
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

  // Episode markers tooltip the publish date in the show's local time
  // (Eastern; tracks DST automatically via the IANA zone).
  function fmtDateET(ms) {
    try {
      return new Date(ms).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        timeZone: 'America/New_York',
      });
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 10);
    }
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
