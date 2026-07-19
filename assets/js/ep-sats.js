/* Episode page — sats data sections, all fed by /data/sats.json.
 *
 * 1. Sats-over-time chart: inline-SVG line chart of sats received vs.
 *    days since publication, with a Daily / Cumulative radio toggle.
 *    Boosts and streams both count; X axis fits the episode's age,
 *    capped at 100 days.
 *
 * 2. "Streams on this episode": a simplified listing of who streamed
 *    sats to the episode and how much. Fountain stream rows are
 *    lifetime per-supporter aggregates — one row per person.
 *
 * 3. "Pre-Nostr Boosts Received": boosts that landed before the boost
 *    bot started publishing kind-1 notes (see PRE_NOSTR_CUTOFF) — so
 *    they exist in the ledger but never made it into the Nostr thread.
 *
 * Listings (2) and (3) share the same mini-card shape; npubs are
 * resolved to display names + avatars via episode-enhance.js's shared
 * relay machinery.
 *
 * Zero dependencies. Failure is silent: each section stays hidden if
 * its data can't be loaded or the episode has nothing to show.
 */
(function () {
  'use strict';

  var SATS_URL = '/api/sats';
  var MAX_DAYS = 100;
  var DAY_MS = 86400000;

  // Timestamp of the boost bot's first kind-1 note. Boosts settled
  // before this were never published to Nostr — they live only in the
  // ledger, and surface in the "Pre-Nostr Boosts Received" section.
  var PRE_NOSTR_CUTOFF_MS = Date.parse('2026-03-24T02:23:29Z');

  var epData = readEpData();
  if (!epData || !epData.episode || epData.episode.number == null) return;
  var epNum = epData.episode.number;
  // pubDate drives the chart's X axis only; the listings don't need it,
  // so a missing pubDate just disables the chart.
  var pubMs = epData.episode.pubDate != null
    ? Date.parse(epData.episode.pubDate) : NaN;

  var chartCard = document.querySelector('[data-ep-chart]');

  function readEpData() {
    var el = document.getElementById('lb-ep-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || ''); } catch (e) { return null; }
  }

  fetch(SATS_URL)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (doc) {
      if (!doc || !Array.isArray(doc.rows)) return;
      var rows = doc.rows.filter(function (row) {
        return row.episode_num != null &&
          parseInt(row.episode_num, 10) === epNum &&
          typeof row.total_sats === 'number' && row.total_sats > 0;
      });
      if (!rows.length) return;
      if (chartCard && isFinite(pubMs)) renderChart(rows);
      // Both listings resolve npubs the same way — collect across both
      // and enhance once so we don't open duplicate relay connections.
      var npubEls = [].concat(renderStreams(rows), renderPreNostr(rows));
      enhanceSupporterNpubs(npubEls);
    })
    .catch(function () {});

  // ── Chart ─────────────────────────────────────────────────────────
  function renderChart(rows) {
    // Bucket sats by whole-day offset from publication.
    var byDay = Object.create(null);
    var maxDayWithData = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = Date.parse(rows[i].settled_at);
      if (!isFinite(t)) continue;
      var day = Math.floor((t - pubMs) / DAY_MS);
      if (day < 0) day = 0;          // settled at/before publish — clamp to day 0
      if (day > MAX_DAYS) continue;  // past the 100-day cap — drop
      byDay[day] = (byDay[day] || 0) + rows[i].total_sats;
      if (day > maxDayWithData) maxDayWithData = day;
    }

    // X axis fits the episode's age, capped at 100. Never clip a real
    // data point, and always span at least one day so the plot isn't
    // degenerate for a same-day episode.
    var daysSincePub = Math.floor((Date.now() - pubMs) / DAY_MS);
    var axisMax = Math.max(1, Math.min(MAX_DAYS, daysSincePub), maxDayWithData);

    var daily = [], cumulative = [], run = 0;
    for (var d = 0; d <= axisMax; d++) {
      var v = byDay[d] || 0;
      run += v;
      daily.push(v);
      cumulative.push(run);
    }

    chartCard.innerHTML =
      '<h2 class="ep-chart-heading">Sats over time</h2>' +
      '<p class="ep-chart-sub">Total: ' + fmtSats(run) + ' sats</p>' +
      '<div class="ep-chart-controls" role="radiogroup" aria-label="Chart view">' +
        '<label class="ep-chart-opt"><input type="radio" name="ep-chart-view" value="daily" checked> Daily</label>' +
        '<label class="ep-chart-opt"><input type="radio" name="ep-chart-view" value="cumulative"> Cumulative</label>' +
      '</div>' +
      '<div class="ep-chart-canvas"></div>';

    var canvas = chartCard.querySelector('.ep-chart-canvas');
    function draw(view) {
      canvas.innerHTML = buildSvg(view === 'cumulative' ? cumulative : daily, axisMax, view);
    }
    draw('daily');

    var radios = chartCard.querySelectorAll('input[name="ep-chart-view"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (e) {
        if (e.target.checked) draw(e.target.value);
      });
    }

    chartCard.removeAttribute('hidden');
  }

  // ── Inline-SVG chart renderer ─────────────────────────────────────
  function buildSvg(series, axisMax, view) {
    var W = 720, H = 280;
    var mL = 54, mR = 16, mT = 16, mB = 38;
    var pw = W - mL - mR, ph = H - mT - mB;

    var yMax = 0;
    for (var i = 0; i < series.length; i++) if (series[i] > yMax) yMax = series[i];
    yMax = niceCeil(yMax > 0 ? yMax : 1);

    function x(day) { return mL + (day / axisMax) * pw; }
    function y(val) { return mT + ph - (val / yMax) * ph; }

    var parts = [];

    // Horizontal gridlines + Y labels at 0 / 50% / 100%.
    var ySteps = [0, 0.5, 1];
    for (var s = 0; s < ySteps.length; s++) {
      var yv = yMax * ySteps[s];
      var yy = y(yv);
      parts.push('<line class="ep-chart-grid" x1="' + mL + '" y1="' + yy +
        '" x2="' + (W - mR) + '" y2="' + yy + '"/>');
      parts.push('<text class="ep-chart-ylabel" x="' + (mL - 8) + '" y="' +
        (yy + 4) + '">' + fmtSats(Math.round(yv)) + '</text>');
    }

    // X tick labels — up to ~5 evenly spaced integer days.
    var tickCount = Math.min(axisMax, 5);
    var seen = Object.create(null);
    for (var ti = 0; ti <= tickCount; ti++) {
      var day = Math.round((ti / Math.max(tickCount, 1)) * axisMax);
      if (seen[day]) continue;
      seen[day] = 1;
      parts.push('<text class="ep-chart-xlabel" x="' + x(day) + '" y="' +
        (H - mB + 20) + '">' + day + '</text>');
    }
    parts.push('<text class="ep-chart-axis-title" x="' + (mL + pw / 2) +
      '" y="' + (H - 4) + '">Days since publication</text>');

    // Area fill + line through every day-offset.
    var pts = [];
    for (var d = 0; d < series.length; d++) pts.push(x(d) + ',' + y(series[d]));
    var areaD = 'M' + x(0) + ',' + y(0) + ' L' + pts.join(' L') +
      ' L' + x(series.length - 1) + ',' + y(0) + ' Z';
    parts.push('<path class="ep-chart-area" d="' + areaD + '"/>');
    parts.push('<polyline class="ep-chart-line" points="' + pts.join(' ') + '"/>');

    // Dots: every point on the cumulative curve; only non-zero days on
    // the daily view (a dot on every zero-day would just be noise).
    for (var dd = 0; dd < series.length; dd++) {
      if (view === 'daily' && series[dd] === 0) continue;
      parts.push('<circle class="ep-chart-dot" cx="' + x(dd) + '" cy="' +
        y(series[dd]) + '" r="3"><title>Day ' + dd + ': ' +
        fmtSats(series[dd]) + ' sats</title></circle>');
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ep-chart-svg" ' +
      'role="img" preserveAspectRatio="xMidYMid meet" ' +
      'aria-label="Sats received per day since publication">' +
      parts.join('') + '</svg>';
  }

  // ── Supporter listings (streams + pre-Nostr boosts) ───────────────
  // Both render the same mini-card shape: avatar + name, sats, app
  // badge, and (boosts only) a cleaned message line. Each render fn
  // returns the npub elements it created so the caller can resolve
  // profiles in a single batch.

  function renderStreams(rows) {
    var section = document.querySelector('[data-ep-streams]');
    if (!section) return [];
    var streams = rows.filter(function (row) { return row.kind === 'stream'; });
    if (!streams.length) return [];
    // Lifetime per-supporter aggregates — order by who streamed most.
    streams.sort(function (a, b) { return b.total_sats - a.total_sats; });
    var total = 0;
    for (var i = 0; i < streams.length; i++) total += streams[i].total_sats;
    var sub = 'Streamed by ' + streams.length + ' supporter' +
      (streams.length === 1 ? '' : 's') + ' · ' + fmtSats(total) + ' sats';
    return fillSupporterSection(section, 'Streams on this episode', sub, streams, false);
  }

  function renderPreNostr(rows) {
    var section = document.querySelector('[data-ep-prenostr]');
    if (!section) return [];
    var boosts = rows.filter(function (row) {
      if (row.kind !== 'boost') return false;  // streams have their own section
      var t = Date.parse(row.settled_at);
      return isFinite(t) && t < PRE_NOSTR_CUTOFF_MS;
    });
    if (!boosts.length) return [];
    boosts.sort(function (a, b) {
      return (Date.parse(b.settled_at) || 0) - (Date.parse(a.settled_at) || 0);
    });
    var total = 0;
    for (var i = 0; i < boosts.length; i++) total += boosts[i].total_sats;
    var sub = boosts.length + ' boost' + (boosts.length === 1 ? '' : 's') +
      ' · ' + fmtSats(total) + ' sats · received before this show published boosts to Nostr';
    return fillSupporterSection(section, 'Pre-Nostr Boosts Received', sub, boosts, true);
  }

  // Builds heading + sub + mini-card list into `section` and reveals it.
  // `withMessage` controls whether each row renders a cleaned message
  // line. Returns the created npub elements for batched enhancement.
  function fillSupporterSection(section, headingText, subText, items, withMessage) {
    var heading = document.createElement('h2');
    heading.className = 'ep-supporter-heading';
    heading.textContent = headingText;

    var sub = document.createElement('p');
    sub.className = 'ep-supporter-sub';
    sub.textContent = subText;

    // Sync pre-resolve from the localStorage profile cache so cached
    // supporters render with their display name + avatar on the first
    // paint. The async enhanceSupporterNpubs below then only updates
    // the few cache misses.
    var preNpubs = [];
    for (var ii = 0; ii < items.length; ii++) {
      if (items[ii].sender_npub) preNpubs.push(items[ii].sender_npub);
    }
    var preCached = (window.LBEpisodeEnhance &&
      typeof window.LBEpisodeEnhance.getCachedProfilesByNpub === 'function')
      ? window.LBEpisodeEnhance.getCachedProfilesByNpub(preNpubs)
      : Object.create(null);

    var list = document.createElement('ul');
    list.className = 'ep-supporter-list';

    var npubEls = [];
    for (var i = 0; i < items.length; i++) {
      var built = buildSupporterRow(items[i], withMessage, preCached);
      list.appendChild(built.li);
      if (built.npubEl) npubEls.push(built.npubEl);
    }

    section.appendChild(heading);
    section.appendChild(sub);
    section.appendChild(list);
    section.removeAttribute('hidden');

    return npubEls;
  }

  function buildSupporterRow(row, withMessage, cached) {
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
    if (cEntry && cEntry.name) {
      name.textContent = cEntry.name;
    } else if (row.sender_name) {
      name.textContent = row.sender_name;
    } else if (row.sender_npub) {
      name.textContent = shortNpub(row.sender_npub);
    } else {
      name.textContent = 'Anonymous';
    }
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

    if (withMessage) {
      var msg = cleanMessage(row.message);
      if (msg) {
        var p = document.createElement('p');
        p.className = 'ep-supporter-msg';
        p.textContent = msg;
        li.appendChild(p);
      }
    }

    return { li: li, npubEl: npubEl };
  }

  // Resolve npub → display name + avatar via episode-enhance.js's shared
  // relay machinery. Degrades silently to the npub fallback if the
  // enhancer isn't available or a profile can't be found.
  function enhanceSupporterNpubs(npubEls) {
    if (!npubEls.length) return;
    if (!window.LBEpisodeEnhance ||
        typeof window.LBEpisodeEnhance.fetchProfilesByNpub !== 'function') return;
    var uniqueNpubs = [];
    var seen = Object.create(null);
    for (var i = 0; i < npubEls.length; i++) {
      if (!seen[npubEls[i].npub]) {
        seen[npubEls[i].npub] = 1;
        uniqueNpubs.push(npubEls[i].npub);
      }
    }
    window.LBEpisodeEnhance.fetchProfilesByNpub(uniqueNpubs)
      .then(function (profiles) {
        for (var i = 0; i < npubEls.length; i++) {
          var entry = profiles[npubEls[i].npub];
          if (!entry) continue;
          if (entry.name) npubEls[i].nameEl.textContent = entry.name;
          if (entry.picture) {
            npubEls[i].avatarEl.style.backgroundImage =
              'url("' + entry.picture.replace(/"/g, '%22') + '")';
          }
        }
      })
      .catch(function () {});
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function shortNpub(npub) {
    return npub.length > 20 ? npub.slice(0, 12) + '…' + npub.slice(-6) : npub;
  }

  // Boost messages from Fountain often carry an auto-appended episode
  // link and/or a bare nevent on their own lines, and "*no comment with
  // boost*" is the ledger's sentinel for an empty message. Strip that
  // noise so the listing shows just what the booster actually wrote.
  function cleanMessage(raw) {
    if (!raw) return '';
    if (raw.trim() === '*no comment with boost*') return '';
    // The ledger stores line breaks as literal "\n" two-char sequences,
    // not real newlines — normalise before splitting on lines.
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
