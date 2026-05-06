#!/usr/bin/env python3
"""One-time bootstrap for shared/lb_episode_ids.json.

Walks the weekly-recap state.json (which keys episodes by their Fountain
internal id with the LB-normalized title), extracts an episode_number →
fountain_id mapping, and writes it to the shared map file. Skips synthetic
buckets (__show__, keysend_*, lb_website_*) and anything whose id doesn't
match the shape of a Fountain page id.

When to run:
  - lb_episode_ids.json is missing or corrupted
  - You want to rebuild from scratch after some state weirdness
  - First-time setup on a fresh machine where the bots have never run

Going forward you don't need this — every LB bot's classify_lb_tx call
populates the map automatically when it processes a Fountain BOLT11 boost,
keysend boost with a Fountain boostLink, or episode-level Fountain stream.
The end-of-run persist_cache(cache) call writes back any new mappings.

Usage:
  python3 bots/shared/seed_episode_ids.py
"""

import json
import re
import sys
from pathlib import Path

_BOTS_ROOT  = Path(__file__).resolve().parent.parent
RECAP_STATE = _BOTS_ROOT / "weekly-recap/state.json"
OUT_FILE    = _BOTS_ROOT / "shared/lb_episode_ids.json"

# Fountain page ids look like ~12-character base62-ish strings (e.g.
# "pmNA13rcCFrIvdNlUjfA"). Synthetic ids the recap creates for off-Fountain
# sources (keysend without a Fountain boostLink, website boosts whose RSS
# guid didn't resolve) use prefixes or shapes we can filter out.
FOUNTAIN_ID_RE = re.compile(r"[A-Za-z0-9_-]{12,30}")


def parse_episode_number(title):
    """Pull a zero-padded episode number from an LB title. Returns None when
    the title doesn't match the LB convention."""
    if not title:
        return None
    if title.startswith("001."):
        return "001"
    m = re.search(r"Ep\.\s*(\d+)", title)
    if m:
        return m.group(1).zfill(3)
    return None


def main():
    if not RECAP_STATE.exists():
        sys.exit(f"[error] {RECAP_STATE} not found — can't seed without recap state")

    recap = json.loads(RECAP_STATE.read_text())
    episodes = recap.get("episodes", {})
    if not episodes:
        sys.exit("[error] recap state has no episodes — nothing to seed from")

    out = {}
    skipped = []
    for ep_id, ep in episodes.items():
        if ep_id == "__show__":
            skipped.append((ep_id, "show bucket"))
            continue
        if ep_id.startswith("keysend_") or ep_id.startswith("lb_website_"):
            skipped.append((ep_id, "synthetic id"))
            continue
        if not FOUNTAIN_ID_RE.fullmatch(ep_id):
            skipped.append((ep_id, "doesn't look like a Fountain id"))
            continue

        ep_num = parse_episode_number(ep.get("title", ""))
        if not ep_num:
            skipped.append((ep_id, f"couldn't parse Ep. number from title {ep.get('title', '')!r}"))
            continue

        existing = out.get(ep_num)
        if existing and existing != ep_id:
            print(f"  [warn] Ep {ep_num} already mapped to {existing}; ignoring duplicate id {ep_id}")
            continue
        out[ep_num] = ep_id

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")

    print(f"Wrote {len(out)} episode_id mappings to {OUT_FILE}:")
    for k, v in sorted(out.items()):
        print(f"  {k} → {v}")
    if skipped:
        print(f"\nSkipped {len(skipped)} bucket(s):")
        for ep_id, reason in skipped:
            print(f"  {ep_id}: {reason}")


if __name__ == "__main__":
    main()
