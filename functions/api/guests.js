// /api/guests — the deduped roster of podcast guest npubs.
//
// Guests are encoded per-episode in the RSS shownotes as
// `[guests: npub1…, npub1…]` (the same tags functions/_middleware.js
// parses to render the Guests pills on each /ep### page). This endpoint
// fetches the feed once, collects every guest npub across all episodes,
// dedupes, and returns them as JSON so the Supporters page can render a
// "Show Guests" section without pulling and parsing the whole feed in
// the browser. Same-origin, so no CORS headers are needed. Edge-cached.

const RSS_URL = "https://serve.podhome.fm/rss/56fbb1aa-da79-5e4b-bebc-3b934ab8914c";
const FETCH_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024; // RSS feeds are <500KB in practice
// Same validation _middleware.js uses — bech32 npub, exactly 58 data chars.
const NPUB_RE = /^npub1[02-9ac-hj-np-z]{58}$/;

export async function onRequest(context) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(RSS_URL, {
      headers: { "User-Agent": "LocalBitcoiners-Guests/1.0" },
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return json({ guests: [], error: "feed_error" }, 502);

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return json({ guests: [], error: "too_large" }, 502);
    }
    const xml = await resp.text();
    if (xml.length > RESPONSE_MAX_BYTES) {
      return json({ guests: [], error: "too_large" }, 502);
    }

    const seen = new Set();
    const guests = [];
    const re = /\[guests:\s*([^\]]+)\]/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      for (const part of m[1].split(",")) {
        const npub = part.trim();
        if (NPUB_RE.test(npub) && !seen.has(npub)) {
          seen.add(npub);
          guests.push(npub);
        }
      }
    }

    return json(
      { guests, count: guests.length, generated_at: new Date().toISOString() },
      200,
    );
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return json({ guests: [], error: isTimeout ? "timeout" : "fetch_failed" }, 502);
  } finally {
    clearTimeout(timer);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
