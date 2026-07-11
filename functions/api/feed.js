// Generic podcast-RSS proxy — fetches an external show's feed so the browser
// can read its <podcast:value> block for a boost (browsers can't cross-origin
// fetch most podcast hosts, and functions/api/rss.js is hard-locked to the LB
// feed).
//
// SSRF is fenced two ways: (1) the requested url must be a feed_url that
// actually appears in our own /api/community-boosts data — an attacker can't
// point this at an arbitrary or internal host; (2) basic URL hardening rejects
// non-http(s) and obvious internal/loopback targets as defense in depth. Fails
// CLOSED: if we can't load the allowlist, we refuse rather than fetch.
//
// Shares rss.js's shape: 10s timeout, 5 MB cap via streamed read, origin-locked
// CORS. This endpoint is only hit when a user opens the boost modal, so the
// extra allowlist round-trip (edge-cached) is not on any hot path.

const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  "https://localbitcoiners.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function pickCorsOrigin(originHeader) {
  if (typeof originHeader === "string" && ALLOWED_ORIGINS.has(originHeader)) {
    return originHeader;
  }
  return "https://localbitcoiners.com";
}

// Reject non-http(s) and hosts that could reach internal infrastructure. The
// allowlist check below is the real gate; this is belt-and-suspenders.
function isPubliclyRoutable(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  // Literal IPv4 in private / loopback / link-local ranges, and IPv6 loopback.
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

// Set of feed_url values present in our community-boosts snapshot. Same-origin
// sub-request so it resolves to whatever community-boosts.js serves on this
// deployment; edge-cached so repeated boosts don't refetch.
async function loadAllowedFeedUrls(request) {
  const url = new URL("/api/community-boosts", request.url);
  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!resp.ok) throw new Error("allowlist unavailable");
  const data = await resp.json();
  const set = new Set();
  for (const s of Object.values(data.shows || {})) {
    if (s && typeof s.feed_url === "string") set.add(s.feed_url);
  }
  return set;
}

export async function onRequest(context) {
  const { request } = context;
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = pickCorsOrigin(origin);
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const feedUrl = new URL(request.url).searchParams.get("url") || "";
  if (!feedUrl || !isPubliclyRoutable(feedUrl)) {
    return new Response("Missing or invalid feed url", { status: 400, headers: corsHeaders });
  }

  // Allowlist gate — fail closed.
  let allowed;
  try {
    allowed = await loadAllowedFeedUrls(request);
  } catch {
    return new Response("Feed allowlist unavailable", { status: 503, headers: corsHeaders });
  }
  if (!allowed.has(feedUrl)) {
    return new Response("Feed not in allowlist", { status: 403, headers: corsHeaders });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "LocalBitcoiners-Feed/1.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return new Response("Feed returned an error", { status: 502, headers: corsHeaders });
    }

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return new Response("Feed exceeded size limit", { status: 502, headers: corsHeaders });
    }

    const reader = resp.body?.getReader?.();
    if (!reader) {
      const text = await resp.text();
      if (text.length > RESPONSE_MAX_BYTES) {
        return new Response("Feed exceeded size limit", { status: 502, headers: corsHeaders });
      }
      return new Response(text, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
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
        return new Response("Feed exceeded size limit", { status: 502, headers: corsHeaders });
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const xml = new TextDecoder("utf-8").decode(buf);

    return new Response(xml, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return new Response(isTimeout ? "Feed upstream timed out" : "Failed to fetch feed", { status: 502, headers: corsHeaders });
  } finally {
    clearTimeout(timer);
  }
}
