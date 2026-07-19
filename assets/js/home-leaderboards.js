/* Homepage leaderboards — three live columns computed straight from
 * /data/sats.json, matching the weekly bot note definitions in
 * bots/leaderboards/local_bitcoiners_leaderboards.py:
 *
 *   1. Top Episodes   — by total sats (boost + stream), show-level excluded.
 *                       Guests pulled from the episode RSS shownotes
 *                       ([guests: …]) and resolved to names.
 *   2. Ride or Dies   — boosts only, distinct episodes boosted per person
 *                       (hosts excluded).
 *   3. Biggest Boosts — single largest boost rows (boosts only, incl. show).
 *
 * Names + avatars resolve through window.LBEpisodeEnhance (the same resolver
 * the supporters carousels use): paint from cache, then re-render once relays
 * answer. Degrades quietly on any failure.
 */
(function () {
  'use strict';

  var SATS_URL = '/api/sats';
  var RSS_CACHE_KEY = 'lb_rss_xml_v1';   // populated by the featured-episode script
  var RSS_WORKER = '/api/rss';
  var TOP_N = 5;

  // Hosts are excluded from "Ride or Dies" (matches the bot).
  var HOST_NPUBS = {
    'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s': 1, // Reed
    'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z': 1, // Rev Hodl
  };

  var MEDALS = ['🥇', '🥈', '🥉'];

  // ── helpers ──────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }
  function shortNpub(npub) {
    if (!npub || npub.length < 16) return npub || '';
    return npub.slice(0, 9) + '…' + npub.slice(-4);
  }
  function isShowLevel(r) { return r.show_level === true || r.show_level === 'true'; }
  function pad3(n) { return String(n == null ? '' : n).replace(/[^\d]/g, '').padStart(3, '0'); }
  function normalizeTitle(t) { return (t || '').replace(/^Local Bitcoiners\s*[•·]\s*/, '').trim(); }
  function cleanTitle(t) {
    return normalizeTitle(t)
      .replace(/\s*\|\s*Ep\.\s*\d+\s*$/i, '')
      .replace(/^\d{3}\.\s*/, '')
      .trim();
  }
  function epNum(r) {
    if (r.episode_num) return pad3(r.episode_num);
    var m = (r.episode_title || '').match(/Ep\.\s*(\d+)/i);
    if (m) return pad3(m[1]);
    if ((r.episode_title || '').startsWith('001.')) return '001';
    return '';
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function getRss() {
    try {
      var c = localStorage.getItem(RSS_CACHE_KEY);
      if (c && c.indexOf('<item>') >= 0) return Promise.resolve(c);
    } catch (e) {}
    return fetch(RSS_WORKER).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; });
  }

  // ── profile resolution (window.LBEpisodeEnhance) ──────────────────
  function enhance() { return window.LBEpisodeEnhance || {}; }
  function cachedProfiles(npubs) {
    var e = enhance();
    return (e.getCachedProfilesByNpub && e.getCachedProfilesByNpub(npubs)) || Object.create(null);
  }

  // ── RSS guests: map padded episode number → [npub, …] ─────────────
  function parseGuests(xml) {
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
        var titleEl = item.querySelector('title');
        var tm = (titleEl ? titleEl.textContent : '').match(/Ep\.\s*(\d+)/i);
        if (tm) num = tm[1];
      }
      if (!num) continue;
      var descEl = item.querySelector('summary') || item.querySelector('description');
      var text = descEl ? descEl.textContent : '';
      var gm = text.match(/\[guests:\s*([^\]]*)\]/i);
      if (!gm) continue;
      var npubs = gm[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (npubs.length) map[pad3(num)] = npubs;
    }
    return map;
  }

  // ── aggregations (mirror the bot) ─────────────────────────────────
  function aggEpisodes(rows) {
    var eps = Object.create(null);
    rows.forEach(function (r) {
      if (isShowLevel(r)) return;
      var eid = r.episode_id || '';
      if (!eid) return;
      var sats = parseInt(r.total_sats || 0, 10) || 0;
      if (sats <= 0) return;
      var title = normalizeTitle(r.episode_title);
      var b = eps[eid] || (eps[eid] = { eid: eid, title: title || eid, num: epNum(r), sats: 0 });
      if (title && title.length > b.title.length) b.title = title;
      if (!b.num) b.num = epNum(r);
      b.sats += sats;
    });
    return Object.keys(eps).map(function (k) { return eps[k]; })
      .sort(function (a, b) { return b.sats - a.sats; }).slice(0, TOP_N);
  }

  function aggRideOrDies(rows) {
    var by = Object.create(null);
    rows.forEach(function (r) {
      if (r.kind !== 'boost') return;
      if (isShowLevel(r)) return;
      var eid = r.episode_id || '';
      if (!eid) return;
      var npub = r.sender_npub || '';
      if (npub && HOST_NPUBS[npub]) return;
      var name = r.sender_name || '';
      var key = npub || (name ? 'name:' + name : '');
      if (!key) return;
      var rec = by[key] || (by[key] = { npub: npub || null, name: name || null, eps: Object.create(null) });
      rec.eps[eid] = 1;
      if (!rec.name && name) rec.name = name;
    });
    var people = Object.keys(by).map(function (k) {
      var rec = by[k];
      return { npub: rec.npub, name: rec.name, count: Object.keys(rec.eps).length };
    }).sort(function (a, b) { return b.count - a.count; });

    // Top THREE TIERS (distinct episode counts), ties respected — same as
    // the weekly bot note: everyone at a top-3 count is listed (so two tied
    // for 1st are both 🥇, etc.). tier = medal index (0/1/2).
    var counts = [];
    people.forEach(function (p) {
      if (counts.indexOf(p.count) === -1 && counts.length < 3) counts.push(p.count);
    });
    return people
      .filter(function (p) { return counts.indexOf(p.count) !== -1; })
      .map(function (p) { p.tier = counts.indexOf(p.count); return p; });
  }

  function aggBiggestBoosts(rows) {
    var out = [];
    rows.forEach(function (r) {
      if (r.kind !== 'boost') return;
      var sats = parseInt(r.total_sats || 0, 10) || 0;
      if (sats <= 0) return;
      out.push({
        npub: r.sender_npub || null,
        name: r.sender_name || null,
        sats: sats,
        showLevel: isShowLevel(r),
        num: epNum(r),
        title: r.episode_title || '',
        message: (r.message || '').trim(),
      });
    });
    return out.sort(function (a, b) { return b.sats - a.sats; }).slice(0, TOP_N);
  }

  // ── rendering ─────────────────────────────────────────────────────
  function rankCell(i) {
    var span = document.createElement('span');
    span.className = 'lb-rank' + (i < 3 ? ' is-medal' : '');
    span.textContent = i < 3 ? MEDALS[i] : String(i + 1);
    return span;
  }
  function avatarCell(npub, profiles) {
    var span = document.createElement('span');
    span.className = 'lb-avatar';
    var pic = npub && profiles[npub] && profiles[npub].picture;
    if (pic) {
      var img = document.createElement('img');
      img.src = pic; img.alt = ''; img.loading = 'lazy';
      span.appendChild(img);
    }
    return span;
  }
  function nameFor(npub, fallbackName, profiles) {
    if (npub && profiles[npub] && profiles[npub].name) return profiles[npub].name;
    if (fallbackName) return fallbackName;
    return npub ? shortNpub(npub) : 'Anonymous';
  }
  // Nostrized guest: @DisplayName linking out to njump (by npub).
  function mentionLink(npub, profiles) {
    var a = document.createElement('a');
    a.className = 'lb-mention';
    a.href = 'https://njump.me/' + npub;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '@' + nameFor(npub, null, profiles);
    return a;
  }

  // npub mentions embedded in boost messages (bare or nostr:-prefixed).
  var MENTION_RE = /(?:nostr:)?(npub1[a-z0-9]{58})/g;
  function extractNpubs(message) {
    var out = [], seen = Object.create(null), m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(message || '')) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); }
    }
    return out;
  }
  // A link found in a boost message → clickable, opening in a new tab.
  // `raw` is the text as written; `href` is the navigable URL (a scheme is
  // prepended for bare domains). Display strips the scheme + a trailing
  // slash so long ad-read URLs read cleanly.
  function urlLink(raw, href) {
    var a = document.createElement('a');
    a.className = 'lb-url';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return a;
  }
  // One pass matches whichever comes first: an npub mention, a scheme'd
  // URL, or a bare domain. The bare-domain arm is TLD-gated (so prose like
  // "etc." isn't linkified) and the email guard below skips foo@bar.com.
  // npubs are strictly lowercase bech32, so the `i` flag is harmless there.
  var TOKEN_RE = /(?:nostr:)?(npub1[a-z0-9]{58})|(https?:\/\/[^\s<]+)|((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|app|co|news|dev|xyz|me|tv|fm|gg|info|page|site|link|cash|wtf)\b(?:\/[^\s<]*)?)/gi;
  // Render a boost message: collapse runs of blank lines (these ad-reads
  // ship with 3–4 \n in a row), swap npub callouts for @DisplayName, and
  // turn URLs / bare domains into clickable links.
  function renderMessageInto(el, message, profiles) {
    var text = (message || '').replace(/\n{2,}/g, '\n').trim();
    var last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) {
        el.appendChild(mentionLink(m[1], profiles));
      } else if (m[2] || m[3]) {
        // Bare domain mid-token or right after '@' (an email local-part):
        // leave it as plain text rather than a bogus link.
        var bare = !!m[3];
        var prev = m.index > 0 ? text.charAt(m.index - 1) : '';
        if (bare && /[@A-Za-z0-9.\/:]/.test(prev)) {
          el.appendChild(document.createTextNode(m[0]));
        } else {
          // Trim trailing punctuation the greedy match grabbed (e.g. a URL
          // ending a sentence) and re-emit it as plain text after the link.
          var raw = m[2] || m[3], trail = '';
          var tm = raw.match(/[).,!?;:'"\]]+$/);
          if (tm) { trail = tm[0]; raw = raw.slice(0, -trail.length); }
          var href = bare ? 'https://' + raw : raw;
          el.appendChild(urlLink(raw, href));
          if (trail) el.appendChild(document.createTextNode(trail));
        }
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  function mainCell(nameText, metaText) {
    var wrap = document.createElement('span');
    wrap.className = 'lb-main';
    var n = document.createElement('span');
    n.className = 'lb-name';
    n.textContent = nameText;
    wrap.appendChild(n);
    if (metaText) {
      var m = document.createElement('span');
      m.className = 'lb-meta';
      m.textContent = metaText;
      wrap.appendChild(m);
    }
    return wrap;
  }
  function figureCell(text) {
    var span = document.createElement('span');
    span.className = 'lb-figure';
    span.textContent = text;
    return span;
  }
  function fill(ol, rows) {
    if (!ol) return;
    if (!rows.length) { ol.innerHTML = '<li class="lb-empty">Nothing here yet.</li>'; return; }
    var frag = document.createDocumentFragment();
    rows.forEach(function (li) { frag.appendChild(li); });
    ol.replaceChildren(frag);
  }

  function prefersReduce() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Biggest Boosts as a fixed-height vertical feed: just render the rows. It's
  // a plain top-to-bottom scroll container (no seamless loop / clones) so the
  // list has a real start (#1) and end (#5) — manual scrolling stops at both.
  // Re-renders (cache → relay profiles) reuse the same element; ensureVMarquee
  // binds behavior once.
  function fillFeed(ol, items) {
    if (!ol) return;
    if (!items.length) { ol.innerHTML = '<li class="lb-empty">Nothing here yet.</li>'; return; }
    var frag = document.createDocumentFragment();
    items.forEach(function (li) { frag.appendChild(li); });
    ol.replaceChildren(frag);
    requestAnimationFrame(function () { ensureVMarquee(ol); });
  }

  // Gentle vertical auto-scroll the reader can take over: hover/focus pauses
  // it; wheel/touch/drag scrub it; auto resumes ~2s after the user stops.
  // Unlike the horizontal ticker, this does NOT wrap — manual scrolling clamps
  // at the top (#1) and bottom (#5). The auto-scroll instead runs #1→#5, holds
  // a moment at the bottom, then jumps back to the top and continues, so the
  // restart reads as a deliberate reset rather than a confusing seamless loop.
  function ensureVMarquee(el) {
    if (el.__vm) { el.__vm.refresh(); return; }

    var hovering = false, focused = false, idle = true, idleTimer = null;
    function markActive() {
      idle = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { idle = true; }, 1800);
    }
    el.addEventListener('mouseenter', function () { hovering = true; });
    el.addEventListener('mouseleave', function () { hovering = false; });
    el.addEventListener('focusin', function () { focused = true; });
    el.addEventListener('focusout', function () { focused = false; });
    el.addEventListener('wheel', markActive, { passive: true });
    el.addEventListener('touchstart', markActive, { passive: true });
    el.addEventListener('touchmove', markActive, { passive: true });

    // Mouse click-drag to scrub (no wrap — the browser clamps scrollTop).
    var startY = 0, lastY = 0, armed = false, dragging = false, dragMoved = false, pid = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      if (e.target.closest('a, button')) return;
      armed = true; dragging = false; dragMoved = false;
      startY = e.clientY; lastY = e.clientY; pid = e.pointerId;
    });
    el.addEventListener('pointermove', function (e) {
      if (!armed) return;
      if (!dragging && Math.abs(e.clientY - startY) > 3) {
        dragging = true; dragMoved = true;
        try { el.setPointerCapture(pid); } catch (x) {}
        el.classList.add('is-grabbing');
      }
      if (dragging) { el.scrollTop -= e.clientY - lastY; }
      lastY = e.clientY;
    });
    function endDrag(e) {
      armed = false;
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-grabbing');
      try { el.releasePointerCapture(e.pointerId); } catch (x) {}
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('click', function (e) {
      if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; }
    }, true);

    // Track position in JS so sub-pixel steps don't get lost to scrollTop
    // rounding. A re-render (replaceChildren) resets the list to the top, so
    // refresh() re-syncs from the live scroll position and restarts the run.
    var SPEED = 26;          // px/sec — slow enough to read the ad-reads
    var HOLD_BOTTOM = 1600;  // ms paused on #5 before jumping back to the top
    var HOLD_TOP = 900;      // ms paused at #1 after the jump before scrolling
    var pos = el.scrollTop;
    var phase = 'scroll';    // 'scroll' | 'holdBottom' | 'holdTop'
    var holdUntil = 0;
    el.__vm = { refresh: function () { pos = el.scrollTop = 0; phase = 'scroll'; holdUntil = 0; } };

    if (prefersReduce()) return; // manual scrub only; no auto motion

    var lastT = performance.now();
    function tick(now) {
      var dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
      var max = el.scrollHeight - el.clientHeight;
      if (max <= 1 || hovering || focused || dragging || !idle) {
        pos = el.scrollTop;   // nothing to scroll, or user-driven/paused — follow real value
        phase = 'scroll';
        requestAnimationFrame(tick);
        return;
      }
      if (phase === 'holdBottom') {
        if (now >= holdUntil) { pos = el.scrollTop = 0; phase = 'holdTop'; holdUntil = now + HOLD_TOP; }
      } else if (phase === 'holdTop') {
        if (now >= holdUntil) phase = 'scroll';
      } else {
        pos += SPEED * dt;
        if (pos >= max) { pos = max; el.scrollTop = max; phase = 'holdBottom'; holdUntil = now + HOLD_BOTTOM; }
        else el.scrollTop = pos;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // The three boards live in a horizontal scroll-snap track: one board per
  // view, auto-rotating every few seconds, but fully swipeable (native scroll)
  // and dot-navigable. Auto-advance pauses while the reader hovers, focuses, or
  // is actively scrolling/swiping — including the Biggest Boosts vertical feed,
  // whose own scroll bubbles up here as interaction. Structure is static HTML,
  // so this binds once on load, independent of the data fetch.
  function initCarousel() {
    var track = $('lb-track');
    var dotsWrap = $('lb-dots');
    if (!track || !dotsWrap) return;
    var slides = Array.prototype.slice.call(track.querySelectorAll('.lb-slide'));
    if (slides.length < 2) return;

    var current = 0;
    var dots = slides.map(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lb-dot';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', 'Board ' + (i + 1) + ' of ' + slides.length);
      b.addEventListener('click', function () { markActive(); goTo(i); });
      dotsWrap.appendChild(b);
      return b;
    });

    function setActive(i) {
      current = i;
      dots.forEach(function (d, di) {
        var on = di === i;
        d.classList.toggle('is-active', on);
        d.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    setActive(0);

    function goTo(i) {
      var s = slides[i];
      if (s) track.scrollTo({ left: s.offsetLeft, behavior: 'smooth' });
    }

    // Keep the active dot in sync with wherever the scroll actually lands
    // (manual swipe, auto-advance, or dot tap) — nearest slide to center wins.
    var rafPending = false;
    track.addEventListener('scroll', function () {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        var center = track.scrollLeft + track.clientWidth / 2;
        var best = 0, bestDist = Infinity;
        slides.forEach(function (s, i) {
          var d = Math.abs((s.offsetLeft + s.clientWidth / 2) - center);
          if (d < bestDist) { bestDist = d; best = i; }
        });
        if (best !== current) setActive(best);
      });
    }, { passive: true });

    var hovering = false, idle = true, idleTimer = null;
    function markActive() {
      idle = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { idle = true; }, 6000);
    }
    track.addEventListener('mouseenter', function () { hovering = true; });
    track.addEventListener('mouseleave', function () { hovering = false; });
    track.addEventListener('focusin', function () { hovering = true; });
    track.addEventListener('focusout', function () { hovering = false; });
    track.addEventListener('pointerdown', markActive);
    track.addEventListener('wheel', markActive, { passive: true });
    track.addEventListener('touchstart', markActive, { passive: true });
    track.addEventListener('touchmove', markActive, { passive: true });

    // Keyboard: ← / → step between boards when the track is focused.
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { markActive(); goTo((current + 1) % slides.length); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { markActive(); goTo((current - 1 + slides.length) % slides.length); e.preventDefault(); }
    });

    if (prefersReduce()) return;  // no auto-rotate under reduced motion

    setInterval(function () {
      if (hovering || !idle) return;
      goTo((current + 1) % slides.length);
    }, 5000);
  }

  function renderAll(data, profiles) {
    // Episodes (no avatar column). Title links to /ep###; guests nostrized.
    fill($('lb-episodes'), data.episodes.map(function (ep, i) {
      var li = document.createElement('li');
      li.className = 'lb-row lb-row--noavatar';
      li.appendChild(rankCell(i));

      var main = document.createElement('span');
      main.className = 'lb-main';
      var label = (ep.num ? 'Ep. ' + parseInt(ep.num, 10) + ' · ' : '') + (cleanTitle(ep.title) || ep.title);
      var nameEl;
      if (ep.num) {
        nameEl = document.createElement('a');
        nameEl.href = '/ep' + ep.num;
      } else {
        nameEl = document.createElement('span');
      }
      nameEl.className = 'lb-name';
      nameEl.textContent = label;
      main.appendChild(nameEl);

      var guests = data.guests[ep.num] || [];
      if (guests.length) {
        var meta = document.createElement('span');
        meta.className = 'lb-meta';
        meta.appendChild(document.createTextNode('with '));
        guests.forEach(function (np, gi) {
          if (gi > 0) meta.appendChild(document.createTextNode(' & '));
          meta.appendChild(mentionLink(np, profiles));
        });
        main.appendChild(meta);
      }
      li.appendChild(main);
      li.appendChild(figureCell(fmtInt(ep.sats) + ' sats'));
      return li;
    }));

    // Ride or Dies — medal by tier (ties share a medal), not row position.
    fill($('lb-rideordies'), data.rideOrDies.map(function (p) {
      var li = document.createElement('li');
      li.className = 'lb-row';
      li.appendChild(rankCell(p.tier));
      li.appendChild(avatarCell(p.npub, profiles));
      li.appendChild(mainCell(nameFor(p.npub, p.name, profiles), null));
      li.appendChild(figureCell(p.count + (p.count === 1 ? ' ep' : ' eps')));
      return li;
    }));

    // Biggest Boosts — wide rows with avatar, name/amount line, and the
    // full boost message (the "ad read").
    fillFeed($('lb-bigboosts'), data.biggest.map(function (b, i) {
      var li = document.createElement('li');
      li.className = 'lb-boost-item';
      li.appendChild(rankCell(i));
      li.appendChild(avatarCell(b.npub, profiles));

      var body = document.createElement('div');
      body.className = 'lb-boost-body';

      var top = document.createElement('div');
      top.className = 'lb-boost-top';
      var name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = nameFor(b.npub, b.name, profiles);
      var amt = document.createElement('span');
      amt.className = 'lb-boost-amt';
      var where = b.showLevel ? 'the show' : (b.num ? 'Ep. ' + parseInt(b.num, 10) : 'the show');
      amt.textContent = fmtInt(b.sats) + ' sats · ' + where;
      top.appendChild(name);
      top.appendChild(amt);
      body.appendChild(top);

      if (b.message) {
        var msg = document.createElement('p');
        msg.className = 'lb-boost-msg';
        renderMessageInto(msg, b.message, profiles);
        body.appendChild(msg);
      }
      li.appendChild(body);
      return li;
    }));
  }

  // ── init ──────────────────────────────────────────────────────────
  function init() {
    if (!$('lb-episodes')) return;
    initCarousel();   // structure is static; wire the carousel up front
    Promise.all([
      getJSON(SATS_URL).catch(function () { return null; }),
      getRss(),
    ]).then(function (res) {
      var sats = res[0];
      var rows = sats && Array.isArray(sats.rows) ? sats.rows : [];
      if (!rows.length) {
        ['lb-episodes', 'lb-rideordies', 'lb-bigboosts'].forEach(function (id) {
          var ol = $(id); if (ol) ol.innerHTML = '<li class="lb-empty">Couldn’t load right now.</li>';
        });
        return;
      }
      var data = {
        episodes: aggEpisodes(rows),
        rideOrDies: aggRideOrDies(rows),
        biggest: aggBiggestBoosts(rows),
        guests: parseGuests(res[1]),
      };

      // Every npub we need a name/avatar for.
      var npubSet = Object.create(null);
      data.rideOrDies.forEach(function (p) { if (p.npub) npubSet[p.npub] = 1; });
      data.biggest.forEach(function (b) {
        if (b.npub) npubSet[b.npub] = 1;
        extractNpubs(b.message).forEach(function (np) { npubSet[np] = 1; });
      });
      data.episodes.forEach(function (ep) {
        (data.guests[ep.num] || []).forEach(function (np) { npubSet[np] = 1; });
      });
      var npubs = Object.keys(npubSet);

      // Paint from cache, then upgrade once relays answer.
      renderAll(data, cachedProfiles(npubs));
      var e = enhance();
      if (e.fetchProfilesByNpub && npubs.length) {
        e.fetchProfilesByNpub(npubs).then(function (profiles) {
          if (profiles) renderAll(data, profiles);
        }).catch(function () {});
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
