/* The pure half of /api/link-preview: the target check and the Open Graph
 * parse. No fetch, no env, no DOM, so scripts/test-link-preview.mjs can run
 * it in Node, and the Pages Function (functions/api/link-preview.js) imports
 * it by relative path for esbuild to bundle.
 */

const URL_MAX_LEN = 2048
const HTML_SCAN_MAX = 256 * 1024

// Why a preview cannot be fetched for this URL, or null when it can. The
// endpoint fetches whatever it is handed, so the hand-off refuses anything
// that is not a public http(s) host: loopback and private-range literals,
// link-local names, and non-default ports. Cloudflare's runtime refuses
// private addresses on its own as well; this keeps the refusal explicit and
// testable.
export function previewTargetProblem(raw) {
  if (typeof raw !== 'string' || !raw) return 'missing'
  if (raw.length > URL_MAX_LEN) return 'too-long'
  let u
  try { u = new URL(raw) } catch { return 'not-a-url' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme'
  if (u.username || u.password) return 'credentials'
  if (u.port && u.port !== '80' && u.port !== '443') return 'port'
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (/^\[/.test(host) || host.includes(':')) return 'ipv6'
  if (!host || !host.includes('.')) return 'host'
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'host'
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'private-ip'
  }
  return null
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    const b = body.toLowerCase()
    if (b.startsWith('#x')) { const n = parseInt(b.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
    if (b.startsWith('#')) { const n = parseInt(b.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
    return ENTITY_MAP[b] ?? m
  })
}

function clean(s, max) {
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

// Attribute values of one <meta …> tag as a lowercase-keyed object.
function metaAttrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

function httpUrl(raw, base) {
  if (!raw) return ''
  try {
    const u = new URL(decodeEntities(raw).trim(), base)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : ''
  } catch { return '' }
}

// Open Graph first, Twitter cards second, the document's own <title> and
// description last. Only the first HTML_SCAN_MAX characters are read: the
// tags live in <head>, and a page that puts them later than 256 KB in does
// not get a card.
export function parseLinkPreview(html, finalUrl) {
  const src = String(html || '').slice(0, HTML_SCAN_MAX)
  const head = src.replace(/<!--[\s\S]*?-->/g, '')
  const og = {}, tw = {}, plain = {}
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = metaAttrs(m[0])
    const content = a.content
    if (content == null) continue
    const prop = (a.property || '').toLowerCase()
    const name = (a.name || '').toLowerCase()
    if (prop.startsWith('og:')) { if (!(prop in og)) og[prop] = content }
    else if (name.startsWith('twitter:')) { if (!(name in tw)) tw[name] = content }
    else if (name === 'description') { if (!plain.description) plain.description = content }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = clean(og['og:title'] || tw['twitter:title'] || (titleTag ? titleTag[1] : ''), 160)
  const description = clean(og['og:description'] || tw['twitter:description'] || plain.description || '', 280)
  const image = httpUrl(og['og:image:secure_url'] || og['og:image'] || tw['twitter:image'] || tw['twitter:image:src'], finalUrl)
  let siteName = clean(og['og:site_name'] || '', 80)
  let host = ''
  try { host = new URL(finalUrl).host.replace(/^www\./i, '') } catch {}
  if (!siteName) siteName = host
  if (!title) return null
  return { url: finalUrl, title, description, image, siteName, host }
}
