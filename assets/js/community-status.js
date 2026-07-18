/* Community-status chip — shared by /feeds and /supporters.
 *
 * Tells a visitor where they stand with the Local Bitcoiners community and
 * doubles as the entry point to the two actions that change that standing:
 *
 *   • logged out                → orange "Log in to participate"  → login modal
 *   • logged in, not a member   → orange "Boost the show to join"  → show-boost
 *   • logged in, IS a member    → green  "Community Member" (inert badge)
 *   • just boosted, pending add → green  "Thanks! You'll appear within ~24 hrs"
 *   • resolving either of above  → neutral "Checking membership…"
 *
 * "Member" = the logged-in npub appears in the show's follow packs (the same
 * set that decides whose notes render on /feeds), resolved via supporter-set.js.
 *
 * Reads login state straight from the persisted-session localStorage keys so
 * it never force-loads the ~1MB login widget just to know who you are — the
 * bundle is only pulled (via ensureLoginWidget) when you actually click an
 * action. Styles live in assets/css/community-status.css.
 */
import { resolveSupporters, getCachedSupporters, TIER_META } from '/assets/js/supporter-set.js'
import { ensureLoginWidget } from '/assets/js/widget-loader.js'

// Keys owned by the login widget's sessionPersistence.js — the source of
// truth for "who is logged in" across reloads. Kept in sync with that file.
const SESSION_KEY = 'lb_nostr_session'
const PROFILE_KEY = 'lb_nostr_profile_v1'
// Our own marker: when a not-yet-member boosts, remember it so the chip shows
// the "you'll appear within ~24 hrs" state across reloads until the bot adds
// them to the pack (or the window lapses).
const BOOSTED_KEY = 'lb_cs_boosted_at'
const BOOSTED_WINDOW_MS = 24 * 60 * 60 * 1000

const BOLT_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>'

// ── localStorage reads (all defensive; a bad blob just reads as null) ──
function readPubkey() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    return /^[0-9a-f]{64}$/i.test(p?.pubkey || '') ? p.pubkey.toLowerCase() : null
  } catch { return null }
}

function readCachedImage(pubkey) {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return ''
    const p = JSON.parse(raw)
    if (!p || (p.pubkey || '').toLowerCase() !== pubkey) return ''
    return typeof p.image === 'string' ? p.image : ''
  } catch { return '' }
}

function boostedRecently() {
  try {
    const t = parseInt(localStorage.getItem(BOOSTED_KEY) || '', 10)
    return Number.isFinite(t) && (Date.now() - t) < BOOSTED_WINDOW_MS
  } catch { return false }
}

// ── DOM helpers ──────────────────────────────────────────────────────
function safeImgSrc(url) {
  return /^https?:\/\//i.test(url || '') ? url : ''
}

function makePfp(pubkey, ring) {
  const src = safeImgSrc(liveImage || readCachedImage(pubkey))
  const img = document.createElement('img')
  img.className = 'lb-cstat__pfp'
  // Metallic tier ring around the avatar (bronze/silver/gold); 'none' or
  // absent → plain member border.
  if (ring && ring !== 'none') img.classList.add('lb-cstat__pfp--' + ring)
  img.alt = ''
  if (src) img.src = src
  // A dead avatar URL shouldn't leave a broken-image glyph in the chip.
  img.addEventListener('error', () => { img.style.display = 'none' }, { once: true })
  return img
}

function makeIcon(svg) {
  const span = document.createElement('span')
  span.className = 'lb-cstat__ic'
  span.innerHTML = svg
  return span
}

// ── State: current live values ───────────────────────────────────────
let mount = null
let members = null       // Set<hex> once resolved, else null (still checking)
let tiers = {}           // hex → sat-tier pack slug (for the member badge)
let liveImage = ''       // fresher avatar from LBLogin.getUser(), if loaded

function render() {
  if (!mount) return
  const pubkey = readPubkey()
  mount.innerHTML = ''

  // Logged out — invite to log in (no membership lookup needed).
  if (!pubkey) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'lb-cstat lb-cstat--login'
    btn.setAttribute('data-tip', 'Log in with Nostr to join or interact with the community')
    btn.appendChild(makeIcon(BOLT_SVG))
    btn.appendChild(document.createTextNode('Log in to participate'))
    btn.addEventListener('click', onLoginClick)
    mount.appendChild(btn)
    return
  }

  // Logged in, membership still resolving.
  if (members === null) {
    const div = document.createElement('div')
    div.className = 'lb-cstat lb-cstat--checking'
    div.setAttribute('role', 'status')
    const sp = document.createElement('span')
    sp.className = 'lb-cstat__spinner'
    div.appendChild(sp)
    div.appendChild(document.createTextNode('Checking membership…'))
    mount.appendChild(div)
    return
  }

  // Logged in + a member — inert green badge. Show their sat tier (if any)
  // and ring the avatar bronze/silver/gold for the higher tiers.
  if (members.has(pubkey)) {
    const meta = TIER_META[tiers[pubkey]] || null
    const label = meta ? `Community Member · ${meta.label}` : 'Community Member'
    const div = document.createElement('div')
    div.className = 'lb-cstat lb-cstat--member'
    div.setAttribute('tabindex', '0')
    div.setAttribute('data-tip', 'Your notes appear on the community feeds')
    div.appendChild(makePfp(pubkey, meta ? meta.ring : 'none'))
    div.appendChild(document.createTextNode(label))
    mount.appendChild(div)
    return
  }

  // Logged in, not a member, but boosted recently — pending pack add.
  if (boostedRecently()) {
    const div = document.createElement('div')
    div.className = 'lb-cstat lb-cstat--thanks'
    div.setAttribute('role', 'status')
    div.appendChild(makeIcon(BOLT_SVG))
    div.appendChild(document.createTextNode('Thanks for boosting! You’ll appear within ~24 hrs.'))
    mount.appendChild(div)
    return
  }

  // Logged in, not a member — invite to boost the show.
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'lb-cstat lb-cstat--join'
  btn.setAttribute('data-tip', 'Boost the show to join the community')
  btn.appendChild(makePfp(pubkey))
  btn.appendChild(makeIcon(BOLT_SVG))
  btn.appendChild(document.createTextNode('Boost the show to join the community!'))
  btn.addEventListener('click', onJoinClick)
  mount.appendChild(btn)
}

// ── Click handlers (lazy-load the widget, then drive it) ──────────────
async function onLoginClick() {
  try {
    await ensureLoginWidget()
    window.LBLogin?.requestLogin?.()
  } catch (e) { console.error('[community-status] login widget load failed', e) }
}

async function onJoinClick() {
  try {
    await ensureLoginWidget()
    window.LBLogin?.openShowBoost?.()
  } catch (e) { console.error('[community-status] login widget load failed', e) }
}

// ── Live wiring ──────────────────────────────────────────────────────
// Attach to LBLogin.onChange once the bundle exists (it loads on its own for
// returning users via the nav identity restore, and on any action click).
// Polls briefly rather than forcing the load.
function attachAuthListener() {
  let tries = 0
  const iv = setInterval(() => {
    if (window.LBLogin?.onChange) {
      clearInterval(iv)
      window.LBLogin.onChange((user) => {
        liveImage = (user && user.profile && user.profile.image) || ''
        render()
      })
      // Seed a fresher avatar if the user is already restored.
      try {
        const u = window.LBLogin.getUser?.()
        if (u && u.profile && u.profile.image) liveImage = u.profile.image
      } catch {}
      render()
    } else if (++tries > 40) {
      clearInterval(iv)   // ~20s: nobody logged in, bundle never loaded — fine.
    }
  }, 500)
}

function init() {
  mount = document.getElementById('lb-community-status')
  if (!mount) return

  // Instant paint: seed from the cached member set if we have one, so a
  // returning visitor skips the "Checking…" spinner entirely.
  const cached = getCachedSupporters()
  if (cached && cached.members.length) {
    members = new Set(cached.members.map((h) => h.toLowerCase()))
    tiers = cached.tiers || {}
  }

  render()   // cached → member/join/login now; else → checking (or login)

  // Revalidate in the background and re-evaluate. Ignore an empty result
  // (relay hiccup) so a cached real supporter isn't flipped to "boost to join".
  resolveSupporters()
    .then(({ members: list, tiers: freshTiers }) => {
      if (list && list.length) {
        members = new Set(list.map((h) => h.toLowerCase()))
        tiers = freshTiers || {}
        render()
      }
      // else: keep whatever we have (cache, or null → stays "Checking…").
    })
    .catch((e) => {
      console.warn('[community-status] supporter resolve failed', e)
      // Leave members as-is → cached set stays, or null keeps "Checking…"
      // rather than wrongly telling a real supporter to boost again.
    })

  // A successful show-boost (any leg paid) means the bot will add this npub
  // to the pack within ~24 hrs — remember it and flip to the pending state.
  window.addEventListener('lb:show-boost-settled', (ev) => {
    const d = ev && ev.detail
    if (d && (d.anySucceeded || d.anyUncertain)) {
      try { localStorage.setItem(BOOSTED_KEY, String(Date.now())) } catch {}
      render()
    }
  })

  attachAuthListener()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}
