/**
 * BoostBox descriptor proxy — the lnaddress half of getting a boost to render
 * properly in Helipad.
 *
 * ## Why this exists at all
 *
 * A keysend leg carries its boostagram inline, in TLV record 7629169, and
 * Helipad reads it on the first HTLC. **An lnaddress leg has no such channel**:
 * it sends the raw message as an LNURL comment and stops, which lands in
 * Helipad's third and last tier — `app = "Lightning Invoice"`,
 * `sender = "Lightning Invoice"`, no show, no episode, and `value_msat_total`
 * left as the leg's own amount, so a podcaster is shown one leg's sats as
 * though that were the whole boost. Measured on a real Helipad, 2026-08-21.
 *
 * BoostBox implements podcast-namespace PR #734: POST the metadata, get a short
 * stable URL back, put that URL in the invoice description. Helipad HEADs the
 * URL and reads the full payload out of an `x-rss-payment` header.
 *
 * ## ⚠️ Four things that decided the shape of this file
 *
 * **⚠️ IT PROXIES BECAUSE OF THE KEY, NOT BECAUSE OF CORS.** That is the
 * opposite of `functions/api/lnurl.js`, which exists because recipients' own
 * servers omit `Access-Control-Allow-Origin`. Measured 2026-08-22, tardbox
 * answers with `access-control-allow-origin: *`, so the browser could call it
 * directly. It must not: the API key is shared and issued to us by name, and a
 * key shipped inside a 1MB public bundle is extractable by anyone, who could
 * then write records under our name and spend the operator's storage and rate
 * budget. The key lives in a secret binding and never leaves the edge.
 *
 * **⚠️ USE `tardbox.com`, NEVER `boostbox.cloud`.** Helipad's allowlist is
 * hardcoded in its own source (`src/boost.rs#should_fetch_metadata`):
 * `vec!["fountain.fm", "castamatic.com", "tardbox.com"]`. A podcaster-settable
 * `metadata_whitelist` is unioned with it and `fetch_metadata` defaults to
 * **false**, so a self-hosted instance needs every podcaster to add our domain
 * by hand. Worse, the upstream demo host answers a **HEAD with 405** — its
 * route declares only `:get`, and the `:head` handler exists only in the fork
 * tardbox runs. Re-verified live 2026-08-22: `tardbox.com` HEAD → 404 on an
 * unknown id (route present), `boostbox.cloud` HEAD → 405 while GET → 200. So
 * the documented host is the one Helipad cannot read.
 *
 * **⚠️ THE BODY IS AN ALLOWLIST, NOT A PASSTHROUGH.** These records are written
 * under our key and are served to podcasters as our attribution. Forwarding
 * whatever JSON the browser sends would let a caller put arbitrary fields into
 * a document that carries our name. `app_name` in particular is set here and is
 * not caller-settable, the same rule the `client` tag follows in
 * `functions/api/sign-boost.js`.
 *
 * **⚠️ IT FAILS CLOSED, AND FAILING IS CHEAP.** No key, no KV, a timeout or an
 * upstream error all answer without a descriptor, and the caller falls back to
 * the bare message — which is exactly what ships today. **A boost must never
 * fail because its metadata could not be stored.**
 *
 * ⚠️ IT IS EXCLUDED FROM THE SERVICE WORKER'S CACHE (`isUncacheableMoneyRequest`
 * in `sw.js`). It sits under `/api/`, where the default is network-first with a
 * cached copy served offline, and a cached answer here is a descriptor URL
 * pointing at a PREVIOUS boost's metadata — so the podcaster would be shown
 * another payment's message, amount and episode attached to this one. Same
 * class of mistake as serving a cached bolt11.
 */

const UPSTREAM = 'https://tardbox.com/boost';

// Bounded like every other outbound fetch in this directory: wall-clock
// timeout, byte cap, and a streamed read, because `resp.text()` buffers before
// the size can be checked. This one runs while a donor is watching a leg pay,
// so the timeout is tighter than /api/lnurl's 10s.
const FETCH_TIMEOUT_MS = 6_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_MAX_BYTES = 16 * 1024;

// ⚠️ HIGHER THAN THE SIGNING ORACLE'S 5/min, AND FOR A STRUCTURAL REASON: this
// is called once per lnaddress LEG, not once per boost. A value block with ten
// lnaddress recipients is ten POSTs from one press, so a 5/min ceiling would
// refuse an ordinary boost rather than an abusive one. Still bounded, and it
// shares the signing oracle's KV namespace under its own prefix so no second
// binding is needed.
const RATE_LIMIT = 60;
const RATE_WINDOW_SECS = 60;

// Our own attribution. Not caller-settable: it is what a podcaster reads as
// the sending app, and it must mean this site rather than whatever a caller
// typed. Matches APP_NAME in login-widget/src/lib/externalBoostagram.js.
const APP_NAME = 'Local Bitcoiners';

// The complete set of fields forwarded upstream, with the shape each must have.
// `action` is pinned rather than accepted: this endpoint serves boosts, and
// `stream` is a different product decision that would need its own thought.
// ⚠️ THE FIRST FOUR ARE THE ONLY STRINGS HELIPAD READS. Its `RssPayment` struct
// (src/metadata.rs) deserializes exactly nine fields — `action`, `app_name`,
// `feed_title`, `item_title`, `message`, `remote_feed_guid`,
// `remote_item_guid`, `sender_name`, `value_msat_total` — and silently drops
// everything else. `podcast` and `episode` were in this list and are NOT among
// them: they are the boostagram TLV's names for the same two facts, so the
// record stored them faithfully and the podcaster's row rendered with a sender,
// a total, and no show. The rest are BoostBox's own documented fields, kept
// because its web page displays them.
const STRING_FIELDS = [
  'feed_title', 'item_title', 'message', 'sender_name',
  'remote_feed_guid', 'remote_item_guid',
  'sender_id', 'recipient_name', 'recipient_address',
  'feed_guid', 'item_guid', 'group', 'url',
];

// The fields a podcaster's Helipad actually renders. Exported so the test can
// assert on them by name rather than on the shape of the whole body.
export const HELIPAD_READS = ['feed_title', 'item_title', 'message', 'sender_name'];
const MAX_STRING_LEN = 512;

// Control characters, stripped from every forwarded string. The payload is
// URL-encoded into an HTTP response header upstream and rendered into a page,
// and neither wants them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// A leg cannot pay more than the boost it belongs to, and neither may exceed
// the cap the rest of the money path already enforces.
const MAX_MSAT = 5_000_000_000; // 5M sats, matching MAX_AMOUNT_MSAT in sign-boost.js

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Belt and braces with the service-worker exclusion above: a descriptor
      // is valid for exactly one payment.
      'Cache-Control': 'no-store',
    },
  });
}

/** Fixed-window KV counter, keyed on the edge-set client address. Shares the
 *  signing oracle's namespace under a prefix of its own. */
export async function overRateLimit(kv, ip, now = Date.now()) {
  const window = Math.floor(now / 1000 / RATE_WINDOW_SECS);
  const key = `boostbox:${ip}:${window}`;
  const current = Number(await kv.get(key)) || 0;
  if (current >= RATE_LIMIT) return true;
  await kv.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_SECS * 2 });
  return false;
}

/**
 * The metadata document, built field by field from the caller's body.
 *
 * ⚠️ EVERY FIELD IS COPIED EXPLICITLY AND NOTHING IS SPREAD. A spread would
 * carry whatever else the caller sent into a record published under our key,
 * and the failure would be invisible from here — the upstream stores it and a
 * podcaster reads it.
 */
export function buildRecord(body) {
  if (!body || typeof body !== 'object') throw new Error('bad request');

  const valueMsat = Number(body.value_msat);
  const totalMsat = Number(body.value_msat_total);
  for (const v of [valueMsat, totalMsat]) {
    if (!Number.isInteger(v) || v < 1 || v > MAX_MSAT) throw new Error('invalid amount');
  }
  // ⚠️ THE LEG CANNOT EXCEED ITS OWN BOOST. Upstream validates each field
  // independently, so nothing there would catch a leg claiming more than the
  // total it belongs to — and that pair is exactly what a podcaster reads as
  // "N sats of M". Rejecting here keeps the two figures coherent.
  if (valueMsat > totalMsat) throw new Error('invalid amount');

  // A leg's share of the whole, which is what Helipad renders as "(33% split)".
  //
  // ⚠️ THE DECLARED SPLIT IS PREFERRED OVER THE REALISED ONE, and deriving it
  // was wrong in a way only a live test showed. `distributeSats` floors every
  // leg, so a 33% leg of a 111-sat boost is 36 sats and reads back as 32.4%.
  // The first version derived from the two amounts and published `32` where the
  // show's own value block declares `33`. Every other app reports the
  // publisher's declared number, and rows are only comparable across apps if
  // ours does too.
  //
  // It is still bounded here rather than trusted: this is a display figure in a
  // record published under our name, so a caller may not put an arbitrary
  // number in it, and an absent or unusable one still falls back to the
  // derivation.
  const declared = Number(body.split);
  const split = (Number.isFinite(declared) && declared > 0 && declared <= 100)
    ? declared
    : Math.round((valueMsat / totalMsat) * 100);

  const record = {
    action: 'boost',
    app_name: APP_NAME,
    split,
    value_msat: valueMsat,
    value_msat_total: totalMsat,
    timestamp: new Date().toISOString(),
  };

  for (const key of STRING_FIELDS) {
    const raw = body[key];
    if (typeof raw !== 'string') continue;
    const clean = raw.replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_STRING_LEN);
    if (clean) record[key] = clean;
  }
  return record;
}

/** Stream the body, bailing once cumulative bytes exceed the cap. */
async function readBounded(resp, ctrl, cap = RESPONSE_MAX_BYTES) {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    return text.length > cap ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
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
  return new TextDecoder('utf-8').decode(buf);
}

export async function onRequestPost({ request, env }) {
  const apiKey = env.BOOSTBOX_API_KEY;
  if (!apiKey || typeof apiKey !== 'string') {
    return json({ error: 'boost metadata service not configured' }, 503);
  }
  const kv = env.SIGN_RATELIMIT;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return json({ error: 'boost metadata service not configured' }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  if (await overRateLimit(kv, ip)) {
    return json({ error: 'rate limited' }, 429);
  }

  const raw = await request.text();
  if (raw.length > REQUEST_MAX_BYTES) return json({ error: 'request too large' }, 413);

  let record;
  try {
    record = buildRecord(JSON.parse(raw));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'bad request' }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The one place the key appears, on an outbound request from the edge.
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify(record),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    // ⚠️ NOT AN ERROR THE CALLER SHOULD ACT ON. A missing descriptor means the
    // bare message, which is what shipped before this existed.
    return json({ error: 'upstream unavailable' }, 502);
  }

  const text = await readBounded(upstream, ctrl);
  clearTimeout(timer);

  if (!upstream.ok || text === null) {
    // ⚠️ THE UPSTREAM'S STATUS IS REPORTED AND ITS BODY IS NOT. A 401 here means
    // our key is wrong, which is an operator problem and not something to print
    // into a donor's browser; and unlike `/api/lnurl`, the party on the other
    // end is our own vendor rather than the recipient the donor is paying, so
    // there is no explanation of theirs that belongs in front of the donor.
    return json({ error: 'upstream refused', status: upstream.status }, 502);
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { return json({ error: 'upstream refused' }, 502); }

  const url = typeof parsed?.url === 'string' ? parsed.url : '';
  const id = typeof parsed?.id === 'string' ? parsed.id : '';
  if (!url || !id || !url.startsWith('https://')) {
    return json({ error: 'upstream refused' }, 502);
  }

  // ⚠️ `desc` IS DELIBERATELY NOT RETURNED, AND THAT IS A TRAP AVOIDED RATHER
  // THAN A FIELD FORGOTTEN. Upstream builds one as
  // `rss::payment::boost <url> <message>` with no knowledge of the recipient's
  // `commentAllowed`, which is 255 at Alby. A caller that used it would send a
  // comment the recipient truncates FROM THE RIGHT, shortening the URL into a
  // dead link while having spent the whole allowance on it. The comment is
  // assembled by `buildLnurlComment`, which is whole-or-nothing about the URL.
  return json({ id, url }, 200);
}
