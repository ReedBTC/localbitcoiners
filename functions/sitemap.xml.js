// Dynamic sitemap. Pulls the current episode list from the RSS feed
// and emits a URL entry for each /ep### page alongside the fixed
// static-page URLs. Cached at the edge for 1 hour — sitemaps don't
// need to be live the same way episode pages do.

const RSS_URL = "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU";
const SITE_ORIGIN = "https://localbitcoiners.com";
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

const STATIC_URLS = [
  { loc: "/", changefreq: "weekly", priority: "1.0" },
  { loc: "/boosts.html", changefreq: "daily", priority: "0.8" },
];

export async function onRequest() {
  const xml = await fetchRss();
  const today = new Date().toISOString().slice(0, 10);

  const episodes = xml ? extractEpisodes(xml) : [];

  const urls = [
    ...STATIC_URLS.map((u) => ({
      loc: `${SITE_ORIGIN}${u.loc}`,
      lastmod: today,
      changefreq: u.changefreq,
      priority: u.priority,
    })),
    ...episodes.map((ep) => ({
      loc: `${SITE_ORIGIN}/ep${pad(ep.number)}`,
      lastmod: ep.lastmod || today,
      changefreq: "monthly",
      priority: "0.7",
    })),
  ];

  const body = renderSitemap(urls);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function fetchRss() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(RSS_URL, {
      headers: { "User-Agent": "LocalBitcoiners-Sitemap/1.0" },
      cf: { cacheTtl: 3600, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) return null;
    const text = await resp.text();
    return text.length > RESPONSE_MAX_BYTES ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractEpisodes(xml) {
  const out = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    const n = itemEpisodeNumber(itemXml);
    if (n === null) continue;

    const pubDate = matchTag(itemXml, "pubDate");
    let lastmod = null;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!Number.isNaN(d.getTime())) lastmod = d.toISOString().slice(0, 10);
    }
    out.push({ number: n, lastmod });
  }
  // De-dup by episode number, keep first occurrence.
  const seen = new Set();
  return out.filter((ep) => {
    if (seen.has(ep.number)) return false;
    seen.add(ep.number);
    return true;
  });
}

function matchTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  if (!m) return null;
  const noCdata = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeXmlEntities(noCdata).trim();
}

// Mirrors functions/_middleware.js#decodeXmlEntities. Title fallback
// for episode-number resolution needs entity decoding to handle "&amp;".
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

// Mirrors functions/_middleware.js#itemEpisodeNumber — Fountain doesn't
// emit <itunes:episode> on every item; the title "… | Ep. 010" is the
// reliable signal for the rest.
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

function pad(n, w = 3) {
  return String(n).padStart(w, "0");
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderSitemap(urls) {
  const entries = urls
    .map(
      (u) => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    <lastmod>${xmlEscape(u.lastmod)}</lastmod>
    <changefreq>${xmlEscape(u.changefreq)}</changefreq>
    <priority>${xmlEscape(u.priority)}</priority>
  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}
