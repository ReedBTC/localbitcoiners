const UPSTREAM_URL = "https://relay.mynostr.app/community_market.json";

// Bound the upstream fetch: 10s wall-clock, 10 MB body cap. Same rationale
// as rss.js — an unbounded fetch could pin the Pages Function's CPU/memory
// budget. The cap is generous (current file is ~850KB) since this grows
// hourly as the community-feeds bot (bots/community-feeds/) finds new
// content; episodes/shows are deduped so growth tapers, but leave headroom.
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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
    const resp = await fetch(UPSTREAM_URL, {
      headers: { "User-Agent": "LocalBitcoiners-CommunityMarket-Proxy/1.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      return new Response("Community marketplace upstream returned an error", {
        status: 502,
        headers: corsHeaders,
      });
    }

    // Cheap pre-flight check on Content-Length. The streamed read below is
    // the real guard — a hostile/misbehaving upstream can omit or lie about
    // this header.
    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return new Response("Upstream community marketplace file exceeded size limit", {
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
        return new Response("Upstream community marketplace file exceeded size limit", {
          status: 502,
          headers: corsHeaders,
        });
      }
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
        return new Response("Upstream community marketplace file exceeded size limit", {
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
      isTimeout ? "Community marketplace upstream timed out" : "Failed to fetch community marketplace",
      { status: 502, headers: corsHeaders }
    );
  } finally {
    clearTimeout(timer);
  }
}
