#!/usr/bin/env python3

import sys
import csv
import random
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import load_config, publish_to_nostr, write_dry_run_event

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
CLIPS_FILE       = Path(__file__).resolve().parent.parent.parent / "data/clips.csv"

DRY_RUN = False


def fetch_clips():
    """Load the clip catalog from <repo>/data/clips.csv. Each row is a
    pre-existing Nostr clip note (Event ID = nostr:nevent1...) that the bot
    surfaces by quoting it in a daily wrapper note."""
    clips = []
    with CLIPS_FILE.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            event_id   = row.get("Event ID", "").strip()
            clip_title = row.get("Clip Title", "").strip()
            episode    = row.get("Episode", "").strip()
            if event_id and clip_title:
                clips.append({
                    "episode":    episode,
                    "clip_title": clip_title,
                    "event_id":   event_id,
                })
    return clips


def format_note(clip):
    return (
        f"📎 Clip from Ep. {clip['episode']} of Local Bitcoiners\n\n"
        f"\"{clip['clip_title']}\"\n\n"
        f"#LocalBitcoiners\n\n"
        f"{clip['event_id']}"
    )


def main():
    config = load_config(CREDENTIALS_FILE)
    nsec   = config["NSEC_LOCAL_BITCOINERS"]

    print(f"Loading clips from {CLIPS_FILE}...")
    clips = fetch_clips()
    if not clips:
        print(f"[error] No clips found in {CLIPS_FILE}.")
        return

    print(f"Found {len(clips)} clips.")
    clip = random.choice(clips)
    print(f"Selected: Ep. {clip['episode']} — {clip['clip_title']}")

    note = format_note(clip)
    print("\n--- Note Preview ---")
    print(note)
    print("--------------------\n")

    if DRY_RUN:
        if nsec:
            path, _ = write_dry_run_event(note, nsec, prefix="clip")
            print(f"[DRY RUN] Event written → {path}")
        else:
            print("[DRY RUN] No nsec — cannot build event JSON")
    else:
        print("Publishing to Nostr...")
        publish_to_nostr(note, nsec)
        print("Done.")


if __name__ == "__main__":
    main()
