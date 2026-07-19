"""lnbits payment enrichment for the sats-log pipeline.

Why this exists
---------------
When Reed's value-block LN address moved from ``reed@getalby.com`` to
``reed@localbitcoiners.com`` (self-hosted lnbits on a Start9), the identifying
LNURL *comment* on address/invoice boosts stopped reaching the node-level
transaction. getalby reflected the payer comment (``LocalBitcoinersEpNNN`` for
the website, ``rss::payment::boost …`` for Fountain) as the invoice
description, which is exactly what ``classify_lb_tx`` keys on. lnbits instead
stamps its own static pay-link memo ("reeds local bitcoiners address") on the
node record and keeps the real comment only in its own database — verified: the
Alby Hub tx carries the comment nowhere.

So for address boosts, lnbits is the *only* place the comment survives. This
module reads lnbits' payments API and patches each Alby Hub tx's ``description``
back to the real comment, keyed by payment hash, before classification runs.

Scope
-----
Keysend boosts (Castamatic et al.) go to the node pubkey with a TLV boostagram
and never touch the LN address — they are untouched by this module and keep
flowing straight from Alby Hub. Only address/LNURL receives (website legs +
Fountain) carry a comment in lnbits.

Connectivity
------------
lnbits lives at a Start9 ``.local`` mDNS name with a self-signed cert, so we
connect by hostname (StartOS routes by SNI/Host — a bare-IP connection would
not reach the container) with TLS verification disabled. Under systemd the
``.local`` name resolves via a static ``/etc/hosts`` entry on the bot host.

All failures are swallowed and logged: a down/unreachable lnbits must degrade
to "no enrichment this run" (address boosts simply go undetected until it's
back), never crash the run or corrupt existing data.
"""

import requests
import urllib3

# Start9's self-signed cert would otherwise spam InsecureRequestWarning on
# every call. We connect by the correct hostname over the LAN; the cert just
# isn't CA-signed.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# lnbits caps a single /payments response; walk pages until we've seen the
# recent window. sats-log only needs comments for txs newer than its cursor
# (minutes-to-hours old on the 5-min cadence), so a few hundred rows is plenty,
# but we page defensively in case of a burst or a catch-up run.
_PAGE = 500
_MAX_PAGES = 8


def _headers(config):
    return {"X-Api-Key": config["LNBITS_READ_KEY"]}


def fetch_lnbits_payments(config, limit=_PAGE, offset=0, timeout=20):
    """Fetch one page of lnbits payments (newest first). Returns a list of raw
    payment dicts. Raises on transport/HTTP error — callers that need the
    fail-safe behaviour should use :func:`build_comment_map`."""
    base = config["LNBITS_URL"].rstrip("/")
    resp = requests.get(
        f"{base}/api/v1/payments",
        headers=_headers(config),
        params={"limit": limit, "offset": offset},
        timeout=timeout,
        verify=False,
    )
    resp.raise_for_status()
    return resp.json()


def build_comment_map(config, max_pages=_MAX_PAGES):
    """Return ``{payment_hash: comment}`` for recent *incoming* lnbits payments
    that carry an LNURL comment.

    Never raises: on any error it logs a warning and returns whatever it has
    gathered so far (possibly empty), so a broken lnbits leaves the rest of the
    run intact rather than blowing it up (cf. the Alby-401 silent-drop
    incident — we want the opposite: fail *loud-ish* and *safe*, not silent and
    destructive).
    """
    if not config.get("LNBITS_URL") or not config.get("LNBITS_READ_KEY"):
        print("  [lnbits] no LNBITS_URL / LNBITS_READ_KEY configured — skipping enrichment")
        return {}

    comment_map = {}
    for page in range(max_pages):
        offset = page * _PAGE
        try:
            payments = fetch_lnbits_payments(config, limit=_PAGE, offset=offset)
        except Exception as e:
            print(f"  [lnbits][warn] payments fetch failed at offset {offset}: {e}")
            break
        if not payments:
            break
        for p in payments:
            # Incoming only. lnbits reports incoming as positive msats; outgoing
            # is negative. The comment lives in extra.comment for lnurlp receives.
            amount = p.get("amount", 0) or 0
            if amount <= 0:
                continue
            extra = p.get("extra") or {}
            comment = (extra.get("comment") or "").strip()
            if not comment:
                continue
            ph = p.get("payment_hash") or p.get("checking_id")
            if ph:
                comment_map.setdefault(ph, comment)
        if len(payments) < _PAGE:
            break
    print(f"  [lnbits] built comment map: {len(comment_map)} commented receives")
    return comment_map


def enrich_txs(txs, comment_map):
    """Patch Alby Hub txs in place: where a tx's payment hash has an lnbits
    comment, overwrite ``description`` with it (stashing the original under
    ``_lnbits_original_description`` for audit). Returns the count patched.

    Only txs present in ``comment_map`` — i.e. lnbits address receives with a
    real comment — are touched; keysend and legacy getalby txs pass through
    untouched, so this is safe to run over the full page."""
    if not comment_map:
        return 0
    patched = 0
    for tx in txs:
        ph = tx.get("paymentHash") or ""
        comment = comment_map.get(ph)
        if not comment:
            continue
        if tx.get("description") == comment:
            continue
        tx["_lnbits_original_description"] = tx.get("description", "")
        tx["description"] = comment
        patched += 1
    return patched
