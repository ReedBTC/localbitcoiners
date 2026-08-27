// Podcast Index search + episode proxy for the "Find an Episode to Feature" flow.
//
// Three read-only operations, chosen by `?op=`:
//
//   op=search    &q=<term>                 → shows matching the term (search/byterm)
//   op=episodes  &feedId=<id>[&max=N]      → a show's recent episodes (episodes/byfeedid)
//   op=episode   &guid=<item guid>&feedId= → one episode by guid (episodes/byguid;
//                | &podcastGuid=              PI requires a feed identity beside the guid)
//   op=show      &podcastGuid=<guid>        → one show by podcast guid (podcasts/byguid),
//                                             which is how a backfilled episode learns
//                                             its feed id for the value block
//
// Same credentials and auth scheme as value.js (Cloudflare env
// PODCAST_INDEX_KEY / PODCAST_INDEX_SECRET, shared with the bots); the keys never
// reach the browser. Responses are normalized to the field names the site
// already uses for the community-boosts snapshot, so a show or episode found
// here renders through the same card code as one the collector produced.
//
// ⚠️ EVERY VALUE IS PASSED THROUGH FROM AN UNTRUSTED UPSTREAM. Titles and
// descriptions are text the renderer must escape (it does, via textContent);
// URLs are checked for http(s) here so nothing else has to.

const PI_BASE = "https://api.podcastindex.org/api/1.0";
const FETCH_TIMEOUT_MS = 10_000;
const SEARCH_MAX = 20;
const EPISODES_MAX = 40;
const TERM_MAX_LEN = 120;
const GUID_MAX_LEN = 400;

const ALLOWED_ORIGINS = new Set([
  "https://localbitcoiners.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
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
    "User-Agent": "LocalBitcoiners-Featured/1.0",
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
      cf: { cacheTtl: 300, cacheEverything: true },
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

function httpUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") ? u : null;
  } catch { return null; }
}

function str(v, max = 2000) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// PI feed object → the snapshot's `show` record shape (see the collector's
// resolve_show), plus the fields the Find modal lists.
function normalizeShow(f) {
  if (!f || !f.id) return null;
  return {
    feed_id: int(f.id),
    podcast_guid: str(f.podcastGuid, 200) || null,
    title: str(f.title, 300),
    author: str(f.author, 300),
    image: httpUrl(f.artwork) || httpUrl(f.image),
    itunes_id: int(f.itunesId),
    url: httpUrl(f.url),
    episode_count: int(f.episodeCount),
    newest_item: int(f.newestItemPubdate ?? f.newestItemPublishTime),
    value: !!(f.value && f.value.destinations && f.value.destinations.length),
  };
}

// PI episode object → the snapshot's `episode` record shape (the collector's
// resolve_episode), so a found episode renders through the same card.
function normalizeEpisode(e, fallbackFeedId = null) {
  if (!e || !e.guid) return null;
  return {
    item_guid: str(e.guid, GUID_MAX_LEN),
    title: str(e.title, 300),
    image: httpUrl(e.image) || httpUrl(e.feedImage),
    published: int(e.datePublished),
    duration: int(e.duration),
    episode_number: int(e.episode),
    podcast_guid: str(e.podcastGuid, 200) || null,
    feed_id: int(e.feedId) ?? fallbackFeedId,
    enclosure_url: httpUrl(e.enclosureUrl),
    enclosure_type: str(e.enclosureType, 100) || null,
    description: str(e.description, 4000),
    // Whether PI holds an episode-level value block; the feed-level one is
    // the fallback either way, resolved by /api/value at Feature time.
    value: !!(e.value && e.value.destinations && e.value.destinations.length),
  };
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
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const json = (body, status = 200, maxAge = 300) => new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
    },
  });

  const key = env.PODCAST_INDEX_KEY;
  const secret = env.PODCAST_INDEX_SECRET;
  if (!key || !secret) return json({ error: "Podcast Index not configured" }, 503);

  const params = new URL(request.url).searchParams;
  const op = params.get("op") || "";
  const headers = await piHeaders(key, secret);

  if (op === "search") {
    const q = (params.get("q") || "").trim().slice(0, TERM_MAX_LEN);
    if (q.length < 2) return json({ error: "q required" }, 400);
    const data = await piGet(`/search/byterm?q=${encodeURIComponent(q)}&max=${SEARCH_MAX}`, headers);
    if (!data) return json({ error: "Podcast Index unavailable" }, 502);
    const shows = (Array.isArray(data.feeds) ? data.feeds : []).map(normalizeShow).filter(Boolean);
    return json({ shows });
  }

  if (op === "episodes") {
    const feedId = params.get("feedId") || "";
    if (!/^\d{1,12}$/.test(feedId)) return json({ error: "feedId required" }, 400);
    const max = Math.min(EPISODES_MAX, Math.max(1, int(params.get("max")) || EPISODES_MAX));
    const data = await piGet(`/episodes/byfeedid?id=${feedId}&max=${max}`, headers);
    if (!data) return json({ error: "Podcast Index unavailable" }, 502);
    const episodes = (Array.isArray(data.items) ? data.items : [])
      .map((e) => normalizeEpisode(e, int(feedId)))
      .filter(Boolean);
    return json({ episodes });
  }

  if (op === "episode") {
    const guid = (params.get("guid") || "").trim();
    const feedId = params.get("feedId") || "";
    const podcastGuid = (params.get("podcastGuid") || "").trim();
    if (!guid || guid.length > GUID_MAX_LEN) return json({ error: "guid required" }, 400);
    let qs = `guid=${encodeURIComponent(guid)}`;
    if (/^\d{1,12}$/.test(feedId)) qs += `&feedid=${feedId}`;
    else if (podcastGuid && podcastGuid.length <= 200) qs += `&podcastguid=${encodeURIComponent(podcastGuid)}`;
    else return json({ error: "feedId or podcastGuid required" }, 400);
    const data = await piGet(`/episodes/byguid?${qs}`, headers);
    if (!data) return json({ error: "Podcast Index unavailable" }, 502);
    const episode = normalizeEpisode(data.episode, /^\d+$/.test(feedId) ? int(feedId) : null);
    return json({ episode: episode || null }, 200, 600);
  }

  if (op === "show") {
    const podcastGuid = (params.get("podcastGuid") || "").trim();
    if (!podcastGuid || podcastGuid.length > 200) return json({ error: "podcastGuid required" }, 400);
    const data = await piGet(`/podcasts/byguid?guid=${encodeURIComponent(podcastGuid)}`, headers);
    if (!data) return json({ error: "Podcast Index unavailable" }, 502);
    return json({ show: normalizeShow(data.feed) || null }, 200, 3600);
  }

  return json({ error: "op must be search, episodes, episode or show" }, 400);
}
