/**
 * Links inside a note: `assets/js/note-media.js` (what a URL is) and
 * `functions/_shared/link-preview-parse.js` (the /api/link-preview parse
 * and target check).
 *
 * Run: node scripts/test-note-media.mjs
 *
 * No network, no DOM. Checks:
 *
 *   1. A URL ending in an image or video extension is media; a page URL is
 *      not; an extension-less URL is media only when the note's imeta tag
 *      says so (NIP-92, `m image/png` beside the url).
 *   2. Sentence punctuation after a URL stays out of the href.
 *   3. The anchor label drops the scheme and www. and is cut to 48 chars.
 *   4. App boilerplate comes off before rendering (OnlyBoosts' rule): the
 *      bot's 🔗 fountain line, a listen link alone on its line, a share-card
 *      image anywhere, the site's bare footer URL; a link inside the
 *      booster's sentence, a feature line and a GIF stay.
 *   5. The parse reads Open Graph first, Twitter second, <title> last,
 *      decodes entities, resolves a relative og:image against the page,
 *      refuses a non-http image, and returns null with no title.
 *   6. The target check refuses loopback, private ranges, odd ports,
 *      credentials and non-http schemes, and admits a public https URL.
 */
import assert from 'node:assert/strict'
import { mediaKindOf, imetaMapOf, splitTrailingPunct, linkLabel, stripBoilerplate } from '../assets/js/note-media.js'
import { parseLinkPreview, previewTargetProblem, decodeEntities } from '../functions/_shared/link-preview-parse.js'

let passed = 0
function ok(label, fn) {
  try { fn(); passed++; console.log(`  ✓ ${label}`) }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); process.exitCode = 1 }
}

console.log('mediaKindOf')
ok('a giphy .gif is an image', () => {
  assert.equal(mediaKindOf('https://media.giphy.com/media/igsvLnrCpT6NQftbBd/giphy.gif'), 'image')
})
ok('png / jpg / webp with a query string are images; mp4 is video', () => {
  assert.equal(mediaKindOf('https://x.test/a.PNG?w=1'), 'image')
  assert.equal(mediaKindOf('https://x.test/a.jpeg#frag'), 'image')
  assert.equal(mediaKindOf('https://x.test/a.webp'), 'image')
  assert.equal(mediaKindOf('https://x.test/clip.mp4'), 'video')
})
ok('a page URL is not media, nor is an image path behind a non-http scheme', () => {
  assert.equal(mediaKindOf('https://podcastindex.org/podcast/7968805'), null)
  assert.equal(mediaKindOf('https://www.boostmebuddy.com/?podcast=abc&episode=def'), null)
  assert.equal(mediaKindOf('ftp://x.test/a.gif'), null)
  assert.equal(mediaKindOf(null), null)
})
ok('an extension-less URL is media when the imeta tag says image/*', () => {
  const url = 'https://www.boostmebuddy.com/api/og/boost.png?art=https%3A%2F%2Fa.test%2Fb.jpg&title=T'
  const tags = [['imeta', `url ${url}`, 'm image/png', 'dim 1200x300'], ['t', 'boostagram']]
  const imeta = imetaMapOf(tags)
  assert.equal(imeta.get(url).mime, 'image/png')
  assert.equal(imeta.get(url).dim, '1200x300')
  const bare = 'https://blossom.test/abcdef0123'
  assert.equal(mediaKindOf(bare), null)
  assert.equal(mediaKindOf(bare, imetaMapOf([['imeta', `url ${bare}`, 'm image/jpeg']])), 'image')
  assert.equal(mediaKindOf(bare, imetaMapOf([['imeta', `url ${bare}`, 'm video/mp4']])), 'video')
  assert.equal(mediaKindOf(bare, imetaMapOf([['imeta', `url ${bare}`, 'm text/html']])), null)
  assert.equal(imetaMapOf(null).size, 0)
  assert.equal(imetaMapOf([['imeta', 'm image/png']]).size, 0)
})

console.log('splitTrailingPunct')
ok('a full stop, comma or quote after the URL is text, not href', () => {
  assert.deepEqual(splitTrailingPunct('https://x.test/page.'), { url: 'https://x.test/page', tail: '.' })
  assert.deepEqual(splitTrailingPunct('https://x.test/page?a=1,'), { url: 'https://x.test/page?a=1', tail: ',' })
  assert.deepEqual(splitTrailingPunct('https://x.test/a.gif'), { url: 'https://x.test/a.gif', tail: '' })
  assert.deepEqual(splitTrailingPunct("https://x.test/a'"), { url: 'https://x.test/a', tail: "'" })
})

console.log('linkLabel')
ok('drops the scheme and www., keeps the path, cuts at 48', () => {
  assert.equal(linkLabel('https://podcastindex.org/podcast/7968805'), 'podcastindex.org/podcast/7968805')
  assert.equal(linkLabel('https://www.boostmebuddy.com/'), 'boostmebuddy.com')
  const long = linkLabel('https://www.boostmebuddy.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53&episode=4fe8a3be')
  assert.equal(long.length, 48)
  assert.ok(long.endsWith('…'))
  assert.ok(long.startsWith('boostmebuddy.com/?podcast='))
})

console.log('stripBoilerplate')
ok("the show note loses its 🔗 fountain line and nothing else", () => {
  const note = '⚡ New boost on Local Bitcoiners!\n💰 100 sats 📱 via Fountain\n👤 nostr:npub1x\n💬 Hello\n🎙️ Local Bitcoiners • Ep. 033\n🔗 https://fountain.fm/episode/qQjER3A6RVPFP6nLTAyb\n\n#LocalBitcoiners'
  assert.equal(stripBoilerplate(note), '⚡ New boost on Local Bitcoiners!\n💰 100 sats 📱 via Fountain\n👤 nostr:npub1x\n💬 Hello\n🎙️ Local Bitcoiners • Ep. 033\n\n#LocalBitcoiners')
})
ok('a BoostMeBitch note keeps the GIF and the prose, loses the listen links and the share card', () => {
  const note = '⚡ Boost ⚡\n\nMagic number.\nhttps://media.giphy.com/media/DQcqDjL0vcxz7lEhNT/giphy.gif\n\nChadF boosted 333 sats → Local Bitcoiners\n📻 Ep. 033\n\nhttps://fountain.fm/episode/qQjER3A6RVPFP6nLTAyb\nhttps://www.boostmebitch.com/?podcast=56fb&episode=69b6\n\nhttps://www.boostmebitch.com/api/og/boost.png?art=x&sats=333\n\nnostr:nevent1abc'
  assert.equal(stripBoilerplate(note), '⚡ Boost ⚡\n\nMagic number.\nhttps://media.giphy.com/media/DQcqDjL0vcxz7lEhNT/giphy.gif\n\nChadF boosted 333 sats → Local Bitcoiners\n📻 Ep. 033\n\nnostr:nevent1abc')
})
ok("the site's own footer URL and /ep### alone on a line go; inside a sentence they stay", () => {
  assert.equal(stripBoilerplate('Great show\nhttps://localbitcoiners.com'), 'Great show')
  assert.equal(stripBoilerplate('Great show\nhttps://localbitcoiners.com/ep033'), 'Great show')
  assert.equal(stripBoilerplate('Boosting this episode from https://localbitcoiners.com/feeds'), 'Boosting this episode from https://localbitcoiners.com/feeds')
  assert.equal(stripBoilerplate('See https://fountain.fm/episode/abc for the one I mean'), 'See https://fountain.fm/episode/abc for the one I mean')
})
ok('feature lines (📅 plektos, 📄 mynostr, 🛒 shopstr) and other links stay', () => {
  const note = '💬 Boosting my meetup\n📅 https://plektos.app/event/naddr1xyz'
  assert.equal(stripBoilerplate(note), note)
  assert.equal(stripBoilerplate('https://www.meetup.com/bitcoin-only-sactown/events/315540285/'), 'https://www.meetup.com/bitcoin-only-sactown/events/315540285/')
})
ok('a Find it on line goes with its link; a banner goes mid-line; no URL is untouched', () => {
  assert.equal(stripBoilerplate('Hi\n🎧 Find it on Fountain\nhttps://fountain.fm/show/Q48W\nbye'), 'Hi\nbye')
  assert.equal(stripBoilerplate('look https://i.nostr.build/a6G5FkkfTlSyfJ7z.png here'), 'look  here')
  assert.equal(stripBoilerplate('no links\n\n\nhere'), 'no links\n\n\nhere')
  assert.equal(stripBoilerplate(null), '')
})

console.log('parseLinkPreview')
const PAGE = `<!doctype html><html><head>
<title>Fallback &amp; Title</title>
<meta name="description" content="Plain description">
<meta property="og:title" content="OG &quot;Title&quot;" />
<meta property='og:description' content='OG description &#8230; here'>
<meta property="og:image" content="/img/card.png">
<meta property="og:site_name" content="Example Site">
<meta name="twitter:title" content="TW Title">
</head><body>hi</body></html>`
ok('Open Graph wins, entities decode, relative image resolves', () => {
  const c = parseLinkPreview(PAGE, 'https://www.example.test/post/1')
  assert.equal(c.title, 'OG "Title"')
  assert.equal(c.description, 'OG description … here')
  assert.equal(c.image, 'https://www.example.test/img/card.png')
  assert.equal(c.siteName, 'Example Site')
  assert.equal(c.host, 'example.test')
  assert.equal(c.url, 'https://www.example.test/post/1')
})
ok('Twitter card, then <title> and name=description, then the host as site', () => {
  const tw = parseLinkPreview('<head><meta name="twitter:title" content="TW"><meta name="twitter:image" content="https://i.test/a.jpg"></head>', 'https://t.test/x')
  assert.equal(tw.title, 'TW')
  assert.equal(tw.image, 'https://i.test/a.jpg')
  assert.equal(tw.siteName, 't.test')
  const plain = parseLinkPreview('<html><head><title>\n  Just a   title </title><meta name="description" content="d"></head>', 'https://p.test/')
  assert.equal(plain.title, 'Just a title')
  assert.equal(plain.description, 'd')
  assert.equal(plain.image, '')
})
ok('no title is no card; a javascript: image is dropped; a comment is not read', () => {
  assert.equal(parseLinkPreview('<html><body>nothing</body></html>', 'https://n.test/'), null)
  const bad = parseLinkPreview('<head><title>T</title><meta property="og:image" content="javascript:alert(1)"></head>', 'https://b.test/')
  assert.equal(bad.image, '')
  const commented = parseLinkPreview('<head><!-- <meta property="og:title" content="Hidden"> --><title>Shown</title></head>', 'https://c.test/')
  assert.equal(commented.title, 'Shown')
})
ok('long fields are cut and whitespace collapsed', () => {
  const c = parseLinkPreview(`<head><title>${'a'.repeat(400)}</title><meta name="description" content="${'b '.repeat(400)}"></head>`, 'https://l.test/')
  assert.equal(c.title.length, 160)
  assert.ok(c.description.length <= 280)
})
ok('decodeEntities handles named, decimal and hex forms', () => {
  assert.equal(decodeEntities('a &amp; b &#39;c&#39; &#x27;d&#x27; &rsquo;'), "a & b 'c' 'd' ’")
})

console.log('previewTargetProblem')
ok('a public https URL is allowed', () => {
  assert.equal(previewTargetProblem('https://podcastindex.org/podcast/7968805'), null)
  assert.equal(previewTargetProblem('http://example.com/'), null)
})
ok('loopback, private ranges, link-local names and odd ports are refused', () => {
  assert.equal(previewTargetProblem('http://localhost/'), 'host')
  assert.equal(previewTargetProblem('http://foo.localhost/'), 'host')
  assert.equal(previewTargetProblem('http://127.0.0.1/'), 'private-ip')
  assert.equal(previewTargetProblem('http://10.1.2.3/x'), 'private-ip')
  assert.equal(previewTargetProblem('http://172.20.0.1/x'), 'private-ip')
  assert.equal(previewTargetProblem('http://192.168.1.1/x'), 'private-ip')
  assert.equal(previewTargetProblem('http://169.254.169.254/latest/meta-data'), 'private-ip')
  assert.equal(previewTargetProblem('http://[::1]/'), 'ipv6')
  assert.equal(previewTargetProblem('https://example.com:8443/'), 'port')
  assert.equal(previewTargetProblem('https://user:pw@example.com/'), 'credentials')
  assert.equal(previewTargetProblem('ftp://example.com/'), 'scheme')
  assert.equal(previewTargetProblem('not a url'), 'not-a-url')
  assert.equal(previewTargetProblem(''), 'missing')
  assert.equal(previewTargetProblem('https://intranet/'), 'host')
})

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`)
