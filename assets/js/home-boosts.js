// The homepage's tail: the boost wall, newest first, 25 cards at a time
// behind a Load more button (Reed, 2026-11-08: the boosts page without its
// sort and range, "that way the homepage kind of never ends"). The cards
// are boosts-thread.js's (the booster's own note when the wall record has
// one, the show's otherwise), the action bar boost-actions.js's; sort and
// window read the record's settled time through boost-record.js, never the
// shown note's. No New Member badge: that is the boosts page's by design.
import { fetchBoostThread, renderChildCards, getBoostMeta } from '/assets/js/boosts-thread.js'
import { boostTimeOf } from '/assets/js/boost-record.js'
import { configureBoostActions } from '/assets/js/boost-actions.js'

const PAGE = 25

const $section = document.getElementById('home-boosts')
const $loading = document.getElementById('home-boosts-loading')
const $error = document.getElementById('home-boosts-error')
const $list = document.getElementById('home-boosts-list')
const $more = document.getElementById('home-boosts-more')

const state = { rootEvent: null, childrenOf: new Map(), shown: PAGE }

function boostTime(ev) { return boostTimeOf(ev, getBoostMeta(ev.id)) }

function paint() {
  if (!state.rootEvent) return
  const all = (state.childrenOf.get(state.rootEvent.id) || []).slice().sort((a, b) => boostTime(b) - boostTime(a))
  $loading.style.display = 'none'
  $list.innerHTML = ''
  if (!all.length) {
    $list.appendChild(Object.assign(document.createElement('p'), { className: 'home-boosts-note', textContent: 'No boosts yet.' }))
    $more.hidden = true
    return
  }
  // renderChildCards reads its list from a Map keyed by the parent id; the
  // cards are cached by boosts-thread.js, so a repaint reuses the DOM.
  const page = all.slice(0, state.shown)
  renderChildCards(state.rootEvent.id, new Map([[state.rootEvent.id, page]]), $list)
  $more.hidden = page.length >= all.length
}

$more.addEventListener('click', () => {
  state.shown += PAGE
  paint()
})

async function load() {
  // The action bar's Reply / Like / Zap need the login widget, which the
  // homepage loads lazily; start it alongside the thread fetch so it is up
  // by the time the cards paint (boost-actions polls for it for 10 s).
  try { window.__lbEnsureWidgetLoaded?.()?.catch?.(() => {}) } catch {}
  let painted = false
  try {
    const { rootEvent, childrenOf, error } = await fetchBoostThread({
      onPartial: ({ rootEvent: r, childrenOf: c }) => {
        state.rootEvent = r
        state.childrenOf = c
        configureBoostActions({ rootEvent: r, childrenOf: c, rerender: paint })
        paint()
        painted = true
      },
    })
    if (error || !rootEvent) {
      if (!painted) showError()
      return
    }
    state.rootEvent = rootEvent
    state.childrenOf = childrenOf
    configureBoostActions({ rootEvent, childrenOf, rerender: paint })
    paint()
  } catch (e) {
    console.error('[home-boosts] failed', e)
    if (!painted) showError()
  }
}

function showError() {
  $loading.style.display = 'none'
  $error.style.display = 'block'
}

// Load as the section nears the viewport, like the rails above it.
if ($section && $list && $more) {
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) { io.disconnect(); load() }
    }, { rootMargin: '600px 0px' })
    io.observe($section)
  } else {
    load()
  }
}
