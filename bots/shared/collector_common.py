#!/usr/bin/env python3
"""Shared primitives for read-only community-content collectors.

These are the relay-scan / verify / dedup / VPS-push building blocks used by
the community feed collectors (calendar events, marketplace listings,
long-form articles) and — going forward — anything else that caches
follow-pack-scoped Nostr content into a JSON file the website reads.

Design notes that matter to callers:

* Target kinds here are all ADDRESSABLE (30000-39999) — replaceable by
  `kind:pubkey:d-tag` coordinate, not immutable like kind-1 boosts. So dedup
  is by COORDINATE (newest `created_at` wins), and NIP-09 (kind-5) deletions
  are honoured against the whole accumulated store — see `newest_per_coord`,
  `collect_deletions`, `is_deleted`.

* Every event we cache is signature-verified first (`verify_raw_event`) —
  this content is served publicly from our own host, so we never want to
  re-serve a forged event attributed to a community member.

Nothing here signs or publishes to Nostr. The only outward action is
`push_file_to_vps`, which callers gate behind their own flag.
"""

import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import websocket
from pynostr.event import Event

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from nostr_utils import NOSTR_RELAYS, get_outbox_relays  # noqa: E402


DEFAULT_RELAY_TIMEOUT = 15
AUTHOR_BATCH_SIZE = 50   # conservative per-filter author count (relay caps vary)


# ── relay I/O ────────────────────────────────────────────────────────────────
def query_relay(relay, filt, timeout=DEFAULT_RELAY_TIMEOUT,
                max_wall_seconds=60, max_events=50000):
    """REQ one or more filters against one relay in a single subscription,
    returning whatever EVENTs arrive before EOSE, the socket times out, or a hard
    wall-clock / event-count cap is hit (partial results are kept, not discarded).

    `filt` may be a single filter dict or a LIST of filter dicts. A list is sent
    as one REQ carrying every filter, so a relay is queried for several
    kind/tag shapes over ONE connection and ONE EOSE wait — a dead relay then
    costs a single `max_wall_seconds`, not one per filter. The relay returns the
    union (each filter applied independently, e.g. a `#k` narrowing on only one).

    The per-recv timeout alone can't bound a relay that dribbles messages slower
    than `timeout` apart but never sends EOSE, so `max_wall_seconds` bounds total
    time and `max_events` guards against an unbounded backlog stream."""
    filters = filt if isinstance(filt, list) else [filt]
    got = []
    deadline = time.monotonic() + max_wall_seconds
    try:
        ws = websocket.create_connection(relay, timeout=timeout)
        sub = "cf"
        ws.send(json.dumps(["REQ", sub, *filters]))
        while time.monotonic() < deadline and len(got) < max_events:
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
                got.append(msg[2])
            elif msg[0] == "EOSE":
                break
        if len(got) >= max_events:
            print(f"    [warn] {relay}: hit max_events cap ({max_events}) — filter may be too broad")
        elif time.monotonic() >= deadline:
            print(f"    [warn] {relay}: hit {max_wall_seconds}s wall-clock cap without EOSE — partial results kept")
        try:
            ws.send(json.dumps(["CLOSE", sub]))
        except Exception:
            pass
        ws.close()
    except Exception as e:
        print(f"    [warn] {relay}: {e}")
    return got


def fetch_events_by_authors(relays, kinds, author_hexes, since=None,
                            batch_size=AUTHOR_BATCH_SIZE, max_wall_seconds=60,
                            max_workers=24, label="", extra_filter=None):
    """Author-chunked scan of `kinds` across `relays`, deduped by event id.

    Every (relay, author-batch) pair is queried CONCURRENTLY (one task each,
    capped at `max_workers`) — the scan is I/O-bound and dominated by slow/dead
    relays waiting out their timeout, so fanning out at the query level turns a
    long sequential crawl into a few concurrent waves. Fanning out per (relay,
    batch) rather than per relay matters when authors chunk into several
    batches: a relay that never EOSEs would otherwise burn one full
    `max_wall_seconds` per batch back-to-back inside its thread (three batches ⇒
    ~3× the cap on one connection); as independent tasks those waits overlap
    instead. `since=None` means full history (backfill); pass a timestamp for
    incremental. `max_wall_seconds` bounds each query — keep it tight on
    incremental runs, where a relay that hasn't EOSE'd quickly on a small
    since-window is effectively dead. Authors are chunked because many relays cap
    the `authors` array.

    `extra_filter` is merged into every REQ filter (e.g. a `#k` tag narrowing) —
    relay-side tag filters are exact-match, so callers that can pre-narrow
    (community-boosts' `#k: [podcast:guid, podcast:item:guid]`) pass it here."""
    batches = [author_hexes[i:i + batch_size]
               for i in range(0, len(author_hexes), batch_size)]
    base_filt = {"kinds": kinds}
    if since is not None:
        base_filt["since"] = since
    if extra_filter:
        base_filt.update(extra_filter)

    tasks = [(relay, batch) for relay in relays for batch in batches]

    def scan_one(task):
        relay, batch = task
        local = {}
        filt = dict(base_filt, authors=batch)
        for ev in query_relay(relay, filt, max_wall_seconds=max_wall_seconds):
            eid = ev.get("id")
            if eid:
                local[eid] = ev
        return local

    seen = {}
    lock = threading.Lock()
    done = 0
    total = len(tasks)
    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, total or 1))) as ex:
        futures = {ex.submit(scan_one, t): t for t in tasks}
        for fut in as_completed(futures):
            try:
                local = fut.result()
            except Exception:
                local = {}
            with lock:
                seen.update(local)
                done += 1
                if done % 40 == 0 or done == total:
                    print(f"    {label}{done}/{total} queries done, {len(seen)} unique events")
    return list(seen.values())


def fetch_events_multi(relays, filter_templates, author_hexes,
                       batch_size=AUTHOR_BATCH_SIZE, max_wall_seconds=60,
                       max_workers=24, label=""):
    """Like fetch_events_by_authors, but each (relay, author-batch) is queried
    with SEVERAL filter templates in one REQ instead of one — so a caller that
    wants, say, `#k`-narrowed kind-1 boosts + addressable feed kinds + kind-5
    deletions pays a single connection + EOSE wait per relay-batch rather than
    three. `filter_templates` is a list of partial filter dicts (kinds, optional
    `#k`, optional `since`); `authors` is merged into each. Returns the deduped
    union across all templates (mixed kinds — the caller buckets by kind)."""
    batches = [author_hexes[i:i + batch_size]
               for i in range(0, len(author_hexes), batch_size)]
    tasks = [(relay, batch) for relay in relays for batch in batches]

    def scan_one(task):
        relay, batch = task
        filters = [dict(tmpl, authors=batch) for tmpl in filter_templates]
        local = {}
        for ev in query_relay(relay, filters, max_wall_seconds=max_wall_seconds):
            eid = ev.get("id")
            if eid:
                local[eid] = ev
        return local

    seen = {}
    lock = threading.Lock()
    done = 0
    total = len(tasks)
    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, total or 1))) as ex:
        futures = {ex.submit(scan_one, t): t for t in tasks}
        for fut in as_completed(futures):
            try:
                local = fut.result()
            except Exception:
                local = {}
            with lock:
                seen.update(local)
                done += 1
                if done % 40 == 0 or done == total:
                    print(f"    {label}{done}/{total} queries done, {len(seen)} unique events")
    return list(seen.values())


# ── signature verification ────────────────────────────────────────────────────
def verify_raw_event(raw):
    """True iff `raw` (a relay EVENT dict) has a valid id + schnorr signature.
    Backed by pynostr.Event.verify() (coincurve). Malformed events → False."""
    try:
        ev = Event(
            content=raw.get("content", "") or "",
            pubkey=raw["pubkey"],
            created_at=raw["created_at"],
            kind=raw["kind"],
            tags=raw.get("tags", []) or [],
        )
        ev.id = raw["id"]
        ev.sig = raw["sig"]
        return bool(ev.verify())
    except Exception:
        return False


# ── addressable-event helpers (coordinate dedup + NIP-09 deletions) ───────────
def dtag_of(ev):
    for t in ev.get("tags", []):
        if len(t) >= 2 and t[0] == "d":
            return t[1]
    return ""


def coord_of(ev):
    """NIP-01 addressable coordinate `kind:pubkey:d-tag`."""
    return f"{ev.get('kind')}:{ev.get('pubkey')}:{dtag_of(ev)}"


def newest_per_coord(events):
    """Collapse a list of addressable events to the newest per coordinate.
    Returns {coord: event}."""
    out = {}
    for ev in events:
        c = coord_of(ev)
        prev = out.get(c)
        if prev is None or (ev.get("created_at", 0) > prev.get("created_at", 0)):
            out[c] = ev
    return out


def collect_deletions(kind5_events, deleted_ids=None, deleted_coords=None):
    """Fold verified kind-5 events into a running deletion state.

    `deleted_ids`: set of deleted event ids (from `e` tags).
    `deleted_coords`: {coord: newest-deletion created_at} from `a` tags — only
    honoured for a coordinate the deleter owns (NIP-09). Returns the (mutated)
    pair so it can be threaded across runs."""
    deleted_ids = set(deleted_ids or set())
    deleted_coords = dict(deleted_coords or {})
    for ev in kind5_events:
        at = ev.get("created_at", 0)
        deleter = (ev.get("pubkey") or "").lower()
        for t in ev.get("tags", []):
            if len(t) < 2 or not isinstance(t[1], str):
                continue
            if t[0] == "e" and len(t[1]) == 64:
                deleted_ids.add(t[1].lower())
            elif t[0] == "a":
                parts = t[1].split(":")
                if len(parts) >= 2 and parts[1].lower() == deleter:
                    prev = deleted_coords.get(t[1])
                    if prev is None or at > prev:
                        deleted_coords[t[1]] = at
    return deleted_ids, deleted_coords


def is_deleted(ev, deleted_ids, deleted_coords):
    """A stored event is dead if its exact id was deleted, or a coordinate
    deletion is dated at/after it (an older version's removal doesn't kill a
    newer re-publish)."""
    if (ev.get("id") or "").lower() in deleted_ids:
        return True
    del_at = deleted_coords.get(coord_of(ev))
    return del_at is not None and del_at >= ev.get("created_at", 0)


# ── community membership + scan-relay resolution ──────────────────────────────
def load_community_npubs(followpacks_state_file):
    """Union of every member across every follow pack in the follow-packs bot's
    state file — the single source of truth for 'the community'. Same set
    community-boosts uses and feeds.js resolves live from kind-39089."""
    packs = json.loads(Path(followpacks_state_file).read_text())
    return sorted({h for pack in packs.values() for h in pack.get("members", [])})


def _is_ws_url(u):
    return isinstance(u, str) and (u.startswith("wss://") or u.startswith("ws://"))


def resolve_scan_relays(member_hexes, base_relays=None, resolve_outbox=True):
    """The relay set to scan for community content: the base relays plus, when
    `resolve_outbox` is set, the NIP-65 write (outbox) relays of every member —
    so we find content a member only published to their own relays. Slower, but
    complete. De-duplicated; only ws(s) URLs kept."""
    base = list(base_relays if base_relays is not None else NOSTR_RELAYS)
    relays = {u.rstrip("/") for u in base if _is_ws_url(u)}
    if resolve_outbox:
        for i, hexpk in enumerate(member_hexes, 1):
            try:
                for u in get_outbox_relays(hexpk) or []:
                    if _is_ws_url(u):
                        relays.add(u.rstrip("/"))
            except Exception:
                pass
            if i % 25 == 0:
                print(f"    outbox resolved for {i}/{len(member_hexes)} members "
                      f"({len(relays)} relays so far)")
    return sorted(relays)


# ── VPS delivery ──────────────────────────────────────────────────────────────
def push_file_to_vps(config, local_path, remote_filename, key_file):
    """rsync one file to the VPS deploy dir (Caddy serves it, a CF Pages
    Function proxies it) — same restricted-rrsync path community-boosts uses,
    generalized to any filename. Best-effort: a failure is logged, not raised,
    since the file is still written locally regardless."""
    host = config.get("RELAY_VPS_HOST")
    port = config.get("RELAY_VPS_PORT")
    user = config.get("RELAY_VPS_USER")
    deploy_path = config.get("RELAY_VPS_DEPLOY_PATH")
    if not all([host, port, user, deploy_path]):
        print("  [warn] RELAY_VPS_* fields missing from credentials.env — skipping VPS push")
        return False
    if not Path(key_file).exists():
        print(f"  [warn] {key_file} not found — skipping VPS push")
        return False
    # rrsync's forced command fixes the root dir; send a path RELATIVE to it.
    dest = f"{user}@{host}:{remote_filename}"
    ssh_cmd = f"ssh -i {key_file} -p {port} -o StrictHostKeyChecking=accept-new"
    try:
        result = subprocess.run(
            ["rsync", "-a", "-e", ssh_cmd, str(local_path), dest],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            print(f"  [warn] VPS push failed (exit {result.returncode}): {result.stderr.strip()[-300:]}")
            return False
        print(f"  VPS push OK → {remote_filename}")
        return True
    except Exception as e:
        print(f"  [warn] VPS push failed: {e}")
        return False
