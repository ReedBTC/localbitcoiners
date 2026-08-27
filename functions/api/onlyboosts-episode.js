// OnlyBoosts episode-record proxy, for featured episodes the community snapshot
// doesn't hold.
//
// A Feature boost names its episode by the OnlyBoosts episode URL
// (`https://onlyboosts.social/episode/<item guid>`), which is what the sats-log
// bot parses into the boosted-item log. When the Podcast Boosts tab reads that
// log and finds an episode nobody in the community has boosted (featured
// through the Find modal, or boosted by a non-supporter), it needs a title, art
// and show name from somewhere. OnlyBoosts indexes every episode boosted on
// Nostr by anyone, so its record is the natural source; Podcast Index is the
// fallback, but its by-guid lookup also needs a feed identity the URL lacks.
//
// Fronts https://onlyboosts.social/api/v1/episodes/<guid>. Same rationale as
// onlyboosts-boosters.js, and the same warning: OnlyBoosts' /api/v1 CORS
// allowlist deliberately excludes localbitcoiners.com, so the browser cannot
// fetch it directly and this proxy is the only supported path.
//
// Only the `episode` half of the upstream body is returned. The `boosts` half is
// every boost to the episode from anyone on Nostr, and the tab's cards label
// their drawers "local boosters" on purpose; mixing the two in would make that
// label a lie.

const UPSTREAM_BASE = "https://onlyboosts.social/api/v1/episodes/";
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 512 * 1024;
// Episode guids are UUIDs at 36 characters and run past 100 in the wild (the
// longest OnlyBoosts holds is a `<pubkey>:<uuid>` pair). Generous, but bounded.
const GUID_MAX = 400;
const EDGE_TTL_SECONDS = 600;

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

function httpUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") ? u : null;
  } catch { return null; }
}

function str(v, max = 300) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// OnlyBoosts' episode record → the community-boosts snapshot's `episode` +
// `show` shapes, so the tab renders a backfilled episode through the same
// card as one the collector produced. `feed_id` is unknown here; the tab
// resolves it from Podcast Index by podcast guid when it needs the value block.
function normalize(ep) {
  if (!ep || !ep.guid) return null;
  const show = ep.show || {};
  return {
    episode: {
      item_guid: str(ep.guid, GUID_MAX),
      title: str(ep.title),
      image: httpUrl(ep.img) || httpUrl(show.img) || null,
      published: int(ep.date),
      duration: int(ep.duration),
      episode_number: int(ep.num),
      podcast_guid: str(show.guid, 200) || null,
      feed_id: null,
      enclosure_url: httpUrl(ep.url),
      enclosure_type: null,
      description: "",
    },
    show: {
      podcast_guid: str(show.guid, 200) || null,
      title: str(show.title),
      author: str(show.author),
      image: httpUrl(show.img) || httpUrl(show.art2) || null,
      feed_url: httpUrl(show.feed),
      feed_id: null,
      itunes_id: null,
    },
  };
}

export async function onRequest(context) {
  const { request } = context;
  const origin = request.headers.get("Origin") || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": pickCorsOrigin(origin),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": status === 200 ? `public, max-age=${EDGE_TTL_SECONDS}` : "no-store",
    },
  });

  const guid = (new URL(request.url).searchParams.get("guid") || "").trim();
  if (!guid || guid.length > GUID_MAX) return json({ error: "guid required" }, 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(UPSTREAM_BASE + encodeURIComponent(guid), {
      headers: { Accept: "application/json", "User-Agent": "LocalBitcoiners-Featured/1.0" },
      cf: { cacheTtl: EDGE_TTL_SECONDS, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (resp.status === 404) return json({ episode: null, show: null }, 200);
    if (!resp.ok) return json({ error: "OnlyBoosts unavailable" }, 502);
    const len = Number(resp.headers.get("content-length") || 0);
    if (len > RESPONSE_MAX_BYTES) return json({ error: "OnlyBoosts response too large" }, 502);
    const text = await resp.text();
    if (text.length > RESPONSE_MAX_BYTES) return json({ error: "OnlyBoosts response too large" }, 502);
    const data = JSON.parse(text);
    const out = normalize(data && data.episode);
    return json(out || { episode: null, show: null });
  } catch {
    return json({ error: "OnlyBoosts unavailable" }, 502);
  } finally {
    clearTimeout(timer);
  }
}
