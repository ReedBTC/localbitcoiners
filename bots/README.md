# Local Bitcoiners — Nostr Bots

Automated Nostr publishing bots that monitor Lightning payments to the Local
Bitcoiners podcast (and localbitcoiners.com) via [Alby Hub], then publish
formatted kind-1 notes to Nostr crediting the senders.

[Alby Hub]: https://albyhub.com

## What's here

| Bot | Purpose | Schedule |
|---|---|---|
| `boost-publisher/` | Publishes a Nostr note for every incoming podcast boost (Fountain BOLT11, keysend, Castamatic, etc.) | every 10 min |
| `localbitcoiners-publisher/` | Publishes a note for every donation to localbitcoiners.com | every 10 min |
| `clips-publisher/` | Publishes a daily episode clip pulled from a shared sheet | weekdays, 1 PM ET |
| `boost-leaders/` | Leaderboard: who has boosted the most distinct episodes | manual |
| `top-boosts/` | Leaderboard: biggest single boosts of all time | manual |
| `weekly-recap/` | Leaderboard: most-sat episodes (a.k.a. "episodesats") | manual |

The three leaderboards are typically fired together via `run-leaderboards.sh`
about an hour before the weekly Local Bitcoiners recording.

## Architecture

```
bots/
├── shared/
│   ├── nostr_utils.py         # bech32, NIP-01 signing, relay publish, follow lists
│   ├── boost_formatter.py     # the classifier — turns an Alby tx into a typed boost
│   └── seed_episode_ids.py    # one-time bootstrap for the episode-id cache
├── boost-publisher/           # one bot per directory
│   └── local_bitcoiners_boosts.py
├── boost-leaders/
├── top-boosts/
├── ...
└── run-leaderboards.sh        # fires all three leaderboards in sequence
```

Every bot:

1. Pages through Alby Hub's `/api/transactions` since its last-processed
   timestamp.
2. Hands each tx to `classify_lb_tx()`, which figures out what kind of
   boost/donation it is and pulls in the metadata (Fountain message, sender
   npub from V4V 2.0 kind-30078 events, Podcast Index episode title, etc).
3. Formats a kind-1 note and publishes it via `publish_to_nostr()`.
4. Saves its progress to a per-bot state file (`state.json` or
   `last_seen.txt` next to the script — gitignored).

State files are intentionally per-bot rather than centralized so each bot's
incremental progress is independent.

## Setup

The bots assume:

- Python 3.10+
- `requests`, `websocket-client`, `pynostr`, `bech32` (`pip install ...`)
- An Alby Hub instance reachable on the LAN with an app token
- A `~/.config/nostr-bots/credentials.env` file (outside this repo) with at
  minimum:

  ```
  ALBY_HUB_URL=https://your-alby-hub.local
  ALBY_TOKEN=...
  NSEC_LOCAL_BITCOINERS=nsec1...
  LOCAL_BITCOINERS_INDEX_KEY=...      # Podcast Index, optional
  LOCAL_BITCOINERS_INDEX_SECRET=...
  TOR_PROXY=socks5h://127.0.0.1:9050  # only if your LND is on an onion
  ```

- An optional `~/.config/nostr-bots/sender_overrides.json` for manually
  attributing keysend boosts to npubs when the sender confirms one
  out-of-band:

  ```json
  { "Some Person": "npub1..." }
  ```

Bot scripts are designed to find their `shared/` dependencies relative to
their own location, so anywhere you clone the repo will work — no path
edits required.

## Running

Each bot is a standalone script. Manually:

```bash
python3 bots/top-boosts/local_bitcoiners_topboosts.py
```

In production, every bot has a paired `systemd` service + timer that
defines its working directory and schedule. The unit files aren't part of
this repo (they live in `/etc/systemd/system/` on the deployment machine).

Every bot supports a `DRY_RUN = True` flag near the top of its file. In
dry-run mode, the bot does everything except sign and publish — it writes
the unsigned event JSON to `bots/dry-run/` (gitignored) so you can preview
what would have been published. **Always start a new bot or a new code
path with `DRY_RUN = True` and only flip to `False` once you've reviewed
the dry-run output**, since Nostr publishes can't be undone.

## Forking for your own podcast

These bots are heavily tailored to the Local Bitcoiners RSS feed and
website, but the structure is reusable. The main things you'd want to
change:

- The classifier logic in `shared/boost_formatter.py` (Fountain regexes,
  `LB_DONATION_APP_IDS`, the per-source split divisors).
- The note-formatting templates in each bot.
- The `COLLECTOR_EVENT_ID` constants in the leaderboard bots (they reply
  under long-running collector notes you've published).
- The hardcoded host npubs and sender overrides.

PRs welcome — particularly anything that makes the classifier more
podcast-agnostic or improves the V4V 2.0 donation handling.
