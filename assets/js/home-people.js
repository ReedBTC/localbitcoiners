/* Homepage people modules (ES module):
 *   1. "Meet Our Show Guests"  — carousel from the show's guest follow pack
 *      (following.space kind-39089), falling back to /api/guests.
 *   2. "Meet Our Supporters"   — carousel of every supporter aggregated from
 *      /data/sats.json, largest → smallest. Tier rings (gold/silver/bronze)
 *      mark the Sovereign / Frontiersmen / Trailblazer tiers.
 *   3. "Recent Boosts"         — a scrolling list of the latest boost messages
 *      (top 20, ~4 visible) with each sender's pfp + display name.
 *
 * Names + avatars resolve through window.LBEpisodeEnhance (localStorage cache
 * → Primal → relay fan-out), the same resolver /supporters uses; one resolved
 * profile updates every card for that npub via a shared registry. Everything
 * degrades quietly — a failed source leaves a short empty-state message.
 */
import { SimplePool, nip19 } from '/assets/widgets/nostr-tools.js';

// ── config ──────────────────────────────────────────────────────────
const GUESTS_URL = '/api/guests';
const SATS_URL = '/data/sats.json';

// Show guest follow pack (following.space): kind 39089, addressable by
// author + d-tag. https://following.space/d/lb-supporters-guests?p=<hex>
const PACK_AUTHOR_HEX = 'c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592';
const PACK_D = 'lb-supporters-guests';
const PACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

// Lifetime-sats tier → pfp ring (mirrors supporters.js TIERS).
const TIER_RINGS = [
  { min: 100000, ring: 'tier-gold' },   // Sovereigns
  { min: 69000, ring: 'tier-silver' },  // Frontiersmen
  { min: 21000, ring: 'tier-bronze' },  // Trailblazers
];
function ringFor(sats) {
  for (const t of TIER_RINGS) if (sats >= t.min) return t.ring;
  return null;
}

const SKELETON_COUNT = 8;

// ── helpers ─────────────────────────────────────────────────────────
function shortNpub(npub) {
  if (!npub || npub.length < 16) return npub || '';
  return npub.slice(0, 9) + '…' + npub.slice(-4);
}

// ── tiny toast (npub copied) ────────────────────────────────────────
let toastEl = null, toastTimer = null;
function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'lb-people-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  void toastEl.offsetWidth;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 1500);
}
// execCommand fallback for when navigator.clipboard is unavailable (e.g.
// a non-secure dev context served over a LAN IP). The textarea must be
// on-screen with real size to be reliably selectable on mobile. Mirrors
// the Supporters page so clicking a pfp copies straight to the clipboard
// with a toast — no prompt popup unless even execCommand fails.
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = '0';
  ta.style.fontSize = '16px'; // avoids iOS zoom; harmless elsewhere
  document.body.appendChild(ta);
  let ok = false;
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
  const finish = (ok) => {
    if (ok) { showToast('npub copied'); return; }
    // Absolute last resort so it never silently fails.
    try { window.prompt('Copy this npub:', npub); }
    catch (e) { showToast('Couldn’t copy npub'); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(npub)
      .then(() => finish(true))
      .catch(() => finish(fallbackCopy(npub)));
  } else {
    finish(fallbackCopy(npub));
  }
}

// ── shared profile registry (npub → all DOM nodes for that person) ──
const nodesByNpub = Object.create(null);
function registerNode(npub, rec) {
  if (!npub) return;
  (nodesByNpub[npub] || (nodesByNpub[npub] = [])).push(rec);
}
function applyProfile(npub, prof) {
  const recs = nodesByNpub[npub];
  if (!recs || !prof) return;
  for (const rec of recs) {
    if (prof.name && rec.nameEl) rec.nameEl.textContent = prof.name;
    if (prof.picture && rec.avatar && rec.avatar.classList.contains('is-blank')) {
      rec.avatar.classList.remove('is-blank');
      const img = document.createElement('img');
      img.src = prof.picture; img.alt = ''; img.loading = 'lazy';
      rec.avatar.appendChild(img);
    }
  }
}
function enhance() { return window.LBEpisodeEnhance || {}; }
function cachedProfiles(npubs) {
  const e = enhance();
  return (e.getCachedProfilesByNpub && e.getCachedProfilesByNpub(npubs)) || Object.create(null);
}
function resolveProfiles(npubs) {
  const e = enhance();
  if (!e.fetchProfilesByNpub || !npubs.length) return;
  e.fetchProfilesByNpub(npubs).then((profiles) => {
    if (!profiles) return;
    Object.keys(profiles).forEach((np) => applyProfile(np, profiles[np]));
  }).catch(() => {});
}

// ── avatar element (registers itself for in-place upgrade) ──────────
function makeAvatar(npub, picture, extraClass) {
  const avatar = document.createElement('span');
  avatar.className = 'people-avatar' + (extraClass ? ' ' + extraClass : '');
  if (picture) {
    const img = document.createElement('img');
    img.src = picture; img.alt = ''; img.loading = 'lazy';
    avatar.appendChild(img);
  } else {
    avatar.classList.add('is-blank');
  }
  return avatar;
}

// ── carousel card ───────────────────────────────────────────────────
function makeCard(opts) {
  const npub = opts.npub || null;
  const name = opts.name || (npub ? shortNpub(npub) : 'Anonymous');

  const card = document.createElement(npub ? 'button' : 'div');
  card.className = 'people-card';
  if (npub) {
    card.type = 'button';
    card.title = 'Click to copy npub';
    card.setAttribute('aria-label', 'Copy npub for ' + name);
    card.addEventListener('click', () => copyNpub(npub));
  }

  const avatar = makeAvatar(npub, opts.picture, opts.ring);
  card.appendChild(avatar);

  const nameEl = document.createElement('span');
  nameEl.className = 'people-name';
  nameEl.textContent = name;
  card.appendChild(nameEl);

  // Guests get the episode(s) they appeared on, linked to the episode page.
  if (opts.episodes && opts.episodes.length) {
    const eps = document.createElement('span');
    eps.className = 'people-eps';
    opts.episodes.forEach((pad3) => {
      const a = document.createElement('a');
      a.href = '/ep' + pad3;
      a.textContent = 'EP' + pad3;
      a.addEventListener('click', (e) => e.stopPropagation()); // navigate, don't copy npub
      eps.appendChild(a);
    });
    card.appendChild(eps);
  }

  registerNode(npub, { avatar, nameEl });
  return card;
}

// Fetch the RSS once and build a guest npub → [padded episode numbers] map
// from the [guests: …] shownotes markers. Uses the cached feed when present.
function guestEpisodeMap() {
  function parse(xml) {
    const map = Object.create(null);
    if (!xml) return map;
    let doc;
    try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { return map; }
    const items = doc.querySelectorAll('item');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const numEl = item.querySelector('episode');
      let num = numEl ? numEl.textContent.trim() : '';
      if (!num) {
        const t = item.querySelector('title');
        const tm = (t ? t.textContent : '').match(/Ep\.?\s*(\d+)/i);
        if (tm) num = tm[1];
      }
      if (!num) continue;
      const pad3 = String(num).replace(/[^\d]/g, '').padStart(3, '0');
      const descEl = item.querySelector('summary') || item.querySelector('description');
      const gm = (descEl ? descEl.textContent : '').match(/\[guests:\s*([^\]]*)\]/i);
      if (!gm) continue;
      gm[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((np) => {
        const arr = map[np] || (map[np] = []);
        if (arr.indexOf(pad3) === -1) arr.push(pad3);
      });
    }
    Object.keys(map).forEach((k) => map[k].sort());
    return map;
  }
  try {
    const c = localStorage.getItem('lb_rss_xml_v1');
    if (c && c.indexOf('<item>') >= 0) return Promise.resolve(parse(c));
  } catch (e) {}
  return fetch('/api/rss').then((r) => (r.ok ? r.text() : '')).then(parse).catch(() => Object.create(null));
}

function skeletons(container) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < SKELETON_COUNT; i++) {
    const c = document.createElement('div');
    c.className = 'people-card is-skeleton';
    c.innerHTML = '<span class="people-avatar"></span><span class="people-name"></span>';
    frag.appendChild(c);
  }
  container.replaceChildren(frag);
}
function emptyState(container, msg, cls) {
  const p = document.createElement('p');
  p.className = cls || 'people-empty';
  p.textContent = msg;
  container.replaceChildren(p);
}

// ── supporter aggregation (mirrors supporters.js) ───────────────────
function aggregate(rows) {
  const byKey = Object.create(null);
  for (const r of rows) {
    const sats = typeof r.total_sats === 'number' ? r.total_sats : 0;
    if (sats <= 0) continue;
    const npub = r.sender_npub || '';
    const key = npub || (r.sender_name ? 'name:' + r.sender_name : '');
    if (!key) continue; // truly anonymous → skip
    let rec = byKey[key];
    if (!rec) rec = byKey[key] = { npub: npub || null, name: r.sender_name || null, sats: 0 };
    rec.sats += sats;
    if (!rec.name && r.sender_name) rec.name = r.sender_name;
  }
  const people = Object.values(byKey);
  people.sort((a, b) => b.sats - a.sats);
  return people;
}

// ── carousel scroll arrows ──────────────────────────────────────────
function wireArrows(carousel) {
  const wrap = carousel.closest('.carousel-wrap');
  if (!wrap) return;
  const prev = wrap.querySelector('[data-carousel-prev]');
  const next = wrap.querySelector('[data-carousel-next]');
  function update() {
    const overflow = carousel.scrollWidth - carousel.clientWidth > 8;
    const atStart = carousel.scrollLeft <= 4;
    const atEnd = carousel.scrollLeft >= carousel.scrollWidth - carousel.clientWidth - 4;
    if (prev) prev.hidden = !overflow || atStart;
    if (next) next.hidden = !overflow || atEnd;
  }
  const step = (dir) => carousel.scrollBy({ left: dir * Math.round(carousel.clientWidth * 0.8), behavior: 'smooth' });
  if (prev) prev.addEventListener('click', () => step(-1));
  if (next) next.addEventListener('click', () => step(1));
  carousel.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  requestAnimationFrame(update);
  setTimeout(update, 500);
}

// One-time "it scrolls!" cue — when the row first comes into view and it
// actually overflows, nudge it right a touch and ease back. The motion reads
// on mobile (where the arrows are hidden) without hijacking the user.
function hintScroll(el) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;
  let done = false;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (done || !entry.isIntersecting) return;
      if (el.scrollWidth - el.clientWidth < 24) return; // nothing to scroll
      done = true; io.disconnect();
      // A clear double-pulse so it's obvious the row slides side-to-side.
      const peek = Math.min(120, el.clientWidth * 0.4);
      el.scrollTo({ left: peek, behavior: 'smooth' });
      setTimeout(() => el.scrollTo({ left: 0, behavior: 'smooth' }), 600);
      setTimeout(() => el.scrollTo({ left: peek * 0.6, behavior: 'smooth' }), 1150);
      setTimeout(() => el.scrollTo({ left: 0, behavior: 'smooth' }), 1650);
    });
  }, { threshold: 0.6 });
  io.observe(el);
}

function renderCarousel(container, cards, npubs) {
  if (!cards.length) { emptyState(container, 'Nothing to show yet.'); return; }
  const frag = document.createDocumentFragment();
  cards.forEach((c) => frag.appendChild(c));
  container.replaceChildren(frag);
  wireArrows(container);
  hintScroll(container);
  resolveProfiles(npubs);
}

// ── 1. guests (follow pack → fallback /api/guests) ──────────────────
async function fetchPackGuests() {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(PACK_RELAYS, {
      kinds: [39089], authors: [PACK_AUTHOR_HEX], '#d': [PACK_D],
    });
    let newest = null;
    for (const ev of (events || [])) {
      if (!newest || ev.created_at > newest.created_at) newest = ev;
    }
    if (!newest) return [];
    const seen = new Set(), npubs = [];
    for (const t of newest.tags) {
      if (t[0] === 'p' && t[1] && !seen.has(t[1])) {
        seen.add(t[1]);
        try { npubs.push(nip19.npubEncode(t[1])); } catch (e) {}
      }
    }
    return npubs;
  } catch (e) {
    return [];
  } finally {
    try { pool.close(PACK_RELAYS); } catch (e) {}
  }
}
async function fetchApiGuests() {
  try {
    const r = await fetch(GUESTS_URL);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.guests) ? d.guests : [];
  } catch (e) { return []; }
}
async function initGuests(el) {
  skeletons(el);
  const [packNpubs, epMap] = await Promise.all([fetchPackGuests(), guestEpisodeMap()]);
  let npubs = packNpubs;
  if (!npubs.length) npubs = await fetchApiGuests();
  if (!npubs.length) { emptyState(el, 'Guest roster coming soon.'); return; }
  const cache = cachedProfiles(npubs);
  const cards = npubs.map((np) => {
    const p = cache[np] || null;
    return makeCard({ npub: np, name: p && p.name, picture: p && p.picture, episodes: epMap[np] || [] });
  });
  renderCarousel(el, cards, npubs);
}

// ── 2. supporters (all, largest → smallest, tier rings, no rank) ────
async function initSupporters(el) {
  skeletons(el);
  let rows = [];
  try {
    const r = await fetch(SATS_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error('sats ' + r.status);
    const d = await r.json();
    rows = Array.isArray(d.rows) ? d.rows : [];
  } catch (e) { emptyState(el, 'Couldn’t load supporters right now.'); return; }

  const people = aggregate(rows);
  if (!people.length) { emptyState(el, 'Be the first to boost the show!'); return; }
  const npubs = people.map((p) => p.npub).filter(Boolean);
  const cache = cachedProfiles(npubs);
  const cards = people.map((p) => {
    const prof = (p.npub && cache[p.npub]) || null;
    return makeCard({
      npub: p.npub,
      name: (prof && prof.name) || p.name,
      picture: prof && prof.picture,
      ring: ringFor(p.sats),
    });
  });
  renderCarousel(el, cards, npubs);
}

// (The "Recent Boosts" feed moved to home-boosts.js — it now renders the
// real Nostr note cards in a marquee rather than a static ledger ticker.)

// ── init ────────────────────────────────────────────────────────────
function init() {
  const guestsEl = document.getElementById('guests-carousel');
  const supEl = document.getElementById('supporters-carousel');
  if (guestsEl) initGuests(guestsEl);
  if (supEl) initSupporters(supEl);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
