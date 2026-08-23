// Intercepts /ep### URLs (e.g. /ep011) and returns a server-rendered
// HTML page for that episode. Everything else falls through via
// context.next() — middleware is path-agnostic by default in Cloudflare
// Pages, so the regex match is the gate.
//
// The page is rendered server-side at the edge so social-preview
// crawlers (Nostr, X, iMessage, etc.) read episode-specific OG tags
// from the raw HTML. Client-side rendering would have given every
// shared link the generic site preview, which defeats the whole point.

const RSS_URL = "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU";
const SITE_ORIGIN = "https://localbitcoiners.com";
const OG_IMAGE = `${SITE_ORIGIN}/assets/LocalBitcoiners_banner.png`;
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

// Single-segment /ep### where ### is 1–4 digits. Trailing slash tolerated.
const EP_PATH_RE = /^\/ep(\d{1,4})\/?$/;

// Hosts are stable across the series — render them server-side with
// fixed names + Nostr profile URLs that mirror the homepage's Hosts
// section. The `npub` is included so the client-side enhance script
// can upgrade the avatar (display name stays static since "Reed" /
// "Rev Hodl" are the brand-canonical labels regardless of Nostr
// kind-0 metadata).
// Subscribe-in-app dropdown URLs (show-level, not per-episode). Mirrors
// the SUBSCRIBE_LINKS array on the homepage card; keep in sync.
const SUBSCRIBE_LINKS = [
  { name: "Fountain",     url: "https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY" },
  { name: "Podcast Guru", url: "https://app.podcastguru.io/podcast/local-bitcoiners-1874589042" },
  { name: "Podverse",     url: "https://podverse.fm/podcast/eKqrkoAVH" },
  { name: "CurioCaster",  url: "https://curiocaster.com/podcast/pi7683299" },
  { name: "Castamatic",   url: "https://castamatic.com/guid/56fbb1aa-da79-5e4b-bebc-3b934ab8914c" },
];

const HOSTS = [
  {
    name: "Reed",
    npub: "npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s",
    url: "https://primal.net/Reed",
  },
  {
    name: "Rev Hodl",
    npub: "npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z",
    url: "https://primal.net/p/nprofile1qqsy6q3ua80awknlxp6m368qssqghct6ra6scca4meepumhcswkuwegutksft",
  },
];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const match = url.pathname.match(EP_PATH_RE);
  if (!match) return context.next();

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const epNum = parseInt(match[1], 10);
  if (!Number.isFinite(epNum) || epNum < 1) {
    return renderNotFound(epNum);
  }

  const xml = await fetchRss();
  if (!xml) {
    return new Response("Failed to load episode feed", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const itemXml = findEpisodeItem(xml, epNum);
  if (!itemXml) {
    return renderNotFound(epNum);
  }

  // Channel-level <podcast:value> serves as fallback for episodes that
  // don't ship a per-item value block. Extract it once.
  const channelValueXml = matchChannelValue(xml);

  const ep = extractEpisode(itemXml, epNum, channelValueXml);
  ep.chapters = await fetchChapters(ep.chaptersUrl);
  const html = renderEpisodePage(ep);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 10 min edge cache — new episodes show up within that window
      // after they land in the RSS, RSS itself isn't hammered.
      "Cache-Control": "public, max-age=600",
    },
  });
}

// ── RSS fetch (size-bounded, timeout-bounded — mirrors /api/rss.js) ──
async function fetchRss() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(RSS_URL, {
      headers: { "User-Agent": "LocalBitcoiners-EpPages/1.0" },
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) return null;

    const reader = resp.body?.getReader?.();
    if (!reader) {
      const text = await resp.text();
      return text.length > RESPONSE_MAX_BYTES ? null : text;
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > RESPONSE_MAX_BYTES) {
        try { ctrl.abort(); } catch {}
        try { reader.cancel(); } catch {}
        return null;
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder("utf-8").decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Chapters fetch (Podcasting 2.0 JSON chapters) ────────────────────
// Fetches the per-episode chapters JSON referenced by <podcast:chapters>
// and returns a normalized [{ startTime, title }] sorted by startTime.
// Returns [] on any failure (bad URL, timeout, oversized body, malformed
// JSON, no titled entries) — chapters are strictly additive, so the page
// must render fine without them. The file is tiny, so the cap is small.
const CHAPTERS_MAX_BYTES = 512 * 1024;
async function fetchChapters(chaptersUrl) {
  if (!chaptersUrl) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(chaptersUrl, {
      headers: { "User-Agent": "LocalBitcoiners-EpPages/1.0" },
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return [];
    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > CHAPTERS_MAX_BYTES) return [];
    const text = await resp.text();
    if (text.length > CHAPTERS_MAX_BYTES) return [];
    const data = JSON.parse(text);
    const list = Array.isArray(data?.chapters) ? data.chapters : [];
    return list
      .map((c) => ({
        startTime: Number(c && c.startTime),
        title: typeof (c && c.title) === "string" ? c.title.trim() : "",
      }))
      // Drop untitled/"toc:false" markers and anything without a usable
      // start time — those are ad/segment boundaries, not real chapters.
      .filter(
        (c) => c.title && Number.isFinite(c.startTime) && c.startTime >= 0
      )
      .sort((a, b) => a.startTime - b.startTime);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Minimal XML field extraction ─────────────────────────────────────
// Workers don't ship a DOMParser, so we scrape the feed with regex. The
// shape is predictable (Fountain RSS is stable), the only foot-guns are
// CDATA wrappers and namespaced tags — both handled below. Not a
// general-purpose XML parser; do not reuse this elsewhere.

function findEpisodeItem(xml, epNum) {
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    if (itemEpisodeNumber(itemXml) === epNum) {
      return itemXml;
    }
  }
  return null;
}

// Resolves the episode number for an <item>. Fountain's feed only sets
// the <itunes:episode> tag on some items; for the rest the canonical
// signal is "… | Ep. 010" in the title. Title parsing handles both
// "Ep. 10" and "Ep. 010" forms.
function itemEpisodeNumber(itemXml) {
  const tag = matchTag(itemXml, "itunes:episode") || matchTag(itemXml, "episode");
  if (tag) {
    const n = parseInt(tag, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const title = matchTag(itemXml, "title") || "";
  const t = title.match(/\bEp(?:isode)?\.?\s*0*(\d+)/i);
  if (t) {
    const n = parseInt(t[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function matchTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  if (!m) return null;
  return decodeXmlEntities(stripCdata(m[1])).trim();
}

// Fountain's feed XML-encodes element bodies (titles contain `&amp;`,
// descriptions are `&lt;p&gt;…&lt;/p&gt;`). Without decoding here the
// htmlEscape step on output would double-encode `&amp;` to `&amp;amp;`,
// and stripHtml wouldn't see the actual tags inside descriptions.
function decodeXmlEntities(s) {
  return String(s).replace(
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g,
    (whole, ent) => {
      const e = ent.toLowerCase();
      if (e === "amp") return "&";
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e.charAt(0) === "#") {
        const code = e.charAt(1) === "x"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code < 0x10ffff) {
          try { return String.fromCodePoint(code); } catch {}
        }
      }
      return whole;
    }
  );
}

// For tags that occur multiple times where we want one matching a
// predicate on an attribute. Used for <podcast:contentLink href="…">
// where several entries exist (one per service) and we want fountain's.
function matchAttrFiltered(xml, tag, attr, valueFilter) {
  const re = new RegExp(`<${tag}\\b([^>]*?)\\/?>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const am = attrs.match(new RegExp(`\\b${attr}=["']([^"']*)["']`));
    if (am) {
      const val = am[1];
      if (!valueFilter || valueFilter(val)) return val;
    }
  }
  return null;
}

function matchAttr(xml, tag, attr) {
  return matchAttrFiltered(xml, tag, attr, null);
}

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(s) {
  return s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Turn bare http(s) URLs in plain text into clickable links. Input is
// plain text (stripHtml already ran on shownotes), so every segment is
// escaped — URL segments become anchors, the rest stays text. Trailing
// sentence punctuation is pulled back out of the match so "see x.com."
// doesn't link the period. Non-http(s) URLs fall back to plain text.
function linkifyText(text) {
  const urlRe = /https?:\/\/[^\s<]+/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    out += htmlEscape(text.slice(last, m.index));
    let url = m[0];
    let trail = "";
    const trailMatch = url.match(/[.,;:!?]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      url = url.slice(0, -trail.length);
    }
    const safe = safeHttpUrl(url);
    out += safe
      ? `<a href="${htmlEscape(safe)}" target="_blank" rel="noopener noreferrer">${htmlEscape(url)}</a>`
      : htmlEscape(url);
    out += htmlEscape(trail);
    last = m.index + m[0].length;
  }
  out += htmlEscape(text.slice(last));
  return out;
}

// Guests are encoded in the shownotes as `[guests: npub1abc..., npub1def...]`.
// Same convention the boost bot uses for routing per-episode value splits.
// Case-insensitive on the prefix; comma-separated; only npub1 values pass.
function parseGuests(descriptionRaw) {
  const m = descriptionRaw.match(/\[guests:\s*([^\]]+)\]/i);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^npub1[02-9ac-hj-np-z]{58}$/.test(s));
}

function extractEpisode(itemXml, epNum, channelValueXml) {
  const title = matchTag(itemXml, "title") || `Episode ${epNum}`;
  const pubDate = matchTag(itemXml, "pubDate") || "";
  const guid = matchTag(itemXml, "guid") || "";
  const descRaw =
    matchTag(itemXml, "itunes:summary") ||
    matchTag(itemXml, "description") ||
    "";
  // Drop the [guests: …] bracket from visible body text — it's metadata
  // for the boost bot + guest enhancement, not part of the prose. The
  // dedicated Guests section below covers the same info more nicely.
  const descText = stripHtml(descRaw)
    .replace(/\[guests:[^\]]*\]/gi, "")
    .trim();
  const enclosureUrl = matchAttr(itemXml, "enclosure", "url");
  const fountainUrl = matchAttrFiltered(
    itemXml,
    "podcast:contentLink",
    "href",
    (v) => v && v.startsWith("https://fountain.fm/episode/")
  );
  // Podcasting 2.0 chapters — Fountain writes a <podcast:chapters> tag per
  // item pointing at an external JSON file (type application/json+chapters).
  // We only keep the URL here; the JSON is fetched at the edge in onRequest.
  const chaptersUrl = matchAttr(itemXml, "podcast:chapters", "url");
  const guests = parseGuests(descRaw);
  const splits = parseSplits(itemXml, channelValueXml);

  return {
    number: epNum,
    title,
    pubDate,
    guid,
    description: descText,
    enclosureUrl: safeHttpUrl(enclosureUrl),
    fountainUrl: safeHttpUrl(fountainUrl),
    chaptersUrl: safeHttpUrl(chaptersUrl),
    guests,
    splits,
    // Filled in by onRequest after the RSS parse — an array of
    // { startTime, title } sorted by startTime, or [] when the episode
    // has no chapters / the fetch fails.
    chapters: [],
  };
}

// ── Podcasting 2.0 value-block parsing ────────────────────────────
// Per-item <podcast:value> wins; falls back to channel-level. lnaddress
// AND node recipients are kept — the client redirects node legs to the
// guest's Lightning address (or skips them honestly) instead of dropping
// them. Mirrors index.html's parseSplitsFor + parseValueBlock.

function matchChannelValue(xml) {
  // Channel-level <podcast:value> lives outside any <item>. Grab the
  // first <podcast:value> that precedes the first <item>.
  const firstItemAt = xml.indexOf("<item");
  const haystack = firstItemAt >= 0 ? xml.slice(0, firstItemAt) : xml;
  const m = haystack.match(/<podcast:value\b[^>]*>([\s\S]*?)<\/podcast:value>/);
  return m ? m[0] : null;
}

function matchItemValue(itemXml) {
  const m = itemXml.match(/<podcast:value\b[^>]*>([\s\S]*?)<\/podcast:value>/);
  return m ? m[0] : null;
}

function parseValueBlock(valueXml, source) {
  if (!valueXml) return null;
  const recipients = [];
  const reciRe = /<podcast:valueRecipient\b([^>]*?)\/?>/g;
  let m;
  while ((m = reciRe.exec(valueXml)) !== null) {
    const attrs = m[1];
    const type = (attrs.match(/\btype=["']([^"']*)["']/) || [])[1] || "";
    // Keep lnaddress AND node recipients — the client redirects node legs to
    // the guest's Lightning address (or skips them honestly) rather than
    // dropping them, which used to silently renormalize their split.
    if (type !== "lnaddress" && type !== "node") continue;
    const address = (attrs.match(/\baddress=["']([^"']*)["']/) || [])[1] || "";
    const name = (attrs.match(/\bname=["']([^"']*)["']/) || [])[1] || address;
    const splitStr = (attrs.match(/\bsplit=["']([^"']*)["']/) || [])[1] || "";
    const splitWeight = parseFloat(splitStr);
    if (!address || !Number.isFinite(splitWeight) || splitWeight <= 0) continue;
    recipients.push({ name, address, splitWeight, type });
  }
  if (recipients.length === 0) return null;
  const totalWeight = recipients.reduce((acc, r) => acc + r.splitWeight, 0);
  return { recipients, totalWeight, source };
}

function parseSplits(itemXml, channelValueXml) {
  const itemBlock = parseValueBlock(matchItemValue(itemXml), "item");
  if (itemBlock) return itemBlock;
  return parseValueBlock(channelValueXml, "channel");
}

// Reject any non-http(s) URL pulled from the feed — same defense as the
// homepage's renderCard. A tampered upstream could otherwise embed
// javascript: or data: into <audio src> or anchor hrefs.
function safeHttpUrl(u) {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? u
      : null;
  } catch {
    return null;
  }
}

// ── HTML rendering ───────────────────────────────────────────────────

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function pad(n, w = 3) {
  return String(n).padStart(w, "0");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

function toIsoDate(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

// JSON for embedding inside <script type="application/ld+json">. Escape
// `<` to `<` so a feed value containing literal `</script>` can't
// close our script block.
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

function renderEpisodePage(ep) {
  const epPad = pad(ep.number);
  const pageUrl = `${SITE_ORIGIN}/ep${epPad}`;
  const transcriptPath = `/transcripts/localbitcoiners-ep${epPad}.txt`;
  const ogTitle = `Ep. ${ep.number} — ${ep.title} | Local Bitcoiners`;
  const ogDesc = truncate(ep.description, 200) ||
    `Local Bitcoiners episode ${ep.number}.`;
  const dateStr = fmtDate(ep.pubDate);
  const isoPubDate = toIsoDate(ep.pubDate);

  // Description text → paragraph array. The stripHtml output uses
  // blank-line separators between paragraphs. Paragraph 1 carries the
  // substantive episode summary; the rest are link blocks, donation
  // info, etc., which we tuck behind a Show-more toggle.
  const paragraphs = ep.description
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const shownotesDisclosure = renderShownotesDisclosure(paragraphs);
  const chaptersDisclosure = renderChaptersDisclosure(ep.chapters);

  const audioBlock = ep.enclosureUrl
    ? `<audio class="ep-player" controls preload="none" src="${htmlEscape(ep.enclosureUrl)}"></audio>`
    : "";

  // Subscribe-in-app dropdown — same SUBSCRIBE_LINKS the homepage card
  // uses. Native <details>/<summary> so the toggle is CSS-only; outside-
  // click closer is wired in episode-enhance.js.
  const subscribeDropdown = `<details class="ep-subscribe">
        <summary class="btn btn-subscribe">📡 Subscribe <span class="caret" aria-hidden="true">▾</span></summary>
        <div class="ep-subscribe-menu">
          ${SUBSCRIBE_LINKS.map(
            (s) =>
              `<a href="${htmlEscape(s.url)}" target="_blank" rel="noopener noreferrer">${htmlEscape(s.name)}</a>`
          ).join("\n          ")}
        </div>
      </details>`;

  // Boost CTA — server-renders only when we have parseable splits. Click
  // is wired in episode-enhance.js: lazy-loads the widget bundle, then
  // calls window.LBLogin.openEpisodeBoost with the episode metadata +
  // splits embedded in the inline JSON block below. Mirrors the homepage
  // card's per-episode boost flow.
  const boostBtn = ep.splits
    ? `<button type="button" class="btn btn-boost" data-lb-boost-trigger="episode">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="14" height="14">
          <path fill-rule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clip-rule="evenodd"/>
        </svg>
        <span class="lb-boost-label">Boost this episode</span>
      </button>`
    : "";

  const guestsGroup = ep.guests.length > 0
    ? renderPeopleGroup(
        ep.guests.length > 1 ? "Guests" : "Guest",
        ep.guests.map((npub) => ({ npub, url: `https://mynostr.app/${npub}` }))
      )
    : "";

  const hostsGroup = renderPeopleGroup("Hosts", HOSTS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com;
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: https:;
    font-src 'self' data:;
    connect-src 'self' https: wss:;
    media-src 'self' https:;
    frame-ancestors 'none';
    base-uri 'self';
    form-action 'self';
    object-src 'none';
  " />

  <title>${htmlEscape(ogTitle)}</title>
  <meta name="description" content="${htmlEscape(ogDesc)}" />
  <link rel="canonical" href="${pageUrl}" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />
  <link rel="alternate" type="application/rss+xml" title="Local Bitcoiners" href="${RSS_URL}" />

  <meta property="og:type" content="article" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:title" content="${htmlEscape(ogTitle)}" />
  <meta property="og:description" content="${htmlEscape(ogDesc)}" />
  <meta property="og:site_name" content="Local Bitcoiners" />
  <meta property="og:image" content="${OG_IMAGE}" />
  ${ep.enclosureUrl ? `<meta property="og:audio" content="${htmlEscape(ep.enclosureUrl)}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${htmlEscape(ogTitle)}" />
  <meta name="twitter:description" content="${htmlEscape(ogDesc)}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />

  <script type="application/ld+json">
  ${jsonForScript({
    "@context": "https://schema.org",
    "@type": "PodcastEpisode",
    "name": ep.title,
    "episodeNumber": ep.number,
    "url": pageUrl,
    "image": OG_IMAGE,
    "description": ogDesc,
    ...(isoPubDate ? { "datePublished": isoPubDate } : {}),
    ...(ep.enclosureUrl ? { "associatedMedia": { "@type": "MediaObject", "contentUrl": ep.enclosureUrl } } : {}),
    "partOfSeries": {
      "@type": "PodcastSeries",
      "name": "Local Bitcoiners",
      "url": SITE_ORIGIN,
    },
  })}
  </script>

  <link rel="stylesheet" href="/assets/css/boosts-thread.css" />
  <link rel="stylesheet" href="/assets/css/boost-actions.css" />
  <link rel="stylesheet" href="/assets/css/episode.css" />
  <link rel="stylesheet" href="/assets/css/nav.css" />
  <link rel="stylesheet" href="/assets/css/footer.css" />
</head>
<body>

<script type="application/json" id="lb-ep-data">${jsonForScript({
    episode: { number: ep.number, title: ep.title, guid: ep.guid, fountainUrl: ep.fountainUrl, pubDate: isoPubDate, guests: ep.guests },
    splits: ep.splits,
  })}</script>

<!-- NAV:START (generated by scripts/sync-partials.js — edit the partial) -->
<!-- ══════════════════════════════ NAV ══════════════════════════════
     SHARED NAV — single source of truth. Do NOT edit the copies inside the
     page files; edit THIS file, then run scripts/sync-partials.js to
     push it into every page (between the NAV:START / NAV:END markers).
     Styles live in /assets/css/nav.css; behavior in /assets/js/nav.js. -->
<header id="top-nav">
  <div class="nav-inner">
    <a class="nav-logo" href="/" aria-label="Local Bitcoiners home">
      <img src="/assets/LocalBitcoiners.png" alt="Local Bitcoiners logo" />
    </a>
    <a class="nav-site-name" href="/">Local Bitcoiners</a>
    <nav aria-label="Main navigation">
      <!-- Single "Explore" menu = the whole site map. Grouped dropdown on
           desktop, full-screen overlay on mobile. -->
      <details class="nav-explore">
        <summary aria-label="Explore the site">
          <span class="nav-explore-glyph" aria-hidden="true">🧭</span>
          <span class="nav-explore-text">Explore</span>
          <span class="caret" aria-hidden="true">▾</span>
        </summary>
        <div class="nav-explore-panel">
          <div class="nav-explore-head">
            <span>Explore</span>
            <button type="button" class="nav-explore-close" aria-label="Close menu">✕</button>
          </div>
          <a class="nav-explore-home" href="/"><span aria-hidden="true">🏠</span> Home</a>
          <div class="nav-explore-groups">
            <div class="nav-explore-group">
              <h4>Show</h4>
              <a href="/episodes.html"><span aria-hidden="true">🎧</span> Episodes</a>
              <a href="/stats.html"><span aria-hidden="true">📊</span> Stats</a>
              <a href="/feeds#market"><span aria-hidden="true">👕</span> Merch</a>
            </div>
            <div class="nav-explore-group">
              <h4>Community</h4>
              <a href="/feeds"><span aria-hidden="true">🗞️</span> Feeds</a>
              <a href="/supporters"><span aria-hidden="true">🟧</span> Supporters</a>
              <a href="/boosts.html"><span aria-hidden="true">⚡</span> Boosts</a>
            </div>
            <div class="nav-explore-group">
              <h4>More</h4>
              <a href="https://github.com/Reeds-Agent-Team/Bitcoin-Meetups" target="_blank" rel="noopener"><span aria-hidden="true">📖</span> Resources</a>
              <a href="/#site-footer"><span aria-hidden="true">✉️</span> Contact</a>
              <a href="#" data-lb-bug-trigger><span aria-hidden="true">🐞</span> Report a bug</a>
            </div>
          </div>
        </div>
      </details>
    </nav>
    <div id="lb-boost-slot" aria-label="Boost the Show">
      <button
        type="button"
        class="lb-boost-placeholder"
        data-lb-boost-trigger="show"
        aria-label="Boost the Show"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clip-rule="evenodd"/>
        </svg>
        <span class="lb-label-long">Boost the Show</span>
        <span class="lb-label-short">Boost</span>
      </button>
    </div>
    <!-- Cart icon → merch checkout cart. Hidden by nav.js until the cart
         (sessionStorage 'lb_merch_cart') has items, except on the /feeds
         Marketplace tab where it always shows. Click opens the cart modal in
         place once that tab has hydrated (feeds-market.js exposes
         window.openMerchCart) or navigates to /feeds#market-cart. -->
    <a id="nav-cart-link" class="nav-cart" href="/feeds#market-cart" aria-label="View cart" style="display:none">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      <span id="nav-cart-badge" class="nav-cart-badge" aria-hidden="true"></span>
    </a>
    <div id="lb-identity-slot" aria-label="Account">
      <!-- Static placeholder swapped out by IdentityWidget once the
           bundle loads. Picks shimmer vs sign-in based on whether a
           saved session exists; populated by inline script below. -->
    </div>
  </div>
</header>
<!-- NAV:END -->

<main class="ep-main">
  <article class="ep-card ep-card-player">
    <p class="ep-num">Ep. ${ep.number}</p>
    <h1 class="ep-title">${htmlEscape(ep.title)}</h1>
    <p class="ep-date">${htmlEscape(dateStr)}</p>

    ${audioBlock}

    <div class="ep-actions">
      <!-- Download MP3 / Transcript are secondary: inline on desktop,
           tucked behind a ⋮ menu on mobile so Boost + Subscribe stay the
           only visible actions. Mirrors the episode cards on /episodes. -->
      <div class="ep-overflow">
        <button type="button" class="ep-overflow-btn" aria-label="More options" aria-expanded="false">⋮</button>
        <div class="ep-overflow-menu">
          ${ep.enclosureUrl ? `<button type="button" class="btn btn-primary" data-lb-download-mp3 data-mp3-url="${htmlEscape(ep.enclosureUrl)}" data-mp3-filename="${htmlEscape(`local-bitcoiners-ep${epPad}.mp3`)}">↓ Download MP3</button>` : ""}
          <a class="btn btn-outline" href="${htmlEscape(transcriptPath)}" download>↓ Download Transcript</a>
        </div>
      </div>
      ${boostBtn}
      ${subscribeDropdown}
    </div>

    ${chaptersDisclosure}
    ${shownotesDisclosure}
  </article>

  ${(hostsGroup || guestsGroup) ? `<article class="ep-card ep-card-people">
    <div class="ep-people-row">
      ${hostsGroup}
      ${guestsGroup}
    </div>
  </article>` : ""}

  <!-- Per-episode sats-over-time chart. Ships hidden — ep-sats.js fetches
       /data/sats.json, and reveals the card only if this episode has
       boost/stream data to plot. -->
  <article class="ep-card ep-card-chart" data-ep-chart hidden></article>

  <!-- Stream supporters — who streamed sats to this episode and how
       much. Hydrated by ep-sats.js from /data/sats.json; ships hidden,
       revealed only for episodes that have stream rows. -->
  <section class="ep-supporter-section" data-ep-streams hidden></section>

  <section class="ep-boosts" data-ep-num="${ep.number}" aria-labelledby="ep-boosts-heading">
    <h2 class="ep-boosts-heading" id="ep-boosts-heading">Boosts on this episode</h2>
    <p class="ep-boosts-status" data-ep-boosts-status>Loading boosts…</p>
    <div class="ep-boosts-list" data-ep-boosts-list></div>
  </section>

  <!-- Pre-Nostr boost list — boosts that landed before the boost bot
       started publishing kind-1 notes, so they never made it into the
       thread above. Hydrated by ep-sats.js from /data/sats.json; ships
       hidden, revealed only for episodes that have such boosts. -->
  <section class="ep-supporter-section" data-ep-prenostr hidden></section>

  <p class="ep-back"><a href="/#episodes">← All episodes</a></p>
</main>

<!-- FOOTER:START (generated by scripts/sync-partials.js — edit the partial) -->
<!-- ══════════════════════════════ FOOTER ══════════════════════════════
     SHARED FOOTER — single source of truth. Do NOT edit the copies inside
     the page files; edit THIS file, then run scripts/sync-partials.js
     to push it into every page (between FOOTER:START / FOOTER:END markers).
     Styles live in /assets/css/footer.css. -->
<footer id="site-footer">
  <div class="footer-top">

    <div class="footer-col footer-about">
      <h3>Local Bitcoiners</h3>
      <p>A Bitcoin podcast about meetup culture. Hosts Reed and Rev Hodl sit down with organizers from across the country on how they find, build, and grow local Bitcoin communities — not price charts, real-world grassroots adoption.</p>
      <p>Run a meetup and want to come on, or curious about Grassroots Bitcoin and the quarterly organizer calls? <a href="mailto:localbitcoiners@gmail.com">localbitcoiners@gmail.com</a></p>
      <div class="footer-hosts">
        <a class="footer-host" href="https://primal.net/Reed" target="_blank" rel="noopener">⚡ Reed</a>
        <a class="footer-host" href="https://primal.net/p/nprofile1qqsy6q3ua80awknlxp6m368qssqghct6ra6scca4meepumhcswkuwegutksft" target="_blank" rel="noopener">⚡ Rev Hodl</a>
      </div>
    </div>

    <div class="footer-col">
      <h3>Listen &amp; Follow</h3>
      <ul>
        <li><a href="https://fountain.fm/show/Q48WBr6nT3mrbwMZ8ydY" target="_blank" rel="noopener">🎙 Fountain</a></li>
        <li><a href="https://podcasts.apple.com/us/podcast/local-bitcoiners/id1874589042" target="_blank" rel="noopener">🍎 Apple Podcasts</a></li>
        <li><a href="https://open.spotify.com/show/5v5AX2C7ubaV1xjfL2EMZV" target="_blank" rel="noopener">🎵 Spotify</a></li>
        <li><a href="https://www.youtube.com/@LocalBitcoiners" target="_blank" rel="noopener">▶️ YouTube</a></li>
        <li><a href="https://app.podcastguru.io/podcast/local-bitcoiners-1874589042" target="_blank" rel="noopener">🎧 Podcast Guru</a></li>
        <li><a href="https://podverse.fm/podcast/eKqrkoAVH" target="_blank" rel="noopener">🎧 Podverse</a></li>
        <li><a href="https://curiocaster.com/podcast/pi7683299" target="_blank" rel="noopener">🎧 CurioCaster</a></li>
        <li><a href="https://castamatic.com/guid/56fbb1aa-da79-5e4b-bebc-3b934ab8914c" target="_blank" rel="noopener">🎧 Castamatic</a></li>
        <li><a href="https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU" target="_blank" rel="noopener">📡 RSS Feed</a></li>
      </ul>
    </div>

    <div class="footer-col">
      <h3>Connect</h3>
      <ul>
        <li><a href="mailto:localbitcoiners@gmail.com">✉️ Email</a></li>
        <li><a href="https://x.com/LocalBitcoiners" target="_blank" rel="noopener">🐦 Twitter / X</a></li>
        <li><a href="https://primal.net/p/nprofile1qqsvxvygrc58dqupmk9al5n5xswu5rzcstpfhpjzaf9ustm4vvnytys56dr5z" target="_blank" rel="noopener">🟣 Show on Nostr</a></li>
        <li><a href="https://github.com/Reeds-Agent-Team/Bitcoin-Meetups" target="_blank" rel="noopener">📖 Meetup Resources</a></li>
        <li><a href="https://github.com/ReedBTC/localbitcoiners" target="_blank" rel="noopener">💻 Site Source</a></li>
      </ul>
    </div>

    <div class="footer-col">
      <h3>Support the Show</h3>
      <ul>
        <li><a href="lightning:aquafox30@primal.net">⚡ Zap: aquafox30@primal.net</a></li>
        <li>
          🔗 Silent Payment
          <a class="muted-link" href="https://docs.cakewallet.com/cryptos/bitcoin/#silent-payments" target="_blank" rel="noopener">(what's this?)</a>
          <span class="payment-code">sp1qq0cvn8x7x43xcpmqjzmej24jr5ccnsmvqpvjcn7ctzlpntfq9u252qj70jgwxsqugcwp7tmuq6pq77ffepsklhlhv7r434ycxy00zknjygxgl0rl</span>
        </li>
        <li>
          🏦 Paynym: <strong style="color:var(--cream)">+raggedtrack25</strong>
          <a class="muted-link" href="https://sparrowwallet.com/docs/spending-privately.html#paynym-payment-code" target="_blank" rel="noopener">(what's this?)</a>
          <span class="payment-code">PM8TJa9CSHGKkr2ZxvAicubwbF45NcABU3iWNCqjPxspMAXXjqcNYYqwEYYndHBgWUFHdSFZjrs7DKBT2f77XCjtAhkSMrv5cZ4G1JM7jkAqGbE6xsAk</span>
        </li>
      </ul>
    </div>

  </div>
  <div class="footer-bottom">
    <p>© 2026 Local Bitcoiners Podcast &nbsp;·&nbsp; <a href="mailto:localbitcoiners@gmail.com">localbitcoiners@gmail.com</a></p>
  </div>
</footer>
<!-- FOOTER:END -->

<!-- Identity slot placeholder — populated synchronously so returning
     visitors see a shimmer instead of an empty box while the widget
     boots. Mirrors index.html / boosts.html. -->
<script>
(function () {
  var slot = document.getElementById('lb-identity-slot');
  if (!slot) return;
  var hasSession = false;
  try { hasSession = !!localStorage.getItem('lb_nostr_session'); } catch (e) {}
  if (hasSession) {
    slot.innerHTML = '<div class="lb-identity-restoring" aria-label="Loading account"></div>';
  } else {
    slot.innerHTML = '<button type="button" class="lb-identity-placeholder" aria-label="Log in to Local Bitcoiners"><img src="/assets/favicon.png" alt="" aria-hidden="true" width="18" height="18">Log in</button>';
    var btn = slot.querySelector('button');
    btn.addEventListener('click', function () {
      if (window.LBLogin && typeof window.LBLogin.requestLogin === 'function') {
        window.LBLogin.requestLogin();
      }
    });
  }
})();
</script>

<!-- Nav "Boost the Show" placeholder handler — replaced by the
     IdentityWidget bundle once it loads; this is the fallback for the
     brief window before that happens. -->
<script>
(function () {
  var ph = document.querySelector('[data-lb-boost-trigger="show"]');
  if (!ph) return;
  ph.addEventListener('click', function () {
    if (window.LBLogin && typeof window.LBLogin.openShowBoost === 'function') {
      window.LBLogin.openShowBoost();
    }
  });
})();
</script>

<!-- Login widget bundle. Eager-loaded so the nav identity widget +
     boost-card action bar are responsive without a per-interaction
     spinner. Returning visitors with a saved session sign back in
     automatically as the bundle evaluates. -->
<script src="/assets/widgets/login-widget.js" defer></script>

<script src="/assets/js/episode-enhance.js" defer></script>
<script src="/assets/js/ep-sats.js" defer></script>
<script src="/assets/js/nav.js" defer></script>
<script type="module" src="/assets/js/ep-boosts.js"></script>

</body>
</html>`;
}

// Renders a label + inline pills for either Hosts or Guests. Returns a
// flat sequence of elements (label first, then one pill per person) so
// hosts and guests share a single flex row in .ep-people-row. When the
// row is too narrow, individual pills wrap rather than entire groups —
// keeping the "single line on desktop" feel intact for as long as
// possible. Hosts have a static `.name`; guests get a truncated npub
// that episode-enhance.js later upgrades from kind-0 metadata.
function renderPeopleGroup(label, people) {
  const items = people
    .map((p) => {
      const npubAttr = p.npub ? ` data-npub="${htmlEscape(p.npub)}"` : "";
      if (p.name) {
        return `<span class="person person-host"${npubAttr}>
          <a class="person-link" href="${htmlEscape(p.url)}" target="_blank" rel="noopener">
            <span class="person-avatar" aria-hidden="true"></span>
            <span class="person-name">${htmlEscape(p.name)}</span>
          </a>
        </span>`;
      }
      const short = `${p.npub.slice(0, 12)}…${p.npub.slice(-6)}`;
      return `<span class="person person-guest"${npubAttr}>
          <a class="person-link" href="${htmlEscape(p.url)}" target="_blank" rel="noopener">
            <span class="person-avatar" aria-hidden="true"></span>
            <code class="person-npub">${htmlEscape(short)}</code>
          </a>
        </span>`;
    })
    .join("\n        ");
  return `<span class="ep-people-label">${htmlEscape(label)}</span>
        ${items}`;
}

// Shownotes disclosure. Collapsed by default as a "Show notes" sub-banner
// at the bottom of the player card; expands inline to reveal all
// paragraphs. Native <details>/<summary> so toggling works without JS.
function renderShownotesDisclosure(paragraphs) {
  if (paragraphs.length === 0) return "";
  const body = paragraphs
    .map((p) => `<p>${linkifyText(p)}</p>`)
    .join("\n        ");
  return `<details class="ep-shownotes">
      <summary class="ep-shownotes-summary">
        <span class="ep-shownotes-title">Show notes</span>
        <span class="ep-shownotes-caret" aria-hidden="true">▾</span>
      </summary>
      <div class="ep-shownotes-body shownotes-body">
        ${body}
      </div>
    </details>`;
}

// Formats a chapter start time as h:mm:ss (drops the hour segment when the
// chapter starts under an hour in). Used for the timestamp column.
function fmtChapterTime(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(h > 0 ? String(m).padStart(2, "0") : m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

// Chapters disclosure — a collapsible list inside the player card. Each
// row is a button carrying data-seconds; episode-enhance.js wires clicks
// to seek the <audio> element and highlights the active chapter as it
// plays. Ships open (it's the navigation aid the plain player lacks) but
// only when the episode actually has chapters. No JS = still a readable
// timestamped table of contents.
function renderChaptersDisclosure(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) return "";
  const rows = chapters
    .map((c) => {
      const secs = Math.max(0, Math.floor(c.startTime));
      return `<li class="ep-chapter">
          <button type="button" class="ep-chapter-btn" data-seconds="${secs}">
            <span class="ep-chapter-time">${htmlEscape(fmtChapterTime(secs))}</span>
            <span class="ep-chapter-title">${htmlEscape(c.title)}</span>
          </button>
        </li>`;
    })
    .join("\n        ");
  return `<details class="ep-chapters" open>
      <summary class="ep-chapters-summary">
        <span class="ep-chapters-title">Chapters <span class="ep-chapters-count">${chapters.length}</span></span>
        <span class="ep-chapters-caret" aria-hidden="true">▾</span>
      </summary>
      <ol class="ep-chapters-list">
        ${rows}
      </ol>
    </details>`;
}

// ── 404 ──────────────────────────────────────────────────────────────

function renderNotFound(epNum) {
  const label = Number.isFinite(epNum) ? `Episode ${epNum}` : "That episode";
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Episode not found — Local Bitcoiners</title>
  <meta name="description" content="No such episode yet — head back to the show." />
  <meta name="robots" content="noindex" />
  <link rel="icon" type="image/png" href="/assets/favicon.png" />
  <link rel="stylesheet" href="/assets/css/episode.css" />
</head>
<body>
<header id="top-nav">
  <div class="nav-inner">
    <a class="nav-logo" href="/" aria-label="Local Bitcoiners home">
      <img src="/assets/LocalBitcoiners.png" alt="Local Bitcoiners logo" />
    </a>
    <a class="nav-site-name" href="/">Local Bitcoiners</a>
  </div>
</header>
<main class="ep-main">
  <article class="ep-card ep-404">
    <h1>${htmlEscape(label)} isn't here</h1>
    <p>Either it hasn't been published yet, or the link is off by a digit. The full episode list is on the homepage.</p>
    <p><a class="btn btn-primary" href="/#episodes">← Browse all episodes</a></p>
  </article>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
