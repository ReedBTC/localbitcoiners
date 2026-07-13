/* Shared boost mutation handlers.
 *
 * Builds the per-card action bar (Reply / Repost / Like / Zap), wires
 * each button to the matching Nostr publish flow via window.LBLogin,
 * and runs the lazy hydration that paints "you already liked / reposted
 * this" state once the user signs in.
 *
 * Module-level state is intentional: the action handlers mutate the
 * thread's childrenOf map (optimistic insert on reply) and ask the host
 * page to repaint via the rerender callback passed to
 * configureBoostActions(). Both /boosts.html and /ep### import this
 * module — they share its singletons, so a like on the episode page
 * stays "liked" if the user navigates to the full boosts feed.
 */
import {
  STATIC_RELAYS,
  configureBoostsThread,
  fetchProfilesFromPrimal,
  getCachedProfile,
  setCachedProfile,
  registerEvent,
} from '/assets/js/boosts-thread.js'
import { nip19 } from '/assets/widgets/nostr-tools.js'

// ── Module state ─────────────────────────────────────────────────────
const state = {
  rootEvent: null,        // boost mega-thread root (NIP-10 'root' marker target)
  childrenOf: new Map(),  // shared with the host page's view of the thread
}
let rerenderFn = null     // page-supplied: triggered after optimistic mutations

const likedIds    = new Set()  // event ids the signed-in user has liked (lc)
const repostedIds = new Set()  // event ids the signed-in user has reposted (lc)
let likesHydrated   = false
let repostsHydrated = false
let lastUserPubkey  = null     // detect login switches → re-hydrate

let hydrationBound = false     // bindUserStateHydration runs once total

// ── Public API ───────────────────────────────────────────────────────
export function configureBoostActions({ rootEvent, childrenOf, rerender } = {}) {
  if (rootEvent)  state.rootEvent  = rootEvent
  if (childrenOf) state.childrenOf = childrenOf
  if (typeof rerender === 'function') rerenderFn = rerender

  // Make the renderer attach our action bar to every non-root card.
  configureBoostsThread({ actionsBuilder: buildActionBar })

  // Start LBLogin onChange wiring + initial hydration. Idempotent.
  if (!hydrationBound) {
    hydrationBound = true
    bindUserStateHydration()
  }
}

function rerender() {
  if (typeof rerenderFn === 'function') rerenderFn()
}

// ── Login state hydration (likes + reposts the user has already sent) ─
async function hydrateUserLikes() {
  const user = window.LBLogin?.getUser?.()
  if (!user || !user.pubkey) return
  if (likesHydrated && lastUserPubkey === user.pubkey) return
  likedIds.clear()
  try {
    const ndk = window.LBLogin.getNDK()
    const events = await ndk.fetchEvents({
      kinds: [7], authors: [user.pubkey], limit: 500,
    })
    for (const ev of events) {
      if (ev.content === '-') continue   // explicit dislike per NIP-25
      const eTags = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || ''))
      const target = eTags[eTags.length - 1]
      if (target) likedIds.add(target[1].toLowerCase())
    }
  } catch (e) {
    console.warn('[boost-actions] like hydration failed', e)
  }
  likesHydrated = true
  document.querySelectorAll('button.like-btn').forEach(btn => {
    const id = btn.dataset.noteId
    if (id && likedIds.has(id)) {
      btn.setAttribute('aria-pressed', 'true')
      const icon = btn.querySelector('.lb-icon')
      if (icon) icon.textContent = '♥'
    }
  })
}

async function hydrateUserReposts() {
  const user = window.LBLogin?.getUser?.()
  if (!user || !user.pubkey) return
  if (repostsHydrated && lastUserPubkey === user.pubkey) return
  repostedIds.clear()
  try {
    const ndk = window.LBLogin.getNDK()
    const events = await ndk.fetchEvents({
      kinds: [6], authors: [user.pubkey], limit: 500,
    })
    for (const ev of events) {
      // NIP-18: the reposted note's id is in the e-tag.
      const eTags = (ev.tags || []).filter(t => t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || ''))
      const target = eTags[eTags.length - 1]
      if (target) repostedIds.add(target[1].toLowerCase())
    }
  } catch (e) {
    console.warn('[boost-actions] repost hydration failed', e)
  }
  repostsHydrated = true
  document.querySelectorAll('button.repost-btn').forEach(btn => {
    const id = btn.dataset.noteId
    if (id && repostedIds.has(id)) {
      btn.setAttribute('aria-pressed', 'true')
    }
  })
}

function bindUserStateHydration() {
  if (window.LBLogin?.onChange) {
    window.LBLogin.onChange((u) => {
      if (u) {
        lastUserPubkey = u.pubkey
        hydrateUserLikes()
        hydrateUserReposts()
      } else {
        likesHydrated   = false
        repostsHydrated = false
        lastUserPubkey  = null
        likedIds.clear()
        repostedIds.clear()
        document.querySelectorAll('button.like-btn[aria-pressed="true"]').forEach(btn => {
          btn.setAttribute('aria-pressed', 'false')
          const icon = btn.querySelector('.lb-icon')
          if (icon) icon.textContent = '♡'
        })
        document.querySelectorAll('button.repost-btn[aria-pressed="true"]').forEach(btn => {
          btn.setAttribute('aria-pressed', 'false')
        })
      }
    })
    if (window.LBLogin.getUser?.()) {
      lastUserPubkey = window.LBLogin.getUser().pubkey
      hydrateUserLikes()
      hydrateUserReposts()
    }
  } else {
    // Bounded poll — give the widget bundle ~10s to evaluate (covers a
    // slow connection or a CDN blip), then give up. Without this cap
    // the interval ran every 200ms for the page lifetime if the widget
    // script never loaded (404, AdBlock removing it, etc.).
    let attempts = 0
    const MAX_ATTEMPTS = 50  // 50 × 200ms = 10s
    const wait = setInterval(() => {
      if (window.LBLogin?.onChange) {
        clearInterval(wait)
        bindUserStateHydration()
      } else if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(wait)
        console.warn('[boost-actions] login widget never appeared; hydration disabled')
      }
    }, 200)
  }
}

function ensureLoggedIn() {
  if (window.LBLogin?.getUser?.()) return true
  window.LBLogin?.requestLogin?.()
  return false
}

// ── Action bar ───────────────────────────────────────────────────────
export function buildActionBar(ev, cardEl) {
  const bar = document.createElement('div')
  bar.className = 'note-actions'

  const replyBtn = document.createElement('button')
  replyBtn.type = 'button'
  replyBtn.title = 'Reply'
  replyBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">💬</span><span>Reply</span>'
  replyBtn.addEventListener('click', () => toggleReplyComposer(ev, cardEl))
  bar.appendChild(replyBtn)

  const repostBtn = document.createElement('button')
  repostBtn.type = 'button'
  repostBtn.className = 'repost-btn'
  repostBtn.dataset.noteId = ev.id.toLowerCase()
  repostBtn.title = 'Repost'
  const isReposted = repostedIds.has(ev.id.toLowerCase())
  repostBtn.setAttribute('aria-pressed', isReposted ? 'true' : 'false')
  repostBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">🔁</span><span>Repost</span>'
  repostBtn.addEventListener('click', () => handleRepost(ev, repostBtn))
  bar.appendChild(repostBtn)

  const likeBtn = document.createElement('button')
  likeBtn.type = 'button'
  likeBtn.className = 'like-btn'
  likeBtn.dataset.noteId = ev.id.toLowerCase()
  likeBtn.title = 'Like'
  const isLiked = likedIds.has(ev.id.toLowerCase())
  likeBtn.setAttribute('aria-pressed', isLiked ? 'true' : 'false')
  likeBtn.innerHTML = `<span class="lb-icon" aria-hidden="true">${isLiked ? '♥' : '♡'}</span><span>Like</span>`
  likeBtn.addEventListener('click', () => handleLike(ev, likeBtn))
  bar.appendChild(likeBtn)

  const zapBtn = document.createElement('button')
  zapBtn.type = 'button'
  zapBtn.title = 'Zap'
  zapBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">⚡</span><span>Zap</span>'
  zapBtn.addEventListener('click', () => openZapModal(ev))
  bar.appendChild(zapBtn)

  // Kebab (⋮) menu — lives in the card's author row (top-right), not the
  // action bar, so it reads as a card-level overflow menu. Its only item
  // copies the note's nevent. The author row already exists by the time
  // the renderer invokes this builder.
  const authorRow = cardEl.querySelector('.note-author')
  if (authorRow) authorRow.appendChild(buildMoreMenu(ev))

  return bar
}

// ── Per-card overflow (⋮) menu ───────────────────────────────────────
function buildMoreMenu(ev) {
  const wrap = document.createElement('div')
  wrap.className = 'note-more'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'note-more-btn'
  btn.title = 'More'
  btn.setAttribute('aria-label', 'More options')
  btn.setAttribute('aria-haspopup', 'true')
  btn.setAttribute('aria-expanded', 'false')
  btn.innerHTML = '<span class="lb-icon" aria-hidden="true">⋮</span>'
  wrap.appendChild(btn)

  const menu = document.createElement('div')
  menu.className = 'note-more-menu'
  menu.hidden = true

  const copyItem = document.createElement('button')
  copyItem.type = 'button'
  copyItem.className = 'note-more-item'
  copyItem.textContent = 'Copy nevent'
  copyItem.addEventListener('click', () => {
    closeMenu()
    copyNevent(ev)
  })
  menu.appendChild(copyItem)
  wrap.appendChild(menu)

  function onDocPointer(e) { if (!wrap.contains(e.target)) closeMenu() }
  function onKey(e) { if (e.key === 'Escape') closeMenu() }
  function openMenu() {
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDocPointer, true)
    document.addEventListener('keydown', onKey)
  }
  function closeMenu() {
    menu.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDocPointer, true)
    document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()  // don't trip the outside-click handler we just bound
    if (menu.hidden) openMenu()
    else closeMenu()
  })

  return wrap
}

async function copyNevent(ev) {
  let nevent = ''
  try { nevent = nip19.neventEncode({ id: ev.id, author: ev.pubkey }) } catch {}
  if (!nevent) { showToast('Could not build nevent', true); return }
  if (await copyText(nevent)) showToast('nevent copied')
  else showToast('Copy failed — clipboard blocked', true)
}

// navigator.clipboard only exists in secure contexts (HTTPS / localhost),
// so it's unavailable on plain-HTTP LAN previews and when a page blocks
// clipboard permissions. Try it first, then fall back to the legacy
// execCommand('copy') path (runs fine inside this click gesture).
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true } catch {}
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ── Reply ────────────────────────────────────────────────────────────
function toggleReplyComposer(parent, cardEl) {
  if (!ensureLoggedIn()) return

  // Toggle off if already open under this card.
  const existing = cardEl.querySelector(':scope > .reply-composer')
  if (existing) { existing.remove(); return }

  const composer = document.createElement('div')
  composer.className = 'reply-composer'

  const ta = document.createElement('textarea')
  ta.placeholder = 'Reply on Nostr…'
  composer.appendChild(ta)

  const actions = document.createElement('div')
  actions.className = 'rc-actions'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'rc-cancel'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => composer.remove())
  actions.appendChild(cancel)

  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'rc-send'
  send.textContent = 'Send Reply'
  send.addEventListener('click', () => sendReply(parent, ta.value, send, composer))
  actions.appendChild(send)

  composer.appendChild(actions)
  cardEl.appendChild(composer)
  ta.focus()
}

function buildReplyTags(parent) {
  const rootId = state.rootEvent?.id
  const tags = []
  // Root e-tag (NIP-10 marked). If parent IS the root, only emit the
  // root marker — emitting both root + reply on the same id confuses
  // clients.
  if (rootId) tags.push(['e', rootId, '', 'root'])
  if (parent.id !== rootId) {
    tags.push(['e', parent.id, '', 'reply'])
  }
  // p tags: every p tag from the parent + the parent's own pubkey,
  // deduplicated.
  const seenP = new Set()
  for (const t of parent.tags || []) {
    if (t[0] === 'p' && t[1] && !seenP.has(t[1])) {
      seenP.add(t[1])
      tags.push(['p', t[1]])
    }
  }
  if (parent.pubkey && !seenP.has(parent.pubkey)) {
    tags.push(['p', parent.pubkey])
  }
  tags.push(['client', 'localbitcoiners.com'])
  return tags
}

async function sendReply(parent, content, sendBtn, composer) {
  const text = (content || '').trim()
  if (!text) return
  if (!ensureLoggedIn()) return
  sendBtn.disabled = true
  sendBtn.textContent = 'Sending…'
  try {
    const signed = await window.LBLogin.signAndPublish({
      kind: 1,
      content: text,
      tags: buildReplyTags(parent),
    })
    // Defence-in-depth: validate the widget actually returned a
    // well-formed signed event before we splice it into the thread
    // and cache it. A future widget bug returning a forged event
    // (wrong kind, alien pubkey, missing id) would otherwise paint
    // attacker content under the user's npub.
    const expectedPubkey = window.LBLogin.getUser?.()?.pubkey
    if (
      !signed
      || typeof signed.id !== 'string'
      || !/^[0-9a-f]{64}$/i.test(signed.id)
      || typeof signed.sig !== 'string'
      || signed.kind !== 1
      || typeof signed.content !== 'string'
      || (expectedPubkey && signed.pubkey !== expectedPubkey)
    ) {
      throw new Error('signed event from widget failed shape validation')
    }
    // Make sure the user's profile is in the cache for the new card.
    const user = window.LBLogin.getUser?.()
    if (user?.pubkey && !getCachedProfile(user.pubkey)) {
      setCachedProfile(user.pubkey, {
        name:    user?.profile?.displayName || user?.profile?.name || '',
        picture: user?.profile?.image || user?.profile?.picture || null,
        nip05:   user?.profile?.nip05 || '',
        lud16:   user?.profile?.lud16 || '',
      })
    }
    // Optimistic insert under the parent — newest first.
    const list = state.childrenOf.get(parent.id) || []
    list.unshift(signed)
    state.childrenOf.set(parent.id, list)
    registerEvent(signed)
    composer.remove()
    rerender()
    showToast('Reply posted')
  } catch (e) {
    sendBtn.disabled = false
    sendBtn.textContent = 'Send Reply'
    showToast('Reply failed: ' + (e?.message || 'unknown'), true)
  }
}

// ── Like (NIP-25 kind 7) ─────────────────────────────────────────────
async function handleLike(ev, btn) {
  if (!ensureLoggedIn()) return
  const id = ev.id.toLowerCase()
  if (likedIds.has(id)) return       // already liked — no-op (no unlike yet)

  likedIds.add(id)
  btn.setAttribute('aria-pressed', 'true')
  const icon = btn.querySelector('.lb-icon')
  if (icon) icon.textContent = '♥'

  try {
    // Addressable targets (kind 30000–39999, e.g. long-form 30023) carry an
    // `a` coordinate alongside the `e` id, and the real `k`. Kind-1 stays
    // byte-identical to before (no `a`, k='1').
    const kind = ev.kind || 1
    const isAddressable = kind >= 30000 && kind < 40000
    const tags = [['e', ev.id]]
    if (isAddressable && ev.dTag) tags.push(['a', `${kind}:${ev.pubkey}:${ev.dTag}`])
    tags.push(['p', ev.pubkey], ['k', String(kind)], ['client', 'localbitcoiners.com'])
    await window.LBLogin.signAndPublish({ kind: 7, content: '+', tags })
  } catch (e) {
    likedIds.delete(id)
    btn.setAttribute('aria-pressed', 'false')
    if (icon) icon.textContent = '♡'
    showToast('Like failed: ' + (e?.message || 'unknown'), true)
  }
}

// ── Repost (NIP-18 kind 6, plain — no quote/q-tag) ───────────────────
// Single-shot: once reposted we lock the button. Un-reposting would
// require publishing a kind 5 deletion which is out of scope here.
async function handleRepost(ev, btn) {
  if (!ensureLoggedIn()) return
  const id = ev.id.toLowerCase()
  if (repostedIds.has(id)) return

  repostedIds.add(id)
  btn.setAttribute('aria-pressed', 'true')

  try {
    // NIP-18 best practice: stringify the original event into content
    // so consumers can render the repost without a separate fetch.
    let content = ''
    if (ev.id && ev.pubkey && ev.sig) {
      try {
        content = JSON.stringify({
          id:         ev.id,
          pubkey:     ev.pubkey,
          created_at: ev.created_at,
          kind:       ev.kind,
          tags:       Array.isArray(ev.tags) ? ev.tags : [],
          content:    ev.content || '',
          sig:        ev.sig,
        })
      } catch { content = '' }
    }
    // NIP-18: kind-6 reposts kind-1 only; any other kind uses the generic
    // kind-16, and addressable targets add an `a` coordinate. Kind-1 stays
    // byte-identical (kind 6, no `a`).
    const kind = ev.kind || 1
    const isAddressable = kind >= 30000 && kind < 40000
    const tags = [['e', ev.id, '']]
    if (isAddressable && ev.dTag) tags.push(['a', `${kind}:${ev.pubkey}:${ev.dTag}`, ''])
    tags.push(['p', ev.pubkey], ['k', String(kind)], ['client', 'localbitcoiners.com'])
    await window.LBLogin.signAndPublish({
      kind: kind === 1 ? 6 : 16,
      content,
      tags,
    })
    showToast('Reposted')
  } catch (e) {
    repostedIds.delete(id)
    btn.setAttribute('aria-pressed', 'false')
    showToast('Repost failed: ' + (e?.message || 'unknown'), true)
  }
}

// Generic repost usable for non-kind-1 events (e.g. NIP-52 calendar
// events). NIP-18: kind 6 reposts kind-1 only; everything else uses the
// generic kind 16, which carries a `k` tag for the reposted kind and —
// for addressable (parameterized replaceable) events — an `a` coordinate
// alongside the `e` id. Exposed so the shared calendar renderer can offer
// a Renote button without duplicating the publish flow.
//
// NOTE: hydrateUserReposts() only reads kind-6, so a calendar renote's
// "already reposted" state won't repaint on reload yet — cosmetic only.
export async function repostAnyEvent(ev, btn) {
  if (!ensureLoggedIn()) return
  const id = (ev.id || '').toLowerCase()
  if (!id || !ev.pubkey) { showToast('Nothing to repost', true); return }
  if (repostedIds.has(id)) return

  repostedIds.add(id)
  if (btn) btn.setAttribute('aria-pressed', 'true')

  try {
    const kind = ev.kind || 1
    const isAddressable = kind >= 30000 && kind < 40000
    const tags = [['e', ev.id, '']]
    if (isAddressable && ev.dTag) {
      tags.push(['a', `${kind}:${ev.pubkey}:${ev.dTag}`, ''])
    }
    tags.push(['p', ev.pubkey], ['k', String(kind)], ['client', 'localbitcoiners.com'])

    await window.LBLogin.signAndPublish({
      kind: kind === 1 ? 6 : 16,
      content: '',
      tags,
    })
    showToast('Renoted')
  } catch (e) {
    repostedIds.delete(id)
    if (btn) btn.setAttribute('aria-pressed', 'false')
    showToast('Renote failed: ' + (e?.message || 'unknown'), true)
  }
}

// ── Zap (NIP-57) ─────────────────────────────────────────────────────
export async function openZapModal(targetEvent) {
  if (!ensureLoggedIn()) return

  let profile = getCachedProfile(targetEvent.pubkey)
  if (!profile?.lud16 && !profile?.lud06) {
    try {
      const more = await fetchProfilesFromPrimal([targetEvent.pubkey])
      const fresh = more.get(targetEvent.pubkey)
      if (fresh) {
        setCachedProfile(targetEvent.pubkey, fresh)
        profile = getCachedProfile(targetEvent.pubkey) || fresh
      }
    } catch {}
  }
  if (!profile?.lud16 && !profile?.lud06) {
    showToast('This user hasn\'t set a Lightning address', true)
    return
  }
  if (!profile.lud16 && profile.lud06) {
    showToast('lud06-only profile — zap on njump.me instead', true)
    return
  }

  document.body.appendChild(buildZapModal(targetEvent, profile))
}

function buildZapModal(targetEvent, recipientProfile) {
  const backdrop = document.createElement('div')
  backdrop.className = 'zap-backdrop'
  const modal = document.createElement('div')
  modal.className = 'zap-modal'
  backdrop.appendChild(modal)

  const close = () => backdrop.remove()
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close() })
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) }
  })

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'zap-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', close)
  modal.appendChild(closeBtn)

  const h = document.createElement('h3')
  h.textContent = 'Zap this boost'
  modal.appendChild(h)

  const recRow = document.createElement('div')
  recRow.className = 'zap-recipient'
  const pic = document.createElement('img')
  pic.src = recipientProfile.picture || '/assets/LocalBitcoiners.png'
  pic.alt = ''
  pic.referrerPolicy = 'no-referrer'
  pic.onerror = () => { pic.src = '/assets/LocalBitcoiners.png' }
  recRow.appendChild(pic)
  // No innerHTML on attacker-controlled fields (display name, lud16).
  const recName = document.createElement('div')
  const dispName = recipientProfile.name || (targetEvent.pubkey.slice(0, 8) + '…')
  const nameStrong = document.createElement('strong')
  nameStrong.style.color = 'var(--navy)'
  nameStrong.textContent = dispName
  recName.appendChild(nameStrong)
  recName.appendChild(document.createElement('br'))
  const lnSpan = document.createElement('span')
  lnSpan.style.fontSize = '0.78rem'
  lnSpan.style.color = 'var(--muted)'
  lnSpan.textContent = recipientProfile.lud16 || ''
  recName.appendChild(lnSpan)
  recRow.appendChild(recName)
  modal.appendChild(recRow)

  const amountLabel = document.createElement('label')
  amountLabel.textContent = 'Amount (sats)'
  modal.appendChild(amountLabel)

  const presets = document.createElement('div')
  presets.className = 'zap-amounts'
  const presetVals = [21, 100, 500, 1000, 5000, 21000]
  let selectedSats = 100
  const presetButtons = []
  for (const v of presetVals) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = v.toLocaleString()
    if (v === selectedSats) b.classList.add('is-active')
    b.addEventListener('click', () => {
      selectedSats = v
      amountInput.value = ''
      presetButtons.forEach(pb => pb.classList.toggle('is-active', pb === b))
    })
    presetButtons.push(b)
    presets.appendChild(b)
  }
  modal.appendChild(presets)

  const amountInput = document.createElement('input')
  amountInput.type = 'number'
  amountInput.min = '1'
  amountInput.placeholder = 'Custom amount'
  amountInput.addEventListener('input', () => {
    const n = parseInt(amountInput.value, 10)
    if (Number.isFinite(n) && n > 0) {
      selectedSats = n
      presetButtons.forEach(pb => pb.classList.remove('is-active'))
    }
  })
  modal.appendChild(amountInput)

  const msgLabel = document.createElement('label')
  msgLabel.textContent = 'Message (optional)'
  modal.appendChild(msgLabel)

  const msgInput = document.createElement('textarea')
  msgInput.placeholder = 'Onward and upward!'
  modal.appendChild(msgInput)

  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'zap-submit'
  submit.textContent = '⚡ Send Zap'
  modal.appendChild(submit)

  const status = document.createElement('div')
  status.className = 'zap-status'
  modal.appendChild(status)

  const invoiceWrap = document.createElement('div')
  modal.appendChild(invoiceWrap)

  submit.addEventListener('click', async () => {
    submit.disabled = true
    status.classList.remove('is-error')
    status.textContent = 'Resolving Lightning address…'
    invoiceWrap.innerHTML = ''
    try {
      const sats = Math.max(1, parseInt(selectedSats, 10) || 0)
      if (!sats) throw new Error('Pick an amount')
      const result = await performZap({
        recipientLud16: recipientProfile.lud16,
        recipientPubkey: targetEvent.pubkey,
        targetEvent,
        amountSats: sats,
        message: msgInput.value || '',
        onStatus: (msg) => { status.textContent = msg },
      })
      if (result.paid) {
        status.classList.remove('is-error')
        status.textContent = '✅ Zap sent!'
        submit.style.display = 'none'
        setTimeout(close, 1800)
      } else {
        status.textContent = 'Pay this invoice with your Lightning wallet:'
        invoiceWrap.appendChild(buildInvoiceBlock(result.invoice))
        submit.style.display = 'none'
      }
    } catch (e) {
      status.classList.add('is-error')
      status.textContent = e?.message || 'Zap failed'
      submit.disabled = false
    }
  })

  return backdrop
}

// Defence against a hostile lud16 returning a non-bolt11 string we'd
// otherwise concatenate into the lightning: href verbatim. BOLT11 HRP
// is `lnbc` (mainnet), `lntb` (testnet), `lnbcrt` (regtest), `lnsb`
// (simnet). Anything else: refuse to expose as a clickable wallet
// link — the textarea still shows it.
function isBolt11Invoice(s) {
  return typeof s === 'string' && /^ln(bc|tb|bcrt|sb)[0-9a-z]+$/i.test(s)
}

function buildInvoiceBlock(invoice) {
  const wrap = document.createElement('div')
  wrap.className = 'zap-invoice'

  const ta = document.createElement('textarea')
  ta.readOnly = true
  ta.value = invoice
  wrap.appendChild(ta)

  const actions = document.createElement('div')
  actions.className = 'zap-invoice-actions'

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.textContent = 'Copy invoice'
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(invoice)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy invoice' }, 1500)
    } catch {
      ta.select()
    }
  })
  actions.appendChild(copyBtn)

  if (isBolt11Invoice(invoice)) {
    const open = document.createElement('a')
    open.href = `lightning:${invoice}`
    open.textContent = 'Open in wallet'
    actions.appendChild(open)
  }

  wrap.appendChild(actions)
  return wrap
}

async function performZap({
  recipientLud16, recipientPubkey, targetEvent, amountSats, message, onStatus,
}) {
  // 1. Resolve LNURL pay endpoint from lud16 (Lightning Address).
  const [name, domain] = recipientLud16.split('@')
  if (!name || !domain) throw new Error('Invalid Lightning address')
  const lnurlEndpoint = `https://${domain}/.well-known/lnurlp/${name}`

  onStatus?.('Fetching pay request…')
  const lnurlResp = await fetch(lnurlEndpoint).catch(() => null)
  if (!lnurlResp || !lnurlResp.ok) throw new Error('Could not reach Lightning address')
  const lnurlInfo = await lnurlResp.json().catch(() => null)
  if (!lnurlInfo) throw new Error('Invalid pay request response')
  if (lnurlInfo.status === 'ERROR') throw new Error(lnurlInfo.reason || 'LNURL error')
  if (lnurlInfo.tag !== 'payRequest') throw new Error('Endpoint is not a pay request')
  if (!lnurlInfo.allowsNostr) throw new Error('Recipient hasn\'t enabled Nostr zaps')
  if (!lnurlInfo.callback) throw new Error('No callback URL in pay request')

  const msats = amountSats * 1000
  if (lnurlInfo.minSendable && msats < lnurlInfo.minSendable) {
    throw new Error(`Min ${Math.ceil(lnurlInfo.minSendable / 1000)} sats`)
  }
  if (lnurlInfo.maxSendable && msats > lnurlInfo.maxSendable) {
    throw new Error(`Max ${Math.floor(lnurlInfo.maxSendable / 1000)} sats`)
  }

  // 2. Build + sign the kind 9734 zap request. NIP-57: this never gets
  // published to relays — we hand it to the LNURL callback so the
  // recipient's wallet can attach a kind 9735 receipt to its invoice
  // settlement.
  onStatus?.('Signing zap request…')
  const zapRequest = await window.LBLogin.signEvent({
    kind: 9734,
    content: message || '',
    tags: [
      ['relays', ...STATIC_RELAYS],
      ['amount', String(msats)],
      ['p', recipientPubkey],
      ['e', targetEvent.id],
      ['client', 'localbitcoiners.com'],
    ],
  })

  // 3. Request the invoice from the LNURL callback.
  onStatus?.('Requesting invoice…')
  const cbUrl = new URL(lnurlInfo.callback)
  cbUrl.searchParams.set('amount', String(msats))
  cbUrl.searchParams.set('nostr', JSON.stringify(zapRequest))
  const invResp = await fetch(cbUrl.toString()).catch(() => null)
  if (!invResp || !invResp.ok) throw new Error('Invoice request failed')
  const invJson = await invResp.json().catch(() => null)
  if (!invJson) throw new Error('Invalid invoice response')
  if (invJson.status === 'ERROR') throw new Error(invJson.reason || 'Invoice error')
  const invoice = invJson.pr
  if (!invoice) throw new Error('No invoice returned')

  // 4. Pay. WebLN preferred — falls through to manual on failure /
  // user cancel / no extension.
  if (typeof window !== 'undefined' && window.webln) {
    try {
      onStatus?.('Opening wallet…')
      await window.webln.enable()
      await window.webln.sendPayment(invoice)
      return { paid: true, method: 'webln', invoice }
    } catch (e) {
      console.warn('[zap] WebLN payment failed', e)
    }
  }
  return { paid: false, invoice }
}

// ── Toast ────────────────────────────────────────────────────────────
function showToast(text, isError = false) {
  const t = document.createElement('div')
  t.className = 'lb-toast' + (isError ? ' is-error' : '')
  t.textContent = text
  document.body.appendChild(t)
  requestAnimationFrame(() => t.classList.add('show'))
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 350)
  }, 3000)
}
