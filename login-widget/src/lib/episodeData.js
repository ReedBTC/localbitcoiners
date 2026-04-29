/**
 * Pull split recipients + episode metadata out of a parsed RSS <item>.
 *
 * The feed is Podcasting 2.0 namespaced — `<podcast:value>` carries the
 * split block, `<podcast:valueRecipient>` carries each leg. CSS selectors
 * treat `:` as a pseudo-class delimiter, so we query by local name and
 * walk children manually rather than `querySelector('podcast:value')`.
 *
 * Channel-level fallback: when an item has no <podcast:value> block of
 * its own, the channel-level block applies. The Local Bitcoiners feed
 * has both (channel default = Reed/Rev/aquafox/Fountain at 33/33/32/2,
 * items override with episode-specific splits). The `source` field on
 * the return value lets the UI label "splits per episode" vs "default
 * show splits" if it ever wants to.
 *
 * Out of scope here: validating amounts. Caller decides whether the
 * total is enough to satisfy each leg's lud16 minSendable — that's a
 * runtime check against the LNURL endpoint at boost time.
 */

/** Find the first child of `el` whose local name matches. */
function firstChild(el, localName) {
  if (!el) return null
  for (const c of el.children) {
    if (c.localName === localName) return c
  }
  return null
}

/** Find all children of `el` whose local name matches. */
function allChildren(el, localName) {
  const out = []
  if (!el) return out
  for (const c of el.children) {
    if (c.localName === localName) out.push(c)
  }
  return out
}

/**
 * Parse a `<podcast:value>` block's recipients into the shape we use
 * downstream. Returns null if the block is missing or has no usable
 * recipients (e.g. the only entries are non-lnaddress types we can't
 * pay through LNURL flows).
 */
function parseValueBlock(valueEl) {
  if (!valueEl) return null
  const recipients = []
  for (const r of allChildren(valueEl, 'valueRecipient')) {
    const type = r.getAttribute('type') || ''
    const address = r.getAttribute('address') || ''
    const name = r.getAttribute('name') || address
    const splitStr = r.getAttribute('split') || ''
    const splitWeight = parseFloat(splitStr)
    // Only lnaddress is supported on web — keysend/node-pubkey requires
    // a paying node that can construct keysend HTLCs from the browser,
    // which NWC doesn't expose. Items with mixed types degrade to
    // lnaddress-only legs; the dropped legs' weight is redistributed
    // implicitly via the proportional math in payAllLegs (we just sum
    // whatever lnaddress weights remain).
    if (type !== 'lnaddress') continue
    if (!address || !Number.isFinite(splitWeight) || splitWeight <= 0) continue
    recipients.push({ name, address, splitWeight, type })
  }
  if (recipients.length === 0) return null
  const totalWeight = recipients.reduce((acc, r) => acc + r.splitWeight, 0)
  return { recipients, totalWeight }
}

/**
 * Parse the splits for an RSS item.
 *
 * @param {Element} itemEl  - parsed <item> Element
 * @param {Element} [channelEl]  - parsed <channel> Element, for fallback
 * @returns {?{ recipients: Array, totalWeight: number, source: 'item'|'channel' }}
 */
export function parseSplits(itemEl, channelEl = null) {
  const itemValue = firstChild(itemEl, 'value')
  const itemBlock = parseValueBlock(itemValue)
  if (itemBlock) return { ...itemBlock, source: 'item' }

  if (channelEl) {
    const chanValue = firstChild(channelEl, 'value')
    const chanBlock = parseValueBlock(chanValue)
    if (chanBlock) return { ...chanBlock, source: 'channel' }
  }
  return null
}

/**
 * Pull the displayable + identifying fields off an <item>.
 * Episode number comes from <itunes:episode>; falls back to extracting
 * "Ep. NNN" from the title if the itunes tag is missing.
 */
export function parseEpisodeMeta(itemEl) {
  const title = firstChild(itemEl, 'title')?.textContent?.trim() || ''
  const guid = firstChild(itemEl, 'guid')?.textContent?.trim() || ''

  let number = null
  const itunesEp = firstChild(itemEl, 'episode')
  if (itunesEp) {
    const n = parseInt(itunesEp.textContent.trim(), 10)
    if (Number.isFinite(n) && n > 0) number = n
  }
  if (number === null) {
    // Fallback: many feeds put "Ep. 003" or "| Ep. 003" in the title.
    const m = title.match(/Ep\.?\s*0*(\d{1,4})/i)
    if (m) number = parseInt(m[1], 10)
  }

  return { number, title, guid }
}

/**
 * Format the episode tag we send in the LNURL comment. Three-digit
 * zero-padded so bots can match on a fixed regex.
 *   8  -> "LocalBitcoinersEp008"
 *   42 -> "LocalBitcoinersEp042"
 */
export function formatEpisodeComment(episodeNumber) {
  const n = parseInt(episodeNumber, 10)
  if (!Number.isFinite(n) || n <= 0) return 'LocalBitcoinersEp000'
  return `LocalBitcoinersEp${String(n).padStart(3, '0')}`
}
