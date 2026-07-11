// Podcast Index value-block proxy for the external-episode boost flow.
//
// The authoritative source for a show's V4V splits is Podcast Index, not the
// raw RSS — many shows (Anchor/Spotify-hosted especially) carry no
// <podcast:value> in their feed while PI still has the block in its database.
// So we resolve splits here, server-side, signed with the site's PI API
// credentials (Cloudflare env: PODCAST_INDEX_KEY / PODCAST_INDEX_SECRET — the
// same key the bot uses). Keys never reach the browser.
//
// Returns a normalized value block:
//   { level: 'episode'|'feed', value: { model, recipients: [ {name,type,
//     address,split,customKey?,customValue?,fee} ] } }
// or { value: null } when PI has no payable block for this episode.
//
// Episode value wins; falls back to the feed-level podcast value.

const PI_BASE = "https://api.podcastindex.org/api/1.0";
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_ORIGINS = new Set([
  "https://localbitcoiners.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function pickCorsOrigin(originHeader) {
  return (typeof originHeader === "string" && ALLOWED_ORIGINS.has(originHeader))
    ? originHeader : "https://localbitcoiners.com";
}

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Podcast Index auth: X-Auth-Key + X-Auth-Date + Authorization=sha1(key+secret+date).
async function piHeaders(key, secret) {
  const nowSec = Math.floor(Date.now() / 1000);
  const auth = await sha1Hex(String(key) + String(secret) + String(nowSec));
  return {
    "User-Agent": "LocalBitcoiners-Value/1.0",
    "X-Auth-Key": key,
    "X-Auth-Date": String(nowSec),
    Authorization: auth,
  };
}

async function piGet(path, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(PI_BASE + path, {
      headers,
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// PI value shape is { model:{type,method,suggested}, destinations:[...] }.
// Normalize destinations → recipients, keeping only payable node/lnaddress
// legs with a positive split. Returns null when nothing payable remains.
function normalizeValue(v) {
  if (!v || !Array.isArray(v.destinations)) return null;
  const recipients = [];
  for (const d of v.destinations) {
    const type = (d.type || "").trim();
    const address = (d.address || "").trim();
    const split = Number(d.split);
    if (type !== "node" && type !== "lnaddress") continue;
    if (!address || !Number.isFinite(split) || split <= 0) continue;
    const rec = { name: (d.name || "").trim(), type, address, split, fee: d.fee === true };
    if (d.customKey && d.customValue) { rec.customKey = String(d.customKey); rec.customValue = String(d.customValue); }
    recipients.push(rec);
  }
  if (recipients.length === 0) return null;
  return { model: v.model || null, recipients };
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": pickCorsOrigin(origin),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const key = env.PODCAST_INDEX_KEY;
  const secret = env.PODCAST_INDEX_SECRET;
  if (!key || !secret) {
    return new Response(JSON.stringify({ error: "Podcast Index not configured" }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const params = new URL(request.url).searchParams;
  const feedId = params.get("feedId");
  const guid = params.get("guid");
  if (!feedId || !/^\d+$/.test(feedId)) {
    return new Response(JSON.stringify({ error: "feedId required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const headers = await piHeaders(key, secret);
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
  });

  // 1) Episode-level value (preferred).
  if (guid) {
    const epRes = await piGet(`/episodes/byguid?guid=${encodeURIComponent(guid)}&feedid=${encodeURIComponent(feedId)}`, headers);
    const epValue = normalizeValue(epRes?.episode?.value);
    if (epValue) return json({ level: "episode", value: epValue });
  }

  // 2) Feed-level fallback.
  const feedRes = await piGet(`/podcasts/byfeedid?id=${encodeURIComponent(feedId)}`, headers);
  const feedValue = normalizeValue(feedRes?.feed?.value);
  if (feedValue) return json({ level: "feed", value: feedValue });

  return json({ value: null });
}
