/* Homepage "Recent Boosts" — a continuous horizontal marquee of the real
 * Nostr boost notes (the same cards /boosts and /stats render via
 * boosts-thread.js).
 *
 * Read-only (Scope A): no reply/like/repost/zap bar, and the card's footer
 * (View on Nostr / etc.) is stripped here — clicking a card instead pauses
 * the marquee and opens the full note in a modal to read it whole. The strip
 * flows by like a wall of reviews; hover / focus / drag / swipe takes over.
 *
 * Cheap on first paint: the boost thread fetch (Primal + relays) only fires
 * when the section scrolls into view. Falls back quietly on any failure.
 */
import { fetchBoostThread, renderNoteCard } from '/assets/js/boosts-thread.js';

const BOOSTS_MAX = 15;
const SPEED_PX_S = 55;          // marquee speed; ~a card every few seconds

// Set while the read modal is open so the marquee tick stays paused.
let modalOpen = false;

function emptyState(container, msg) {
  const p = document.createElement('p');
  p.className = 'boost-empty';
  p.textContent = msg;
  container.replaceChildren(p);
}

function makeItem(ev, isDupe) {
  const item = document.createElement('div');
  item.className = 'boost-marquee-item' + (isDupe ? ' is-dupe' : '');
  if (isDupe) item.setAttribute('aria-hidden', 'true');
  const card = renderNoteCard(ev);
  // Drop the built-in footer (View on Nostr / Copy) — reading happens in
  // the modal now.
  card.querySelector('.note-footer')?.remove();
  item.appendChild(card);
  item.__ev = ev; // looked up on click to open the read modal
  return item;
}

// ── read modal: full, un-clipped note ────────────────────────────────
let escHandler = null;
function closeModal(overlay) {
  overlay.classList.remove('open');
  modalOpen = false;
  document.body.style.overflow = '';
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  setTimeout(() => overlay.remove(), 150);
}
function openBoostModal(ev) {
  modalOpen = true;
  document.body.style.overflow = 'hidden';
  const overlay = document.createElement('div');
  overlay.className = 'lb-boost-read-overlay';

  const modal = document.createElement('div');
  modal.className = 'lb-boost-read-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lb-boost-read-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', () => closeModal(overlay));
  modal.appendChild(close);

  // Fresh, full card (no height clamp here, so the whole note shows).
  modal.appendChild(renderNoteCard(ev));

  overlay.appendChild(modal);
  // Backdrop click closes; clicks inside the modal don't.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
  escHandler = (e) => { if (e.key === 'Escape') closeModal(overlay); };
  document.addEventListener('keydown', escHandler);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

// Auto-scroll the strip rightward at a constant px/sec, looping seamlessly,
// while letting the user take over: hover/focus pauses it, and the strip is
// a real scroll container so click-drag (mouse) and swipe (touch) scrub it.
// Auto-scroll resumes a couple seconds after the user stops interacting.
function startMarquee(el) {
  const reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // One set's width = half the total (two identical sets). Recompute as
  // images load + on resize. Seamlessness is width-independent (clones).
  let setWidth = 0;
  const measure = () => { setWidth = el.scrollWidth / 2; };
  measure();
  el.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', measure, { once: true });
  });
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure, { once: true });

  const wrap = () => {
    if (setWidth <= 0) return;
    if (el.scrollLeft >= setWidth) el.scrollLeft -= setWidth;
    else if (el.scrollLeft < 0) el.scrollLeft += setWidth;
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
  // Touch swipe / trackpad scroll use native scrolling — just pause auto
  // while the user is doing it.
  el.addEventListener('wheel', markActive, { passive: true });
  el.addEventListener('touchstart', markActive, { passive: true });
  el.addEventListener('touchmove', markActive, { passive: true });

  // Mouse click-drag to scrub. Don't hijack clicks that land on a link or
  // button, and only treat it as a drag once the pointer actually moves.
  // Uses incremental deltas (+ wrap each move) so dragging across the loop
  // boundary stays smooth instead of fighting the wrap.
  let startX = 0, lastX = 0, armed = false, dragPointerId = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.target.closest('a, button')) return;
    armed = true; dragging = false; dragMoved = false;
    startX = e.clientX; lastX = e.clientX; dragPointerId = e.pointerId;
    // NB: don't capture the pointer here — capturing on every mousedown
    // redirects the follow-up click's target off the card and breaks the
    // click-to-open-modal. We only capture once a real drag begins.
  });
  el.addEventListener('pointermove', (e) => {
    if (!armed) return;
    if (!dragging && Math.abs(e.clientX - startX) > 3) {
      dragging = true; dragMoved = true;
      try { el.setPointerCapture(dragPointerId); } catch (err) {}
      el.classList.add('is-grabbing');
    }
    if (dragging) {
      el.scrollLeft -= e.clientX - lastX;
      wrap();
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

  // A genuine click (no drag) on a card opens it in the read modal.
  el.addEventListener('click', (e) => {
    if (dragMoved) return;
    if (e.target.closest('a, button')) return;
    const item = e.target.closest('.boost-marquee-item');
    if (item && item.__ev) openBoostModal(item.__ev);
  });

  if (reduce) return; // manual scroll only; no auto motion

  const SPEED = SPEED_PX_S;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!(hovering || focused || dragging || modalOpen || !idle)) el.scrollLeft += SPEED * dt;
    wrap();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function build(container) {
  let result;
  try {
    result = await fetchBoostThread();
  } catch (e) {
    console.warn('[home-boosts] thread fetch failed', e);
    emptyState(container, 'Couldn’t load boosts right now — see them all on /boosts.');
    return;
  }
  if (!result || result.error || !result.rootEvent) {
    emptyState(container, 'Couldn’t load boosts right now — see them all on /boosts.');
    return;
  }

  // Direct children of the root are the boost notes, newest-first.
  const boosts = (result.childrenOf.get(result.rootEvent.id) || []).slice(0, BOOSTS_MAX);
  if (!boosts.length) { emptyState(container, 'No boosts yet — be the first!'); return; }

  // Two identical sets (A then a dupe B) laid out in the scroll row, so
  // wrapping scrollLeft by one set width loops seamlessly. Rendered fresh
  // (not cloned) so each item carries its own __ev for the click handler.
  const frag = document.createDocumentFragment();
  for (const ev of boosts) frag.appendChild(makeItem(ev, false));
  for (const ev of boosts) frag.appendChild(makeItem(ev, true));
  container.replaceChildren(frag);

  requestAnimationFrame(() => startMarquee(container));
}

// ── lazy init when the section nears the viewport ──────────────────────
function init() {
  const container = document.getElementById('boost-marquee');
  if (!container) return;
  const section = document.getElementById('boosts-preview') || container;

  let started = false;
  const start = () => { if (started) return; started = true; build(container); };

  if (!('IntersectionObserver' in window)) { start(); return; }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { start(); io.disconnect(); break; }
    }
  }, { rootMargin: '300px 0px' });
  io.observe(section);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
