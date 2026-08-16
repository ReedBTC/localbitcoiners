// OnlyBoosts booster-pubkey index proxy.
//
// Fronts https://onlyboosts.social/api/v1/boosters/pubkeys so the browser never
// talks to that host directly. Same rationale as community-boosts.js: one
// cached edge origin, one CORS policy, and the upstream URL can move without a
// frontend deploy.
//
// ⚠️ THE PROXY IS THE ONLY SUPPORTED PATH, not a convenience.
// OnlyBoosts' /api/v1 CORS allowlist is shared by every endpoint on that side
// and deliberately does NOT include localbitcoiners.com — widening it for this
// one route would widen the whole surface. A server-side fetch is not subject
// to CORS, which is why this works. A browser fetch straight to onlyboosts.social
// WILL be blocked. Do not "simplify" this away.
//
// What the frontend does with it: assets/js/onlyboosts.js turns the array into
// a Set and asks it, per rendered person, whether to link to that person's
// OnlyBoosts page or fall back to copying their npub.

const UPSTREAM_URL = "https://onlyboosts.social/api/v1/boosters/pubkeys";

// Measured at 134KB for 2,003 boosters (~67 bytes per entry). 4MB is room for
// roughly 60,000 boosters, which is far past anything plausible, while still
// refusing to let a misbehaving upstream pin the Function's memory.
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

// Exact-match origin allowlist — mirrors community-boosts.js. `startsWith`
// checks let lookalike origins get reflected into Access-Control-Allow-Origin,
// so this stays an exact Set match, not a prefix check.
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
  if (typeof originHeader === "string" && ALLOWED_ORIGINS.has(originHeader)) {
    return originHeader;
  }
  return "https://localbitcoiners.com";
}

// The set changes only when someone boosts a podcast for the very first time,
// and a miss costs nothing worse than a copy-npub click where a link was
// possible. 30 minutes at the edge on top of the client's own cache keeps
// OnlyBoosts' request volume near zero.
const EDGE_TTL_SECONDS = 1800;

export async function onRequest(context) {
  const origin = context.request.headers.get("Origin") || "";
  const corsOrigin = pickCorsOrigin(origin);

  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(UPSTREAM_URL, {
      headers: {
        "User-Agent": "LocalBitcoiners-OnlyBoosts-Proxy/1.0",
        Accept: "application/json",
      },
      cf: { cacheTtl: EDGE_TTL_SECONDS, cacheEverything: true },
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      return fail("OnlyBoosts booster index returned an error", corsHeaders);
    }

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return fail("OnlyBoosts booster index exceeded size limit", corsHeaders);
    }

    const text = await readCapped(resp, ctrl);
    if (text === null) {
      return fail("OnlyBoosts booster index exceeded size limit", corsHeaders);
    }

    // ⚠️ PARSE BEFORE RETURNING, and do not optimize this into a body stream.
    // Validating is the point: a Cloudflare error page or an HTML 404 shell is
    // a 200 as far as the frontend is concerned, and handing it a non-array
    // would make every person on the site look like a non-booster with no
    // visible failure anywhere.
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return fail("OnlyBoosts booster index was not JSON", corsHeaders);
    }

    if (!data || !Array.isArray(data.pubkeys)) {
      return fail("OnlyBoosts booster index had no pubkeys array", corsHeaders);
    }

    return new Response(JSON.stringify({
      generated_at: Number.isFinite(data.generated_at) ? data.generated_at : null,
      count: data.pubkeys.length,
      pubkeys: data.pubkeys,
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${EDGE_TTL_SECONDS}`,
      },
    });
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return fail(
      isTimeout ? "OnlyBoosts booster index timed out" : "Failed to fetch OnlyBoosts booster index",
      corsHeaders
    );
  } finally {
    clearTimeout(timer);
  }
}

function fail(message, corsHeaders) {
  return new Response(message, { status: 502, headers: corsHeaders });
}

// Streams the body, aborting once cumulative bytes exceed the cap. resp.text()
// would buffer the whole thing into memory before the size could be checked.
// Returns null when the cap is blown.
async function readCapped(resp, ctrl) {
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
}
