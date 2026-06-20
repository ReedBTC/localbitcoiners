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

  var SATS_URL = '/data/sats.json';
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
    fill($('lb-bigboosts'), data.biggest.map(function (b, i) {
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
