/* Site-wide profile cache.
 *
 * Serves profiles.json off the VPS: a nightly kind-0 sweep covering every npub
 * this site displays anywhere — sats.csv senders, npubs mentioned in boost-wall
 * notes, RSS guests, and the co-host / contributor list. It replaces a batched
 * Primal user_infos round trip measured at 1.3-1.7 s on /supporters, /stats,
 * the homepage and the boost wall, all of which ran their own copy of that
 * ladder. Written nightly by bots/profiles at 09:45 UTC.
 *
 * Each record carries the raw signed kind-0 alongside its parsed fields, so
 * keep verifying client-side — this proxy is transport, not a source of trust.
 * See assets/js/profile-cache.js, which reads the rendered fields back out of
 * the verified event rather than trusting the parsed siblings.
 */
const PROFILES_URL = "https://relay.mynostr.app/profiles.json";

// Bound the upstream fetch: 10s wall-clock, 5 MB body cap. Same rationale as
// rss.js — an unbounded fetch could pin the Pages Function's CPU/memory
// budget. The file is ~190 KB for 152 profiles and grows only with the
// supporter roster, so this is a wide margin rather than a working limit.
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Exact-match origin allowlist — mirrors rss.js. `startsWith` checks let
// lookalike origins get reflected into Access-Control-Allow-Origin, so this
// stays an exact Set match, not a prefix check.
const ALLOWED_ORIGINS = new Set([
  "https://localbitcoiners.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

// ⚠️ This file is a JSON OBJECT keyed by hex pubkey, not an array — the guard
// here is `{` where boost-wall.js checks for `[`. Don't copy that one's check
// across; a map that passed an array test would sail through this and reach
// the page as an unusable shape.
function looksLikeJsonObject(text) {
  return typeof text === "string" && text.trimStart().startsWith("{");
}

function badUpstream(corsHeaders) {
  return new Response("Profiles upstream did not return JSON", {
    status: 502,
    headers: corsHeaders,
  });
}

function pickCorsOrigin(originHeader) {
  if (typeof originHeader === "string" && ALLOWED_ORIGINS.has(originHeader)) {
    return originHeader;
  }
  return "https://localbitcoiners.com";
}

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
    const resp = await fetch(PROFILES_URL, {
      headers: { "User-Agent": "LocalBitcoiners-Profiles-Proxy/1.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      return new Response("Profiles upstream returned an error", {
        status: 502,
        headers: corsHeaders,
      });
    }

    // ⚠️ resp.ok is NOT evidence the file exists. The upstream is a relay host,
    // and Caddy answers a path it doesn't serve with HTTP 200 and a 37-byte
    // body: "Please use a Nostr client to connect." Passing that through would
    // hand the page a 200 with Content-Type: application/json containing
    // English prose, and every avatar on the page would silently fall back to
    // a truncated npub instead of the live resolver. `looksLikeJsonObject`
    // below is the guard; it is a shape check, not a full parse, since parsing
    // ~190 KB in the Function just to re-serialize it would be wasted work.

    // Cheap pre-flight check on Content-Length. The streamed read below is
    // the real guard — a hostile/misbehaving upstream can omit or lie about
    // this header.
    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return new Response("Upstream profiles file exceeded size limit", {
        status: 502,
        headers: corsHeaders,
      });
    }

    // Stream the body, aborting once cumulative bytes exceed the cap.
    // resp.text() would buffer the whole thing into memory before we can
    // check size.
    const reader = resp.body?.getReader?.();
    if (!reader) {
      // Older runtime — fall back to text() with a length check.
      const text = await resp.text();
      if (text.length > RESPONSE_MAX_BYTES) {
        return new Response("Upstream profiles file exceeded size limit", {
          status: 502,
          headers: corsHeaders,
        });
      }
      if (!looksLikeJsonObject(text)) return badUpstream(corsHeaders);
      return new Response(text, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
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
        return new Response("Upstream profiles file exceeded size limit", {
          status: 502,
          headers: corsHeaders,
        });
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const json = new TextDecoder("utf-8").decode(buf);
    if (!looksLikeJsonObject(json)) return badUpstream(corsHeaders);

    return new Response(json, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return new Response(
      isTimeout ? "Profiles upstream timed out" : "Failed to fetch profiles",
      { status: 502, headers: corsHeaders }
    );
  } finally {
    clearTimeout(timer);
  }
}
