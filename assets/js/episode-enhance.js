/* Episode page progressive enhancement.
 *
 * The page lands with each guest rendered as a truncated npub. This
 * script connects to a handful of Nostr relays, fetches kind-0 profile
 * metadata for the listed npubs, and upgrades the DOM in place with
 * display name + avatar.
 *
 * Zero dependencies — bech32 decode + WebSocket are inlined. ~4KB.
 * Failure is silent: if relays don't respond, the page stays on the
 * truncated-npub fallback.
 */
(function () {
  'use strict';

  // ── bech32 decode (just enough for npub → 32-byte pubkey hex) ──
  // Skips checksum verification — the npubs we decode here come from
  // our own server-rendered HTML, not user input.
  var BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var BECH32_REV = {};
  for (var i = 0; i < BECH32.length; i++) BECH32_REV[BECH32[i]] = i;

  function bech32Data(bech) {
    bech = String(bech).toLowerCase();
    var sep = bech.lastIndexOf('1');
    if (sep < 1) return null;
    var hrp = bech.slice(0, sep);
    var dataStr = bech.slice(sep + 1);
    var out = [];
    for (var i = 0; i < dataStr.length; i++) {
      var v = BECH32_REV[dataStr[i]];
      if (v === undefined) return null;
      out.push(v);
    }
    if (out.length < 6) return null;
    return { hrp: hrp, data: out.slice(0, -6) };
  }

  function convertBits(data, fromBits, toBits, pad) {
    var acc = 0, bits = 0, ret = [];
    var maxv = (1 << toBits) - 1;
    for (var i = 0; i < data.length; i++) {
      acc = (acc << fromBits) | data[i];
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        ret.push((acc >> bits) & maxv);
      }
    }
    if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    else if (!pad && (bits >= fromBits || ((acc << (toBits - bits)) & maxv))) return null;
    return ret;
  }

  function npubToHex(npub) {
    var dec = bech32Data(npub);
    if (!dec || dec.hrp !== 'npub') return null;
    var bytes = convertBits(dec.data, 5, 8, false);
    if (!bytes || bytes.length !== 32) return null;
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      hex += h.length === 1 ? '0' + h : h;
    }
    return hex;
  }

  // ── Relay query (kind-0 profile metadata) ──────────────────────
  var RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
  ];
  var OVERALL_TIMEOUT_MS = 4500;
  var PER_RELAY_TIMEOUT_MS = 3500;

  function queryRelay(url, pubkeyHexes, onProfile) {
    return new Promise(function (resolve) {
      var settled = false;
      var ws;
      var subId = 'lb' + Math.random().toString(36).slice(2, 10);
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws && ws.close(); } catch (e) {}
        resolve();
      }, PER_RELAY_TIMEOUT_MS);
      try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); resolve(); return; }

      ws.onopen = function () {
        try {
          ws.send(JSON.stringify(['REQ', subId, {
            authors: pubkeyHexes,
            kinds: [0],
            limit: pubkeyHexes.length * 3,
          }]));
        } catch (e) {}
      };
      ws.onmessage = function (evt) {
        var msg;
        try { msg = JSON.parse(evt.data); } catch (e) { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          var event = msg[2];
          if (event && event.kind === 0 && pubkeyHexes.indexOf(event.pubkey) !== -1) {
            var meta;
            try { meta = JSON.parse(event.content); } catch (e) { return; }
            onProfile(event.pubkey, event.created_at | 0, meta);
          }
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (e) {}
          resolve();
        }
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onclose = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  function fetchProfiles(pubkeyHexes) {
    // Keep the newest event per pubkey across all relays.
    var best = Object.create(null);
    var onProfile = function (hex, createdAt, meta) {
      var prev = best[hex];
      if (!prev || createdAt > prev.created_at) {
        best[hex] = { created_at: createdAt, meta: meta };
      }
    };
    var queries = RELAYS.map(function (u) { return queryRelay(u, pubkeyHexes, onProfile); });
    var overall = new Promise(function (resolve) { setTimeout(resolve, OVERALL_TIMEOUT_MS); });
    return Promise.race([Promise.all(queries), overall]).then(function () { return best; });
  }

  // ── DOM upgrade ─────────────────────────────────────────────────
  function safeImageUrl(s) {
    if (typeof s !== 'string') return null;
    if (!/^https:\/\//.test(s)) return null;
    if (s.length > 2000) return null;
    return s;
  }

  function pickName(meta) {
    if (!meta || typeof meta !== 'object') return null;
    var candidates = [meta.display_name, meta.displayName, meta.name];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 80);
    }
    return null;
  }

  function upgrade() {
    // Any .person with a data-npub gets enhanced. For guests the name
    // is upgraded from the truncated npub; for hosts the static name
    // stays and only the avatar is set. The name-replace path below is
    // a no-op when no .person-npub element exists (i.e. hosts).
    var els = document.querySelectorAll('.person[data-npub]');
    if (!els.length) return;

    var npubByHex = Object.create(null);
    var elByNpub = Object.create(null);
    var hexes = [];

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var npub = el.getAttribute('data-npub');
      if (!npub || elByNpub[npub]) continue;
      elByNpub[npub] = el;
      var hex = npubToHex(npub);
      if (hex) {
        npubByHex[hex] = npub;
        hexes.push(hex);
      }
    }
    if (!hexes.length) return;

    fetchProfiles(hexes).then(function (best) {
      for (var hex in best) {
        var npub = npubByHex[hex];
        var el = npub && elByNpub[npub];
        if (!el) continue;
        var meta = best[hex].meta;
        var name = pickName(meta);
        if (name) {
          var codeEl = el.querySelector('.person-npub');
          if (codeEl) {
            var span = document.createElement('span');
            span.className = 'person-name';
            span.textContent = name;
            codeEl.replaceWith(span);
          }
        }
        var pic = safeImageUrl(meta && meta.picture);
        if (pic) {
          var av = el.querySelector('.person-avatar');
          if (av) {
            // background-image URL: image loads under img-src CSP. Quote
            // the URL and let the browser handle it as a CSS string —
            // safeImageUrl already enforces https + length cap.
            av.style.backgroundImage = 'url("' + pic.replace(/"/g, '%22') + '")';
          }
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', upgrade);
  } else {
    upgrade();
  }

  // ── Lazy widget loader (mirrors index.html's ensureWidgetLoaded) ──
  // The login-widget bundle is ~250KB and only needed on boost click.
  var widgetPromise = null;
  function ensureWidgetLoaded() {
    if (widgetPromise) return widgetPromise;
    widgetPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/assets/widgets/login-widget.js';
      s.async = true;
      s.onload = function () { Promise.resolve().then(resolve); };
      s.onerror = function () {
        widgetPromise = null;
        reject(new Error('Failed to load boost widget'));
      };
      document.head.appendChild(s);
    });
    return widgetPromise;
  }

  function readEpData() {
    var el = document.getElementById('lb-ep-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || ''); } catch (e) { return null; }
  }

  // ── Boost button ───────────────────────────────────────────────
  function wireBoost() {
    var btn = document.querySelector('[data-lb-boost-trigger="episode"]');
    if (!btn) return;
    var data = readEpData();
    if (!data || !data.episode || !data.splits) {
      btn.disabled = true;
      return;
    }
    var labelEl = btn.querySelector('.lb-boost-label');
    btn.addEventListener('click', function () {
      var prev = labelEl ? labelEl.textContent : '';
      if (labelEl) labelEl.textContent = 'Loading…';
      btn.disabled = true;
      ensureWidgetLoaded().then(function () {
        if (window.LBLogin && typeof window.LBLogin.openEpisodeBoost === 'function') {
          window.LBLogin.openEpisodeBoost({
            episode: data.episode,
            splits: data.splits,
          });
        }
      }).catch(function (e) {
        console.warn('[lb-ep] widget load failed', e);
      }).then(function () {
        if (labelEl) labelEl.textContent = prev;
        btn.disabled = false;
      });
    });
  }

  // ── MP3 download ──────────────────────────────────────────────
  // The `download` attribute is ignored cross-origin by Chrome when the
  // server doesn't send Content-Disposition: attachment, so it just
  // opens the audio file in a new tab. Fountain's CDN does send
  // Access-Control-Allow-Origin: *, so we can fetch the bytes, wrap
  // them in a Blob, and trigger a real download via a synthetic anchor.
  function wireDownloadMp3() {
    var btns = document.querySelectorAll('[data-lb-download-mp3]');
    for (var i = 0; i < btns.length; i++) (function (btn) {
      btn.addEventListener('click', function () {
        var url = btn.getAttribute('data-mp3-url');
        var filename = btn.getAttribute('data-mp3-filename') || 'episode.mp3';
        if (!url) return;
        var prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        fetch(url).then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.blob();
        }).then(function (blob) {
          var blobUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 200);
          btn.textContent = prev;
          btn.disabled = false;
        }).catch(function (e) {
          console.warn('[lb-ep] mp3 download failed', e);
          btn.textContent = prev;
          btn.disabled = false;
          // Fall back: open the URL so the user can right-click → Save.
          window.open(url, '_blank', 'noopener');
        });
      });
    })(btns[i]);
  }

  // ── Overflow (⋮) menu: mobile-only toggle for the secondary actions ─
  // The ⋮ trigger is hidden on desktop (the group flattens inline via
  // display:contents), so this only does anything on narrow screens.
  // Toggling `.open` reveals the MP3/Transcript menu; outside clicks
  // close it, mirroring the subscribe dropdown closer below.
  function wireOverflowMenu() {
    var groups = document.querySelectorAll('.ep-overflow');
    for (var i = 0; i < groups.length; i++) (function (group) {
      var btn = group.querySelector('.ep-overflow-btn');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = group.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    })(groups[i]);
    document.addEventListener('click', function (e) {
      var open = document.querySelectorAll('.ep-overflow.open');
      for (var j = 0; j < open.length; j++) {
        if (!open[j].contains(e.target)) {
          open[j].classList.remove('open');
          var b = open[j].querySelector('.ep-overflow-btn');
          if (b) b.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }

  // ── Subscribe dropdown outside-click closer (matches homepage) ─
  function wireSubscribeCloser() {
    document.addEventListener('click', function (e) {
      var open = document.querySelectorAll('details.ep-subscribe[open]');
      for (var i = 0; i < open.length; i++) {
        if (!open[i].contains(e.target)) open[i].removeAttribute('open');
      }
    });
  }

  // ── Chapters: click-to-seek + active-chapter highlight ──────────
  // The server renders a static, timestamped chapter list (data-seconds
  // per row). Here we make it a live control: clicking a row seeks the
  // <audio> element, and the row covering the current playhead gets the
  // .is-active class as playback advances. Degrades to a readable list
  // when JS is off.
  function wireChapters() {
    var audio = document.querySelector('.ep-player');
    var buttons = document.querySelectorAll('.ep-chapter-btn');
    if (!audio || !buttons.length) return;

    var starts = [];
    for (var i = 0; i < buttons.length; i++) {
      starts.push(parseInt(buttons[i].getAttribute('data-seconds'), 10) || 0);
    }

    for (var j = 0; j < buttons.length; j++) (function (btn, secs) {
      btn.addEventListener('click', function () {
        try { audio.currentTime = secs; } catch (e) {}
        var p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      });
    })(buttons[j], starts[j]);

    var activeIdx = -1;
    function syncActive() {
      var t = audio.currentTime;
      // Active chapter = the last one whose start is at/behind the
      // playhead. Small tolerance so a click-seek lands on its chapter.
      var idx = -1;
      for (var k = 0; k < starts.length; k++) {
        if (starts[k] <= t + 0.25) idx = k; else break;
      }
      if (idx === activeIdx) return;
      if (activeIdx >= 0) {
        buttons[activeIdx].classList.remove('is-active');
        buttons[activeIdx].removeAttribute('aria-current');
      }
      activeIdx = idx;
      if (idx >= 0) {
        buttons[idx].classList.add('is-active');
        buttons[idx].setAttribute('aria-current', 'true');
      }
    }
    audio.addEventListener('timeupdate', syncActive);
    audio.addEventListener('seeked', syncActive);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireBoost();
      wireDownloadMp3();
      wireOverflowMenu();
      wireSubscribeCloser();
      wireChapters();
    });
  } else {
    wireBoost();
    wireDownloadMp3();
    wireOverflowMenu();
    wireSubscribeCloser();
    wireChapters();
  }

  // ── Shared profile resolver ─────────────────────────────────────
  // Exposed for other episode-page modules (ep-sats.js, stats.js) that
  // need npub → display name/avatar without re-implementing bech32 +
  // relay querying. Returns a plain object keyed by the input npub
  // strings; npubs with no resolvable kind-0 are simply absent.
  //
  // Resolution path: localStorage cache → Primal cache → relay fan-out.
  // The local cache makes repeat page loads render names instantly even
  // when the network arm fails; Primal's cache resolves nearly any
  // npub in one round-trip and is much more reliable than the 3-relay
  // race the original implementation used.
  var PROFILE_CACHE_KEY = 'lb_profile_cache_v1';
  var PROFILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var PRIMAL_WS_URL = 'wss://cache1.primal.net/v1';
  var PRIMAL_TIMEOUT_MS = 6000;

  function loadProfileCache() {
    try {
      var raw = localStorage.getItem(PROFILE_CACHE_KEY);
      if (!raw) return Object.create(null);
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return Object.create(null);
      var now = Date.now();
      var out = Object.create(null);
      for (var npub in data) {
        var e = data[npub];
        if (e && typeof e.cachedAt === 'number' &&
            now - e.cachedAt < PROFILE_CACHE_TTL_MS) {
          out[npub] = e;
        }
      }
      return out;
    } catch (e) { return Object.create(null); }
  }

  function saveProfileCache(cache) {
    try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(cache)); }
    catch (e) {}
  }

  // Primal exposes a `user_infos` cache op that returns kind-0 events
  // for an arbitrary list of pubkeys in one round-trip. Returns
  // { hex: { ev } } for every pubkey Primal had a profile for.
  function fetchProfilesFromPrimal(pubkeyHexes) {
    return new Promise(function (resolve) {
      if (!pubkeyHexes.length) return resolve(Object.create(null));
      var settled = false;
      var events = [];
      var subId = 'lbp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      var ws;
      var timer = setTimeout(function () { finish(); }, PRIMAL_TIMEOUT_MS);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws && ws.close(); } catch (e) {}
        var byHex = Object.create(null);
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          if (!ev || ev.kind !== 0) continue;
          var prev = byHex[ev.pubkey];
          var ts = ev.created_at | 0;
          if (!prev || ts > prev.created_at) {
            byHex[ev.pubkey] = { created_at: ts, ev: ev };
          }
        }
        resolve(byHex);
      }
      try { ws = new WebSocket(PRIMAL_WS_URL); }
      catch (e) { return finish(); }
      ws.onopen = function () {
        try {
          ws.send(JSON.stringify(['REQ', subId, {
            cache: ['user_infos', { pubkeys: pubkeyHexes }],
          }]));
        } catch (e) { finish(); }
      };
      ws.onmessage = function (e) {
        var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[2]) events.push(msg[2]);
        else if (msg[0] === 'EOSE') finish();
      };
      ws.onerror = function () { finish(); };
      ws.onclose = function () { if (!settled) finish(); };
    });
  }

  function fetchProfilesByNpub(npubs) {
    var hexByNpub = Object.create(null);
    var npubByHex = Object.create(null);
    var hexes = [];
    for (var i = 0; i < npubs.length; i++) {
      var np = npubs[i];
      if (hexByNpub[np]) continue;
      var hex = npubToHex(np);
      if (!hex) continue;
      hexByNpub[np] = hex;
      npubByHex[hex] = np;
      hexes.push(hex);
    }
    if (!hexes.length) return Promise.resolve(Object.create(null));

    var cache = loadProfileCache();
    var out = Object.create(null);
    var pendingHexes = [];
    for (var np2 in hexByNpub) {
      var cached = cache[np2];
      if (cached && (cached.name || cached.picture)) {
        out[np2] = { name: cached.name || null, picture: cached.picture || null };
      } else {
        pendingHexes.push(hexByNpub[np2]);
      }
    }
    if (!pendingHexes.length) return Promise.resolve(out);

    return fetchProfilesFromPrimal(pendingHexes).then(function (primalBest) {
      var stillMissing = [];
      for (var ph = 0; ph < pendingHexes.length; ph++) {
        var hex2 = pendingHexes[ph];
        var np3 = npubByHex[hex2];
        var entry = primalBest[hex2];
        if (entry && entry.ev) {
          var meta = parseProfileMeta(entry.ev);
          out[np3] = {
            name: pickName(meta),
            picture: safeImageUrl(meta && meta.picture),
          };
          cache[np3] = {
            name: out[np3].name, picture: out[np3].picture,
            cachedAt: Date.now(),
          };
        } else {
          stillMissing.push(hex2);
        }
      }
      if (!stillMissing.length) {
        saveProfileCache(cache);
        return out;
      }
      // Anything Primal didn't have — fall back to the relay race.
      return fetchProfiles(stillMissing).then(function (relayBest) {
        for (var rh = 0; rh < stillMissing.length; rh++) {
          var rHex = stillMissing[rh];
          var rNp = npubByHex[rHex];
          var rEntry = relayBest[rHex];
          if (!rEntry) continue;
          out[rNp] = {
            name: pickName(rEntry.meta),
            picture: safeImageUrl(rEntry.meta && rEntry.meta.picture),
          };
          cache[rNp] = {
            name: out[rNp].name, picture: out[rNp].picture,
            cachedAt: Date.now(),
          };
        }
        saveProfileCache(cache);
        return out;
      });
    });
  }

  function parseProfileMeta(ev) {
    try { return JSON.parse(ev.content); } catch (e) { return null; }
  }

  // Sync lookup into the same localStorage cache fetchProfilesByNpub
  // populates. Lets callers (the supporter leaderboard, streamers, etc.)
  // render with the right names on the FIRST paint instead of flashing
  // a truncated npub and re-rendering once the promise resolves.
  function getCachedProfilesByNpub(npubs) {
    var cache = loadProfileCache();
    var out = Object.create(null);
    for (var i = 0; i < npubs.length; i++) {
      var n = npubs[i];
      var entry = cache[n];
      if (entry && (entry.name || entry.picture)) {
        out[n] = { name: entry.name || null, picture: entry.picture || null };
      }
    }
    return out;
  }

  window.LBEpisodeEnhance = {
    fetchProfilesByNpub: fetchProfilesByNpub,
    getCachedProfilesByNpub: getCachedProfilesByNpub,
  };
})();
