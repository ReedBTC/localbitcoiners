/**
 * Keysend well-known proxy — the lookup that turns an lnaddress leg into a
 * real keysend, so the boostagram rides in the HTLC instead of a comment.
 *
 * ⚠️ THIS ONE MUST BE PROXIED, AND FOR A DIFFERENT REASON THAN `/api/lnurl`.
 * LNURL is browser-facing by design, so those endpoints send CORS headers
 * almost universally and our proxy there is a *fallback* for the minority that
 * do not. `/.well-known/keysend/<name>` is a server-to-server convention —
 * podcast apps do this lookup from their backend — so providers generally set
 * no access-control headers on it at all. A direct browser fetch is therefore
 * blocked for a HEALTHY endpoint, and the client's catch reads that as "this
 * address publishes no keysend document", silently downgrading every leg back
 * to LNURL. That is exactly how BMB's own upgrade never fired. So this is the
 * route rather than the fallback, and there is no direct attempt before it.
 *
 * ⚠️ IT ACCEPTS A LIGHTNING ADDRESS, NEVER A URL — the same rule `/api/lnurl`
 * holds. The whole URL is built here from the address and the path is a
 * constant, so a caller cannot steer the outbound fetch.
 *
 * ⚠️ A NON-2xx IS THE ORDINARY CASE HERE, WHICH IS WHY THIS DOES NOT SHARE
 * `/api/lnurl`'s helpers. Most lightning addresses are LNURL-only and answer
 * this path 404, so that Function's contract — mirror the upstream status and
 * surface the recipient's own explanation to the donor — is wrong twice over:
 * there is no donor-facing failure to report (the leg pays over LNURL either
 * way) and a mirrored 404 would read as an error rather than an answer.
 * **Everything that is not a usable document is one 404 with one reason.**
 *
 * ⚠️ A 200 IS NOT A PROMISE OF JSON. `primal.net` serves its SPA's HTML with
 * HTTP 200 for unknown paths, which is three legs of the measured top-30
 * corpus. That is the same absent-endpoint case as a 404 and gets the same
 * answer; the client's strict pubkey check is the second line of defence.
 *
 * The document goes back verbatim. `keysendLookup.js` is the single parser, so
 * the shape rules (`pubkey` / `destination` / `nodeId`, the customKey pairing,
 * the strict node-pubkey regex) live in one file rather than two that drift.
 *
 * ⚠️ NOT RATE LIMITED, DELIBERATELY, AND THE SYMMETRY IS THE ARGUMENT.
 * `/api/lnurl` is the same shape — an unauthenticated GET that fetches one
 * fixed path from a host named in a public value block — and carries no
 * counter either. `/api/boostbox` has one because it WRITES, under our own API
 * key, to a third party. Nothing is spent here. If a counter is ever added it
 * belongs on both of these together, not on this one alone.
 */

// Shorter than the client's own 4.5s budget, so the route answers "no
// endpoint" rather than having the caller abort first and lose the miss it
// would otherwise have cached. This runs inside a boost someone is watching.
const FETCH_TIMEOUT_MS = 3_500;

// A keysend document is a node pubkey and an optional routing pair. 64KB is
// three orders of magnitude of slack; its job is stopping a hostile endpoint
// streaming forever, not policing a real response.
const RESPONSE_MAX_BYTES = 64 * 1024;

const MAX_ADDR_CHARS = 256;

// Same expression `/api/lnurl` and the client validate with. Kept in step by
// hand: a Pages Function has no build step and cannot import from
// `login-widget/src`.
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/**
 * `name@host` → `{ name, host }`, or null.
 *
 * Exported for `scripts/test-keysend-upgrade.mjs`. The hostname round-trip is
 * what rejects a value carrying a port, a path, credentials or a unicode
 * confusable — anything that would make the URL we build name a different
 * host than the address claims. The value block this address came from is
 * third-party text.
 */
export function parseAddress(raw) {
  const addr = String(raw || "").trim().toLowerCase();
  if (!addr || addr.length > MAX_ADDR_CHARS) return null;
  if (addr.indexOf("@") !== addr.lastIndexOf("@")) return null;
  if (!LUD16_RE.test(addr)) return null;
  const [name, domain] = addr.split("@");
  if (!name || !domain) return null;
  let host;
  try {
    host = new URL(`https://${domain}`).hostname;
  } catch {
    return null;
  }
  if (host !== domain) return null;
  return { name, host };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parsed = parseAddress(url.searchParams.get("addr"));
  if (!parsed) return json({ reason: "Invalid lightning address" }, 400);

  const target = `https://${parsed.host}/.well-known/keysend/${encodeURIComponent(parsed.name)}`;
  const data = await getJson(target);
  if (data === null) return json({ reason: "no keysend endpoint" }, 404);

  return json(data, 200);
}

/**
 * One bounded upstream fetch. Returns the parsed body, or null for every
 * failure there is — a 404, a timeout, an unreachable host, an over-large
 * body, an SPA shell, junk JSON. The caller has one answer for all of them
 * because the leg has one behaviour for all of them: stay on LNURL.
 */
async function getJson(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": "LocalBitcoiners-Keysend-Lookup/1.0", Accept: "application/json" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) return null;

    const text = await readBounded(resp, ctrl);
    if (text === null) return null;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Stream the body, bailing once cumulative bytes exceed the cap. `resp.text()`
// buffers the whole thing before the size can be checked, which is the point
// of the exercise against a host we do not control.
async function readBounded(resp, ctrl) {
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
      try { ctrl?.abort(); } catch {}
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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // ⚠️ A CACHED KEYSEND DOCUMENT IS A ROUTING TARGET FOR MONEY. It names
      // the node a payment is addressed to and the sub-account record that
      // routes it there, so a stale copy pays the wrong destination — the same
      // class of harm as `/api/value`'s stale split. The client keeps its own
      // six-hour in-memory cache, which dies with the page; nothing about this
      // answer should outlive that. See `isUncacheableMoneyRequest` in sw.js.
      "Cache-Control": "no-store",
    },
  });
}
