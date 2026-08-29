/* Range + sort controls for module pages (boosts.html). The same two
 * widgets the feeds page and stats.js carry as local copies: a borderless
 * 1W / 1M / All segment, and a "Sort: X ▾" dropdown that closes on
 * outside-click or Escape. Styles are the .pcast-range / .pcast-sort rules
 * each page defines (feeds.html, stats.html, boosts.html) with --accent,
 * --accent-d and --tint set on the wrapping element.
 */

export const RANGE_OPTIONS = [['1w', '1W', 'Last 7 days'], ['1m', '1M', 'Last 30 days'], ['all', 'All', 'All time']]

const DAY_MS = 86400000
export function rangeStartMs(key) {
  if (key === '1w') return Date.now() - 7 * DAY_MS
  if (key === '1m') return Date.now() - 30 * DAY_MS
  return -Infinity
}
export function rangeWindow(key) {
  return key === '1w' ? 'last 7 days' : key === '1m' ? 'last 30 days' : 'all time'
}

export function rangeControl(initialKey, onPick, { label = 'Time range' } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'pcast-range'
  wrap.setAttribute('role', 'group')
  wrap.setAttribute('aria-label', label)
  const btns = RANGE_OPTIONS.map(([key, text, title]) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pcast-range-btn'
    b.textContent = text
    b.title = title
    b.addEventListener('click', () => { setActive(key); onPick(key) })
    wrap.appendChild(b)
    return b
  })
  function setActive(key) {
    btns.forEach((el, i) => {
      const on = RANGE_OPTIONS[i][0] === key
      el.classList.toggle('is-active', on)
      el.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }
  setActive(initialKey)
  return wrap
}

// `options` is [[key, label], …]. `tag` is the prefix inside the button
// ("Sort: ", "View: ").
export function sortControl(options, initialKey, onPick, { tag = 'Sort: ', title = 'Sort' } = {}) {
  const labelFor = (k) => (options.find((o) => o[0] === k) || options[0])[1]
  const wrap = document.createElement('div')
  wrap.className = 'pcast-sort'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pcast-sort-btn'
  btn.setAttribute('aria-haspopup', 'true')
  btn.setAttribute('aria-expanded', 'false')
  btn.title = title
  const tagEl = document.createElement('span'); tagEl.className = 'pcast-sort-tag'; tagEl.textContent = tag
  const cur = document.createElement('span'); cur.className = 'pcast-sort-cur'; cur.textContent = labelFor(initialKey)
  const caret = document.createElement('span'); caret.className = 'pcast-sort-caret'; caret.setAttribute('aria-hidden', 'true'); caret.textContent = '▾'
  btn.append(tagEl, cur, caret)

  let activeKey = initialKey
  const menu = document.createElement('div')
  menu.className = 'pcast-sort-menu'
  menu.hidden = true
  const items = options.map(([k, label]) => {
    const it = document.createElement('button')
    it.type = 'button'
    it.className = 'pcast-sort-item'
    it.textContent = label
    it.addEventListener('click', () => { activeKey = k; cur.textContent = label; close(); onPick(k) })
    menu.appendChild(it)
    return it
  })
  wrap.append(btn, menu)

  function refreshActive() { items.forEach((el, i) => el.classList.toggle('is-active', options[i][0] === activeKey)) }
  function onDoc(e) { if (!wrap.contains(e.target)) close() }
  function onKey(e) { if (e.key === 'Escape') close() }
  function open() {
    refreshActive()
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey)
  }
  function close() {
    menu.hidden = true; btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', () => { menu.hidden ? open() : close() })
  return wrap
}
