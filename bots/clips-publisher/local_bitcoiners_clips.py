#!/usr/bin/env python3

import sys
import csv
import random
import io
import requests
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "shared"))
from nostr_utils import load_config, publish_to_nostr, write_dry_run_event

# --- Config ---
CREDENTIALS_FILE = Path.home() / ".config/nostr-bots/credentials.env"
CLIPS_SHEET_URL  = "https://docs.google.com/spreadsheets/d/1sMg_hVbAcTZpuGUfgCUW_JTkWd8FuEXBC6ErG8YIlwY/export?format=csv"

DRY_RUN = False


def fetch_clips():
    resp = requests.get(CLIPS_SHEET_URL, timeout=30, allow_redirects=True)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    clips  = []
    for row in reader:
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

    print("Fetching clips from Google Sheets...")
    clips = fetch_clips()
    if not clips:
        print("[error] No clips found in sheet.")
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
