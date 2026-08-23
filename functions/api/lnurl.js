/**
 * LNURL-pay proxy — the fallback path for a lightning address whose server
 * sends no CORS headers.
 *
 * ⚠️ WHY THIS EXISTS, BECAUSE THE FAILURE IS INVISIBLE FROM THE INSIDE.
 * `fetchLnurlMeta` and `fetchLnurlInvoice` run in the browser, and a
 * cross-origin response with no `Access-Control-Allow-Origin` is unreadable to
 * JavaScript however healthy the server is. The big custodial providers
 * (getalby.com, fountain.fm) send `*` and always have, so every leg we had ever
 * measured worked; a SELF-HOSTED lightning address generally sends nothing, and
 * that leg dies before an invoice is ever requested. Measured 2026-08-21 on
 * `spencer@bowlafterbowl.com` — 44% of that show's value block — where the
 * metadata document, the keysend document and the invoice callback all answer
 * 200 with no access-control headers at all.
 *
 * The browser still SENDS those requests; it just refuses to hand us the
 * answer. So nothing upstream logs an error, and on our side it surfaces as a
 * generic fetch failure indistinguishable from the host being down.
 *
 * ⚠️ THE CLIENT TRIES THE RECIPIENT DIRECTLY FIRST AND ONLY FALLS BACK HERE.
 * A host that works today is not routed through this Function at all, so a
 * Pages outage cannot take down a boost path that never needed us. See
 * `lnurlProxyUrl` in `login-widget/src/lib/boostagram.js`.
 *
 * ⚠️ IT ACCEPTS A LIGHTNING ADDRESS, NEVER A URL. Every URL is built here from
 * the address, which is what keeps this from being an open proxy: a caller
 * cannot steer the outbound fetch at all. The callback returned by the
 * recipient's own metadata is held to the same host rule the client applies
 * (`CALLBACK_HOST_ALLOWLIST`), so a compromised lud16 server cannot redirect
 * the invoice request onto an unrelated host using our egress.
 *
 * Two modes, mirroring the two browser fetches it replaces:
 *
 *   GET /api/lnurl?addr=name@host                      → the metadata document
 *   GET /api/lnurl?addr=name@host&amount=<msat>&...    → { pr, verify }
 *
 * ⚠️ AN UPSTREAM ERROR IS MIRRORED, NOT SWALLOWED. `readErrorReason` on the
 * client reads `{reason}` / `{error}` / `{message}` out of a failed response
 * and prints it as "Their Lightning provider said: …", which is often the only
 * account a donor gets of why a leg failed. Answering 502 with our own wording
 * here would delete that. The upstream status and its reason are passed
 * through unchanged.
 */

const FETCH_TIMEOUT_MS = 10_000;
// LNURL documents are a few hundred bytes. The cap is three orders of
// magnitude above that because its job is stopping a hostile endpoint
// streaming forever, not policing a legitimate response.
const RESPONSE_MAX_BYTES = 256 * 1024;
const ERROR_BODY_CAP = 2048;
const ERROR_MSG_CHARS = 180;
const MAX_COMMENT_CHARS = 500;

// Same expression the client validates with. Kept in step by hand: this
// Function has no build step and cannot import from `login-widget/src`.
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// Mirrors CALLBACK_HOST_ALLOWLIST in boostagram.js. Wallet of Satoshi serves
// its lud16 from one domain and its invoices from another.
const CALLBACK_HOST_ALLOWLIST = {
  "walletofsatoshi.com": ["livingroomofsatoshi.com"],
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const addr = (url.searchParams.get("addr") || "").trim().toLowerCase();

  if (!LUD16_RE.test(addr)) {
    return json({ reason: "Invalid lightning address" }, 400);
  }
  const [name, domain] = addr.split("@");

  const amountRaw = url.searchParams.get("amount");
  const wantsInvoice = amountRaw !== null;

  let amountMsats = 0;
  if (wantsInvoice) {
    // Plain digits only. `Number('1e6')` is a finite integer, and a string
    // reading as one amount to us and another to the recipient's server is
    // the last thing that belongs on a money path.
    if (!/^\d{1,15}$/.test(amountRaw)) {
      return json({ reason: "Invalid amount" }, 400);
    }
    amountMsats = Number(amountRaw);
    if (amountMsats <= 0) return json({ reason: "Invalid amount" }, 400);
  }

  let metaUrl;
  try {
    metaUrl = new URL(
      `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
    );
    // Reject a domain that normalises to something else — a bare IP or a
    // unicode confusable that slipped past the regex.
    if (metaUrl.hostname !== domain) {
      return json({ reason: "Invalid lightning address host" }, 400);
    }
  } catch {
    return json({ reason: "Invalid lightning address host" }, 400);
  }

  const meta = await getJson(metaUrl.toString());
  if (meta.error) return meta.error;
  const data = meta.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return json({ reason: "LNURL metadata was not an object" }, 502);
  }
  if (typeof data.callback !== "string" || !data.callback.startsWith("https://")) {
    return json({ reason: "LNURL metadata missing a valid https callback" }, 502);
  }

  if (!wantsInvoice) {
    // The document goes back as the recipient published it. The client still
    // runs its own shape checks on it, so this is a transport, not a filter.
    return json(data, 200);
  }

  let cbUrl;
  try {
    cbUrl = new URL(data.callback);
  } catch {
    return json({ reason: "LNURL callback was not a valid URL" }, 502);
  }
  const cbHost = cbUrl.hostname.toLowerCase();
  const allowed = CALLBACK_HOST_ALLOWLIST[domain] || [];
  if (
    cbHost !== domain &&
    !cbHost.endsWith("." + domain) &&
    !allowed.includes(cbHost)
  ) {
    return json(
      { reason: `LNURL callback host ${cbHost} does not belong to ${domain}` },
      502,
    );
  }

  cbUrl.searchParams.set("amount", String(amountMsats));
  const comment = (url.searchParams.get("comment") || "").slice(0, MAX_COMMENT_CHARS);
  if (comment) cbUrl.searchParams.set("comment", comment);

  const inv = await getJson(cbUrl.toString());
  if (inv.error) return inv.error;
  const body = inv.data;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ reason: "Invoice response was not an object" }, 502);
  }
  // A LUD-06 error arrives with HTTP 200 and a status field, so it is caught
  // here rather than by the status check inside getJson.
  if (body.status === "ERROR") {
    return json({ reason: body.reason || "Unknown error from server" }, 502);
  }
  if (typeof body.pr !== "string" || !body.pr.toLowerCase().startsWith("lnbc")) {
    return json({ reason: "Invoice response missing a valid bolt11" }, 502);
  }

  // Only the two fields the caller uses. The amount is verified on the client,
  // against the figure the wallet is about to be handed.
  return json(
    { pr: body.pr, verify: typeof body.verify === "string" ? body.verify : null },
    200,
  );
}

/**
 * One bounded upstream fetch. Returns `{ data }` or `{ error: Response }`.
 *
 * The failure path mirrors the upstream status so the client's own error
 * handling behaves exactly as it does on the direct path — including the rule
 * that a 4xx is never retried.
 */
async function getJson(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": "LocalBitcoiners-LNURL-Proxy/1.0", Accept: "application/json" },
      redirect: "follow",
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const reason = await readReason(resp);
      return {
        error: json(
          { reason: reason || `Request failed (${resp.status})` },
          resp.status,
        ),
      };
    }

    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > RESPONSE_MAX_BYTES) {
      return { error: json({ reason: "Upstream response too large" }, 502) };
    }

    const text = await readBounded(resp, ctrl);
    if (text === null) {
      return { error: json({ reason: "Upstream response too large" }, 502) };
    }
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { error: json({ reason: "Upstream returned malformed JSON" }, 502) };
    }
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    return {
      error: json(
        { reason: isTimeout ? "Lightning provider timed out" : "Could not reach the lightning provider" },
        502,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

// The recipient's own explanation, bounded and stripped, in the three shapes
// LUD-06 and the wild actually use.
async function readReason(resp) {
  try {
    const cl = parseInt(resp.headers.get("content-length") || "", 10);
    if (Number.isFinite(cl) && cl > ERROR_BODY_CAP) return "";
    const text = await readBounded(resp, null, ERROR_BODY_CAP);
    if (text === null) return "";
    let data = null;
    try { data = JSON.parse(text); } catch { return ""; }
    const raw = data?.reason || data?.error || data?.message || "";
    if (typeof raw !== "string" || !raw) return "";
    return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, ERROR_MSG_CHARS);
  } catch {
    return "";
  }
}

// Stream the body, bailing once cumulative bytes exceed the cap. `resp.text()`
// buffers the whole thing before the size can be checked.
async function readBounded(resp, ctrl, cap = RESPONSE_MAX_BYTES) {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    return text.length > cap ? null : text;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
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
      // Same-origin only. The browser sends this from our own page, and a
      // wildcard would make our egress available to any site.
      "Cache-Control": "no-store",
    },
  });
}
