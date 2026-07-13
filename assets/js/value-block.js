/* Podcasting 2.0 <podcast:value> parser for the external-episode boost flow.
 *
 * DELIBERATELY SEPARATE from index.html's LB value parser. The LB boost path
 * is the site's #1 feature and must not change, so this feature carries its own
 * parser rather than refactoring that one into shared code. The two look
 * similar on purpose; they are allowed to diverge.
 *
 * Differences from the LB parser that matter here:
 *   - Captures customKey / customValue on each recipient (external node
 *     recipients on shared nodes — Alby 696969, Fountain 906608 — need them
 *     for keysend routing; without them the sats hit the shared node but aren't
 *     credited to the right podcaster).
 *   - Prefers the per-EPISODE value block, falling back to the channel block.
 *
 * Input is the raw feed XML (fetched via /api/feed). Returns recipients ready
 * for the boost orchestrator, or null when the episode has no payable value.
 */

// Walk direct element children matching a local name (namespace-prefix
// agnostic — feeds use `podcast:` but we match on localName to be safe).
function childrenByLocalName(el, name) {
  const out = []
  if (!el) return out
  for (const c of el.children) if (c.localName === name) out.push(c)
  return out
}
function firstChildByLocalName(el, name) {
  return childrenByLocalName(el, name)[0] || null
}

// Parse a single <podcast:value> element into recipients. Keeps lnaddress
// (paid via LNURL) and node (paid via keysend) types; drops anything else and
// any recipient without a positive split weight.
function parseValueEl(valueEl) {
  if (!valueEl) return null
  const recipients = []
  for (const r of childrenByLocalName(valueEl, 'valueRecipient')) {
    const type = (r.getAttribute('type') || '').trim()
    const address = (r.getAttribute('address') || '').trim()
    const split = parseFloat(r.getAttribute('split') || '')
    if (type !== 'lnaddress' && type !== 'node') continue
    if (!address || !Number.isFinite(split) || split <= 0) continue
    const rec = {
      name: (r.getAttribute('name') || '').trim(),
      type,
      address,
      splitWeight: split,
      fee: (r.getAttribute('fee') || '').toLowerCase() === 'true',
    }
    const customKey = (r.getAttribute('customKey') || '').trim()
    const customValue = (r.getAttribute('customValue') || '').trim()
    if (customKey && customValue) { rec.customKey = customKey; rec.customValue = customValue }
    recipients.push(rec)
  }
  if (recipients.length === 0) return null
  const totalWeight = recipients.reduce((a, r) => a + r.splitWeight, 0)
  if (totalWeight <= 0) return null
  return { recipients, totalWeight }
}

/**
 * Parse a feed's XML for a given episode's value block.
 *
 * @param {string} xml       Raw feed XML (from /api/feed).
 * @param {string} itemGuid  The episode's RSS <guid> (our item_guid).
 * @returns {{recipients:Array, totalWeight:number, level:'episode'|'channel'}|null}
 *          null when the feed has no payable value block for this episode.
 */
export function parseEpisodeValue(xml, itemGuid) {
  let doc
  try { doc = new DOMParser().parseFromString(String(xml), 'text/xml') }
  catch { return null }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null

  const channel = doc.querySelector('channel') ||
    [...doc.documentElement?.children || []].find((c) => c.localName === 'channel') || null
  if (!channel) return null

  // Locate the matching <item> by its <guid> text.
  let item = null
  if (itemGuid) {
    for (const it of childrenByLocalName(channel, 'item')) {
      const g = firstChildByLocalName(it, 'guid')
      if (g && (g.textContent || '').trim() === String(itemGuid).trim()) { item = it; break }
    }
  }

  // Episode-level value wins; fall back to the channel block.
  const epValue = item ? parseValueEl(firstChildByLocalName(item, 'value')) : null
  if (epValue) return { ...epValue, level: 'episode' }
  const chValue = parseValueEl(firstChildByLocalName(channel, 'value'))
  if (chValue) return { ...chValue, level: 'channel' }
  return null
}

/**
 * Normalize the /api/value proxy response (Podcast Index, the authoritative
 * source) into the same shape parseEpisodeValue returns. PI covers shows whose
 * RSS carries no <podcast:value> at all, so this is the PRIMARY path; the RSS
 * parser above is a fallback when the proxy is unavailable.
 *
 * @param {{level?:string, value?:{recipients?:Array}}} apiResp
 * @returns {{recipients:Array, totalWeight:number, level:string}|null}
 */
export function fromApiValue(apiResp) {
  const recips = apiResp?.value?.recipients
  if (!Array.isArray(recips) || recips.length === 0) return null
  const recipients = []
  for (const d of recips) {
    const type = d.type
    const address = (d.address || '').trim()
    const split = Number(d.split)
    if (type !== 'node' && type !== 'lnaddress') continue
    if (!address || !Number.isFinite(split) || split <= 0) continue
    const rec = { name: (d.name || '').trim(), type, address, splitWeight: split, fee: d.fee === true }
    if (d.customKey && d.customValue) { rec.customKey = String(d.customKey); rec.customValue = String(d.customValue) }
    recipients.push(rec)
  }
  if (recipients.length === 0) return null
  const totalWeight = recipients.reduce((a, r) => a + r.splitWeight, 0)
  if (totalWeight <= 0) return null
  return { recipients, totalWeight, level: apiResp.level || 'feed' }
}

// Per-address redirects applied to external recipients before payment.
// Fountain's 2% boostbot leg is rerouted into our aquafox wallet — our cut for
// letting boosters pay the show from here instead of going to Fountain. Mirrors
// the LB LNADDRESS_OVERRIDES intent but is kept local to this feature.
const EXTERNAL_OVERRIDES = {
  'boostbot@fountain.fm': { name: 'Local Bitcoiners', address: 'aquafox30@primal.net' },
}

/**
 * Apply external recipient overrides. Pure — returns a new array. Merges by
 * weight if a redirect lands on an address that's already a recipient.
 */
export function applyExternalOverrides(recipients) {
  if (!Array.isArray(recipients)) return recipients
  const out = []
  for (const r of recipients) {
    const ov = EXTERNAL_OVERRIDES[(r.address || '').toLowerCase()]
    const next = ov ? { ...r, name: ov.name, address: ov.address, type: 'lnaddress' } : { ...r }
    // Overridden legs pay a plain Lightning address, so drop any node-only
    // custom records that no longer apply.
    if (ov) { delete next.customKey; delete next.customValue }
    const dup = out.find((x) => x.type === next.type && x.address.toLowerCase() === next.address.toLowerCase())
    if (dup) dup.splitWeight += next.splitWeight
    else out.push(next)
  }
  return out
}
