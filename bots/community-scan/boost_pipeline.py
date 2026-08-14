#!/usr/bin/env python3
"""Boost side of the unified community scan.

Pure processing: takes raw kind-1 events the orchestrator fetched, classifies
the real community podcast-boosts out of them, and folds them into the
community_boosts.json shape (with the persistent item_guid→url map + Podcast
Index show/episode enrichment). Owns NO relay-scan or tier/cursor logic — the
orchestrator (community_scan.py) does the fetching and hands events in.

All the classification / zap-receipt / Podcast Index logic is lifted verbatim
from the standalone community-boosts bot it replaces; see that bot's module
docstring for the boost-detection rules and Fountain quirks.
"""

import html
import re
import time
from datetime import datetime, timezone

import bech32
import requests
import websocket

from nostr_utils import hex_to_npub, BOOST_SCAN_RELAYS
from boost_formatter import strip_fountain_trailer, LB_FEED_GUID

PODCAST_INDEX_BASE = "https://api.podcastindex.org/api/1.0"


# ── zap-receipt lookup (a boost with no amount tag may wrap a kind-9735) ───────
def fetch_event_by_id(event_id, relays, timeout=8, max_wall_seconds=15):
    import json
    for relay in relays:
        try:
            ws = websocket.create_connection(relay, timeout=timeout)
            sub = "ev_" + event_id[:8]
            ws.send(json.dumps(["REQ", sub, {"ids": [event_id]}]))
            found = None
            deadline = time.monotonic() + max_wall_seconds
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                ws.settimeout(max(0.1, min(timeout, remaining)))
                try:
                    msg = json.loads(ws.recv())
                except websocket.WebSocketTimeoutException:
                    break
                except Exception:
                    break
                if not isinstance(msg, list) or not msg:
                    continue
                if msg[0] == "EVENT" and len(msg) >= 3:
                    found = msg[2]
                elif msg[0] == "EOSE":
                    break
            ws.close()
            if found:
                return found
        except Exception:
            continue
    return None


# ── bech32 quote-ref decoding (note1.../nevent1... embedded in content) ──────
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_QUOTE_RE = re.compile(r'(?:nostr:)?(?<!\w)(note1[02-9ac-hj-np-z]+|nevent1[02-9ac-hj-np-z]+)', re.IGNORECASE)


def decode_note_or_nevent(token):
    """Decode a bare note1.../nevent1... token to its 32-byte event id (hex),
    or None. Manual bech32 split (not pynostr's bech32_decode) since that
    rejects strings over 90 chars, which nevents routinely exceed."""
    s = token.lower()
    if s.startswith("note1"):
        is_note = True
    elif s.startswith("nevent1"):
        is_note = False
    else:
        return None
    five = [_BECH32_CHARSET.find(c) for c in s[s.rfind("1") + 1:]]
    if len(five) < 7 or any(v < 0 for v in five):
        return None
    data = bech32.convertbits(five[:-6], 5, 8, False)  # drop 6-char checksum
    if data is None:
        return None
    if is_note:
        return bytes(data).hex() if len(data) == 32 else None
    i = 0
    while i + 1 < len(data):
        t, ln = data[i], data[i + 1]
        val = bytes(data[i + 2:i + 2 + ln])
        if t == 0 and len(val) == 32:
            return val.hex()
        i += 2 + ln
    return None


_BOLT11_RE = re.compile(r'^ln(?:bc|tb)(\d+)([munp]?)', re.IGNORECASE)
_BOLT11_MULT = {"": 1, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12}


def bolt11_amount_msats(bolt11):
    """Fallback amount parse straight off a bolt11 invoice string when a zap
    receipt has no explicit `amount` tag."""
    m = _BOLT11_RE.match((bolt11 or "").strip())
    if not m:
        return None
    amount, unit = m.group(1), m.group(2).lower()
    btc = int(amount) * _BOLT11_MULT.get(unit, 1)
    return round(btc * 1e11)  # 1 BTC = 1e8 sats = 1e11 msats


def resolve_zap_amount(receipt_event):
    tags = {t[0]: t[1] for t in receipt_event.get("tags", []) if len(t) >= 2}
    try:
        v = int(tags.get("amount", 0) or 0)
        if v > 0:
            return v
    except Exception:
        pass
    return bolt11_amount_msats(tags.get("bolt11"))


# ── boost classification ─────────────────────────────────────────────────────
def classify_boost(event, receipt_cache):
    tags = event.get("tags", [])
    i_tags = [t for t in tags if len(t) >= 2 and t[0] == "i"]
    podcast_guid = item_guid = None
    item_url = show_url = None
    for t in i_tags:
        v = t[1]
        url = t[2] if len(t) >= 3 and t[2] else None
        if v.startswith("podcast:item:guid:"):
            item_guid = v[len("podcast:item:guid:"):]
            item_url = url
        elif v.startswith("podcast:guid:"):
            podcast_guid = v[len("podcast:guid:"):]
            show_url = url

    if not item_guid:            # episode-level only, no show-level mentions
        return None
    if podcast_guid == LB_FEED_GUID:   # exclude LB's own show
        return None

    t_vals = {t[1] for t in tags if len(t) >= 2 and t[0] == "t"}
    amount_msats = None
    amount_source = None
    is_boost = bool(t_vals & {"boostagram", "value4value"})
    if is_boost:
        amount_source = "t_tag"

    amt_tag = next((t[1] for t in tags if len(t) >= 2 and t[0] == "amount"), None)
    if amt_tag:
        try:
            v = int(amt_tag)
            if v > 0:
                amount_msats, amount_source, is_boost = v, "amount_tag", True
        except Exception:
            pass

    if amount_msats is None:
        candidate_ids = [t[1] for t in tags
                          if len(t) >= 2 and t[0] in ("q", "e") and len(t[1]) == 64]
        for m in _QUOTE_RE.finditer(event.get("content", "") or ""):
            eid = decode_note_or_nevent(m.group(1))
            if eid:
                candidate_ids.append(eid)
        for cid in dict.fromkeys(candidate_ids):
            if cid not in receipt_cache:
                receipt_cache[cid] = fetch_event_by_id(cid, BOOST_SCAN_RELAYS)
            receipt = receipt_cache[cid]
            if receipt and receipt.get("kind") == 9735:
                is_boost = True
                v = resolve_zap_amount(receipt)
                if v:
                    amount_msats, amount_source = v, "zap_receipt"
                break

    if not is_boost:
        return None

    client = next((t[1] for t in tags if len(t) >= 2 and t[0] == "client"), None)
    r_urls = [t[1] for t in tags if len(t) >= 2 and t[0] == "r"]

    return {
        "event_id":        event["id"],
        "booster_pubkey":  event["pubkey"],
        "booster_npub":    hex_to_npub(event["pubkey"]),
        "created_at":      event["created_at"],
        "sats":            round(amount_msats / 1000) if amount_msats else None,
        "amount_source":   amount_source or "none",
        "message":         strip_fountain_trailer(event.get("content", "") or ""),
        "client":          client,
        "podcast_guid":    podcast_guid,
        "item_guid":       item_guid,
        "item_url":        item_url,
        "show_url":        show_url,
        "r_urls":          r_urls,
    }


# ── Podcast Index metadata resolution ────────────────────────────────────────
def pi_headers(key, secret):
    import hashlib
    epoch = str(int(time.time()))
    auth = hashlib.sha1((key + secret + epoch).encode()).hexdigest()
    return {
        "X-Auth-Date": epoch,
        "X-Auth-Key":  key,
        "Authorization": auth,
        "User-Agent":  "LocalBitcoiners-CommunityScan/1.0",
    }


def pi_get(path, params, key, secret):
    r = requests.get(f"{PODCAST_INDEX_BASE}/{path}", params=params,
                      headers=pi_headers(key, secret), timeout=15)
    r.raise_for_status()
    return r.json()


def resolve_show(podcast_guid, key, secret):
    try:
        data = pi_get("podcasts/byguid", {"guid": podcast_guid}, key, secret)
        feed = data.get("feed") or {}
        if not feed:
            return None
        return {
            "podcast_guid": podcast_guid,
            "title":        feed.get("title"),
            "image":        feed.get("image") or feed.get("artwork"),
            "feed_url":     feed.get("url"),
            "itunes_id":    feed.get("itunesId"),
            "feed_id":      feed.get("id"),
            "medium":       feed.get("medium") or "podcast",
        }
    except Exception as e:
        print(f"  [warn] Podcast Index show lookup failed for {podcast_guid}: {e}")
        return None


# Descriptions are frequently HTML; store a plain-text, length-capped version.
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def clean_description(raw, limit=400):
    if not raw:
        return None
    text = _HTML_TAG_RE.sub(" ", raw)     # tags → space so words don't fuse
    text = html.unescape(text)            # &amp; etc. → literal chars
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text or None


def resolve_episode(item_guid, feed_id, key, secret):
    try:
        params = {"guid": item_guid}
        if feed_id:
            params["feedid"] = feed_id
        data = pi_get("episodes/byguid", params, key, secret)
        ep = data.get("episode") or {}
        if not ep or not ep.get("id"):
            return None
        return {
            "item_guid":       item_guid,
            "title":           ep.get("title"),
            "image":           ep.get("image") or ep.get("feedImage"),
            "published":       ep.get("datePublished"),
            "duration":        ep.get("duration"),
            "episode_number":  ep.get("episode"),
            "podcast_guid":    ep.get("podcastGuid") or None,
            "feed_id":         ep.get("feedId"),
            "enclosure_url":   ep.get("enclosureUrl"),
            "enclosure_type":  ep.get("enclosureType"),
            "description":     clean_description(ep.get("description")),
        }
    except Exception as e:
        print(f"  [warn] Podcast Index episode lookup failed for {item_guid}: {e}")
        return None


# ── the pipeline entrypoint ───────────────────────────────────────────────────
def process_boosts(raw_events, existing_output, item_url_map, pi_key, pi_secret,
                   since_cutoff):
    """Classify + merge + enrich. Returns (output_dict, updated_item_url_map).

    `raw_events`   — kind-1 events the orchestrator fetched this pass.
    `existing_output` — the current community_boosts.json (dict) for merge + caches.
    `item_url_map` — persistent item_guid→listen-URL map from state.
    Deterministic and side-effect-free apart from Podcast Index HTTP lookups;
    the orchestrator owns state persistence + the VPS push."""
    receipt_cache = {}
    new_boosts = []
    for ev in raw_events:
        b = classify_boost(ev, receipt_cache)
        if b:
            new_boosts.append(b)
    print(f"  {len(new_boosts)} classified as real episode-level boosts "
          f"(LB's own show excluded)")

    boosts_by_id = {b["event_id"]: b for b in existing_output.get("boosts", [])}
    for b in new_boosts:
        boosts_by_id[b["event_id"]] = b
    all_boosts = sorted(boosts_by_id.values(), key=lambda b: b["created_at"])

    # Schema normalization for records written before item_url/show_url existed.
    for b in all_boosts:
        b.setdefault("item_url", None)
        b.setdefault("show_url", None)

    # Persistent item_guid→url map: once any boost of an episode carries a URL
    # (almost always Fountain-sourced), every URL-less boost of the same episode
    # inherits it, including on later runs. Last-write-wins; warns on conflict.
    item_url_map = dict(item_url_map or {})
    for b in all_boosts:
        ig, url = b.get("item_guid"), b.get("item_url")
        if ig and url:
            prev = item_url_map.get(ig)
            if prev and prev != url:
                print(f"  [warn] item_url_map conflict for {ig}: {prev!r} vs {url!r} — keeping newest")
            item_url_map[ig] = url
    filled = 0
    for b in all_boosts:
        if not b.get("item_url") and b.get("item_guid") in item_url_map:
            b["item_url"] = item_url_map[b["item_guid"]]
            filled += 1
    if filled:
        print(f"  Backfilled item_url on {filled} boost(s) from the persistent guid→url map")

    show_cache = dict(existing_output.get("shows", {}))
    guids_needed = {b["podcast_guid"] for b in all_boosts if b.get("podcast_guid")}
    for pg in guids_needed:
        if pg not in show_cache and pi_key and pi_secret:
            show_cache[pg] = resolve_show(pg, pi_key, pi_secret)

    excluded_shows = {pg for pg, info in show_cache.items()
                      if info and info.get("medium") not in (None, "podcast")}
    for pg in excluded_shows:
        print(f"  [exclude] {pg} medium={show_cache[pg].get('medium')!r} — dropping (not a podcast)")
    all_boosts = [b for b in all_boosts if b.get("podcast_guid") not in excluded_shows]

    # (Re)resolve each boosted episode's metadata; cache misses stay None so we
    # don't re-query, and a transient miss never clobbers good existing data.
    episode_cache = dict(existing_output.get("episodes", {}))
    if pi_key and pi_secret:
        for b in all_boosts:
            ig, pg = b.get("item_guid"), b.get("podcast_guid")
            if not ig:
                continue
            cached = episode_cache.get(ig)
            needs = ig not in episode_cache or (
                isinstance(cached, dict) and "enclosure_url" not in cached)
            if not needs:
                continue
            feed_id = (show_cache.get(pg) or {}).get("feed_id") if pg else None
            resolved = resolve_episode(ig, feed_id, pi_key, pi_secret)
            if resolved is not None:
                episode_cache[ig] = resolved
            elif ig not in episode_cache:
                episode_cache[ig] = None

    output = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "since_cutoff":  since_cutoff,
        "boosts":        all_boosts,
        "episodes":      episode_cache,
        "shows":         {k: v for k, v in show_cache.items() if k not in excluded_shows},
    }
    print(f"  boosts: {len(all_boosts)} total, {len(episode_cache)} episodes, "
          f"{len(output['shows'])} shows")
    return output, item_url_map
