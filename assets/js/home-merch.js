/* Homepage "Merch" marquee — a continuous horizontal strip of the store's
 * products, mirroring the Recent Boosts marquee directly above it but
 * scrolling the OPPOSITE direction (leftward).
 *
 * Cards are simplified here (image + title + price in sats only), but a
 * click opens the exact same product detail modal as /merch — we reuse
 * merch.js's fetchCatalog()/catalog + openProductModal() so there's one
 * source of truth for the catalog and the modal (including add-to-cart /
 * checkout). merch.js only auto-runs its full storefront when #merch-grid
 * is present, so importing it here is inert beyond the exports we use.
 *
 * Falls back to a "Sold Out — Restocking Inventory" message on an empty
 * catalog or any fetch failure.
 */
import {
  fetchCatalog, catalog, openProductModal, toSats, getBtcUsd, fmtSats, priceLabel,
} from '/assets/js/merch.js';

const SPEED_PX_S = 55;          // match the boosts marquee cadence
const SOLD_OUT_MSG = 'Sold Out — Restocking Inventory';

// Stale-while-revalidate cache: paint instantly from a recent snapshot, then
// refetch the live catalog and repaint. Teaser-only — the detail modal / cart
// / checkout always run against the live catalog fetched on every build, so a
// stale card can't cause a bad purchase.
const CACHE_KEY = 'lb_home_merch_v1';
const CACHE_TTL = 6 * 60 * 60 * 1000;   // 6h

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.products) || !data.products.length) return null;
    if (Date.now() - (data.ts || 0) > CACHE_TTL) return null;
    return data.products;
  } catch { return null; }
}
function writeCache(products) {
  try {
    if (!products || !products.length) return;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), products }));
  } catch {}
}

function message(container, msg) {
  const p = document.createElement('p');
  p.className = 'merch-marquee-empty';
  p.textContent = msg;
  container.replaceChildren(p);
}

// Price in sats only. Fiat-priced items convert via the BTC/USD oracle; if
// the rate can't be fetched we fall back to the native price label so a card
// never shows a blank price.
async function applySatsPrice(el, p) {
  const c = String(p.priceCurrency || 'USD').toUpperCase();
  if (c === 'SAT' || c === 'SATS' || c === 'BTC') {
    const sats = toSats(p.priceAmount, p.priceCurrency, null);
    el.textContent = sats != null ? fmtSats(sats) : priceLabel(p.priceAmount, p.priceCurrency);
    return;
  }
  const rate = await getBtcUsd();
  const sats = toSats(p.priceAmount, p.priceCurrency, rate);
  el.textContent = sats != null ? fmtSats(sats) : priceLabel(p.priceAmount, p.priceCurrency);
}

// Simplified card: image, title, sats price. Clicking opens the full merch
// detail modal (openProductModal), identical to the storefront.
function makeItem(p, isDupe) {
  const item = document.createElement('div');
  item.className = 'merch-marquee-item' + (isDupe ? ' is-dupe' : '');
  if (isDupe) item.setAttribute('aria-hidden', 'true');

  const media = document.createElement('div');
  media.className = 'merch-card-media';
  if (p.images.length) {
    const img = document.createElement('img');
    img.src = p.images[0];
    img.alt = p.title;
    img.loading = 'lazy';
    media.appendChild(img);
  } else {
    const noimg = document.createElement('div');
    noimg.className = 'merch-card-noimg';
    noimg.textContent = '🛍️';
    media.appendChild(noimg);
  }

  const body = document.createElement('div');
  body.className = 'merch-card-body';
  const title = document.createElement('h3');
  title.className = 'merch-card-title';
  title.textContent = p.title;
  const sub = document.createElement('div');
  sub.className = 'merch-card-sub';
  applySatsPrice(sub, p);
  body.append(title, sub);

  const card = document.createElement('div');
  card.className = 'merch-card';
  card.append(media, body);

  item.appendChild(card);
  item.__product = p; // looked up on click to open the detail modal
  return item;
}

// Auto-scroll the strip LEFTWARD at a constant px/sec, looping seamlessly,
// while letting the user take over: hover/focus pauses it, and the strip is a
// real scroll container so click-drag (mouse) and swipe (touch) scrub it.
// (Same engine as home-boosts.js, direction reversed.)
function startMarquee(el) {
  const reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let setWidth = 0;
  const measure = () => { setWidth = el.scrollWidth / 2; };
  el.__measure = measure;   // let a later (revalidation) repaint re-measure
  measure();
  el.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', measure, { once: true });
  });
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure, { once: true });

  // Normalize a target scroll position into [0, setWidth) and RETURN it, so
  // callers assign it in one step. Assigning a pre-normalized value matters
  // for leftward motion: `scrollLeft -= n` would be clamped to 0 by the
  // browser before any post-hoc wrap could add setWidth back, freezing the
  // strip at the left edge. Computing the wrap first avoids the clamp.
  const norm = (x) => {
    if (setWidth <= 0) return x < 0 ? 0 : x;
    x %= setWidth;
    return x < 0 ? x + setWidth : x;
  };

  let hovering = false, focused = false, dragging = false, dragMoved = false;
  let idle = true, idleTimer = null;
  const markActive = () => {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; }, 1800);
  };

  el.addEventListener('mouseenter', () => { hovering = true; });
  el.addEventListener('mouseleave', () => { hovering = false; });
  el.addEventListener('focusin', () => { focused = true; });
  el.addEventListener('focusout', () => { focused = false; });
  el.addEventListener('wheel', markActive, { passive: true });
  el.addEventListener('touchstart', markActive, { passive: true });
  el.addEventListener('touchmove', markActive, { passive: true });

  // Mouse click-drag to scrub. Don't hijack clicks on a link/button, and only
  // treat it as a drag once the pointer actually moves. Capture only once a
  // real drag begins so the click-to-open-modal still fires on a plain click.
  let startX = 0, lastX = 0, armed = false, dragPointerId = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.target.closest('a, button')) return;
    armed = true; dragging = false; dragMoved = false;
    startX = e.clientX; lastX = e.clientX; dragPointerId = e.pointerId;
  });
  el.addEventListener('pointermove', (e) => {
    if (!armed) return;
    if (!dragging && Math.abs(e.clientX - startX) > 3) {
      dragging = true; dragMoved = true;
      try { el.setPointerCapture(dragPointerId); } catch (err) {}
      el.classList.add('is-grabbing');
    }
    if (dragging) {
      el.scrollLeft = norm(el.scrollLeft - (e.clientX - lastX));
    }
    lastX = e.clientX;
  });
  const endDrag = (e) => {
    armed = false;
    if (!dragging) return;
    dragging = false;
    el.classList.remove('is-grabbing');
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  // Swallow the click that ends a real drag so it doesn't open the modal.
  el.addEventListener('click', (e) => {
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; }
  }, true);

  // A genuine click (no drag) on a card opens the merch detail modal.
  el.addEventListener('click', (e) => {
    if (dragMoved) return;
    if (e.target.closest('a, button')) return;
    const item = e.target.closest('.merch-marquee-item');
    if (item && item.__product) openProductModal(item.__product);
  });

  if (reduce) return; // manual scroll only; no auto motion

  const SPEED = SPEED_PX_S;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Leftward — the opposite of the boosts marquee above. Normalize-then-
    // assign (via norm) so the position never clamps at the left edge.
    if (!(hovering || focused || dragging || !idle)) {
      el.scrollLeft = norm(el.scrollLeft - SPEED * dt);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Fill the strip with two identical sets (A + dupe B), each `reps` copies of
// the catalog so ONE set comfortably overflows the strip — the precondition
// for the seamless scrollLeft wrap (setWidth = scrollWidth/2 must be ≥
// clientWidth). Probe one copy first to size `reps`. Rendered fresh (not
// cloned) so each item carries its own __product for the click handler.
function fill(container, products) {
  const probe = document.createDocumentFragment();
  for (const p of products) probe.appendChild(makeItem(p, false));
  container.replaceChildren(probe);
  const oneCopyW = container.scrollWidth;
  const viewW = container.clientWidth || 1;
  const reps = Math.max(1, Math.ceil((viewW + 1) / Math.max(oneCopyW, 1)));

  const frag = document.createDocumentFragment();
  for (let set = 0; set < 2; set++)
    for (let r = 0; r < reps; r++)
      for (const p of products) frag.appendChild(makeItem(p, set === 1));
  container.replaceChildren(frag);
}

// Paint the strip, starting the marquee the FIRST time only; a later
// (revalidation) repaint just refills + re-measures so we never stack a
// second scroll loop / listener set on the container.
function paint(container, products) {
  fill(container, products);
  if (!container.__marqueeStarted) {
    container.__marqueeStarted = true;
    requestAnimationFrame(() => startMarquee(container));
  } else {
    requestAnimationFrame(() => container.__measure && container.__measure());
  }
}

async function build(container) {
  // 1. Instant paint from a recent cached snapshot. The marquee renders
  // straight from the product objects; the live catalog fetched below still
  // backs the detail modal's cart / stock / checkout.
  const cached = readCache();
  if (cached) paint(container, cached);

  // 2. Revalidate against the live catalog.
  try {
    await fetchCatalog();
  } catch (e) {
    console.warn('[home-merch] catalog fetch failed', e);
    if (!cached) message(container, SOLD_OUT_MSG);
    return;
  }
  const products = catalog.products || [];
  if (!products.length) {
    if (!cached) message(container, SOLD_OUT_MSG);
    return;
  }
  writeCache(products);
  paint(container, products);
}

function init() {
  const container = document.getElementById('merch-marquee');
  if (!container) return;
  build(container);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
