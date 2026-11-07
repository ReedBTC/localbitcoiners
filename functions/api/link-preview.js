// Link previews for URLs inside boost notes: /api/link-preview?url=<https://…>
//
// Fetches the page once at the edge, reads its Open Graph / Twitter card tags
// and answers a small JSON card the renderer paints under the link
// (assets/js/link-preview.js). The browser never fetches the third-party page
// itself: most sites send no CORS headers, and the site's CSP would not let it
// anyway. The target check and the parse are pure functions in
// functions/_shared/link-preview-parse.js, tested by scripts/test-link-preview.mjs.
//
// Answers, all JSON:
//   { kind: "page",  url, title, description, image, siteName, host }
//   { kind: "image", url, contentType }   the URL itself serves an image, so
//                                          the renderer shows it inline instead
//   { kind: "none" }                        nothing to show (no title, not HTML,
//                                          upstream error); still a 200 so the
//                                          browser caches the miss too
//
// ⚠️ EVERY FIELD IS PASSED THROUGH FROM AN UNTRUSTED PAGE. The renderer sets
// text with textContent and only hands an http(s) image URL to <img>; nothing
// here reaches innerHTML. The target is refused when it is not a public
// http(s) host (loopback, private ranges, odd ports), and the response body is
// read to a 256 KB cap under an 8 s deadline.

import { previewTargetProblem, parseLinkPreview } from "../_shared/link-preview-parse.js";

const FETCH_TIMEOUT_MS = 8_000;
const BODY_MAX_BYTES = 256 * 1024;
const CACHE_SECONDS = 86_400;

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

function json(body, corsOrigin, status = 200, cache = true) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache ? `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}` : "no-store",
      "Access-Control-Allow-Origin": corsOrigin,
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Read at most BODY_MAX_BYTES of the body, then stop pulling. A page's meta
// tags are in <head>; the rest of the document is never needed.
async function readHead(resp, ctrl) {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    return text.slice(0, BODY_MAX_BYTES);
  }
  const chunks = [];
  let total = 0;
  while (total < BODY_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { ctrl.abort(); } catch {}
  try { reader.cancel(); } catch {}
  const buf = new Uint8Array(Math.min(total, BODY_MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, buf.length - off);
    if (n <= 0) break;
    buf.set(c.subarray(0, n), off);
    off += n;
  }
  return new TextDecoder("utf-8").decode(buf);
}

export async function onRequest(context) {
  const corsOrigin = pickCorsOrigin(context.request.headers.get("Origin") || "");
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      },
    });
  }
  if (context.request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { "Access-Control-Allow-Origin": corsOrigin } });
  }

  const target = new URL(context.request.url).searchParams.get("url") || "";
  const problem = previewTargetProblem(target);
  if (problem) return json({ kind: "none", error: problem }, corsOrigin, 400, false);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LocalBitcoiners-LinkPreview/1.0; +https://localbitcoiners.com)",
        "Accept": "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5",
        "Accept-Language": "en",
      },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      signal: ctrl.signal,
    });
    if (!resp.ok) return json({ kind: "none", error: `upstream ${resp.status}` }, corsOrigin);

    const ctype = (resp.headers.get("Content-Type") || "").toLowerCase();
    const finalUrl = resp.url || target;

    // The link itself is a picture (an upload with no extension, a redirect
    // to one): the renderer shows it inline, no card needed.
    if (ctype.startsWith("image/")) {
      try { ctrl.abort(); } catch {}
      // The final URL after redirects is also refused when it left the public
      // web, the same rule as the request.
      if (previewTargetProblem(finalUrl)) return json({ kind: "none", error: "redirect-target" }, corsOrigin);
      return json({ kind: "image", url: finalUrl, contentType: ctype.split(";")[0].trim() }, corsOrigin);
    }
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml")) {
      try { ctrl.abort(); } catch {}
      return json({ kind: "none", error: "not-html" }, corsOrigin);
    }

    const html = await readHead(resp, ctrl);
    const card = parseLinkPreview(html, finalUrl);
    if (!card) return json({ kind: "none", error: "no-title" }, corsOrigin);
    return json({ kind: "page", ...card }, corsOrigin);
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return json({ kind: "none", error: aborted ? "timeout" : "fetch-failed" }, corsOrigin, 200, false);
  } finally {
    clearTimeout(timer);
  }
}
