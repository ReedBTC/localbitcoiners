# bot-alert

Opens a GitHub issue in `ReedBTC/localbitcoiners` when an LB bot unit fails.

Not a timer. It's wired to other units via systemd `OnFailure=`, so systemd runs
it the moment a bot exits non-zero, passing the failed unit name as `%i`.

## Why

In July 2026 `boost-publisher` crash-looped on a malformed npub every 10 minutes
for 3.5 days — 515 consecutive failures, no signal. Three website boosts aged out
of Alby's fetch window while it looped and were lost for good. The bug was fixed
within hours of being noticed; the 3.5 days were pure detection latency. What
finally surfaced it was a listener filing a bug report about a missing boost.

This makes that failure loud. It doesn't restart anything or repair state — the
fix for that incident was a human reading a traceback, and this gets the traceback
in front of one.

## Behaviour

- **One open issue per unit.** A crash loop fires this every 10 minutes and must
  not open 515 issues, so it checks for an already-open issue carrying a
  `<!-- lb-bot-alert:<unit> -->` marker and exits quietly if it finds one.
  **Close the issue once the bot is healthy** — a closed issue is what re-arms
  the alert. While one is open, further failures of that unit are unreported.
- **Fails closed.** If `gh` can't list issues, it files nothing rather than risk
  duplicates. The next failure retries.
- **Redacts.** The repo is public, so the journal excerpt is scrubbed of
  secret-shaped strings (nsec, gh/slack/telegram tokens, bearer headers,
  `token=`/`api_key=` params) and LAN/onion hosts before posting. It never reads
  `credentials.env` — shape-matching doesn't need to.
- **Keeps the newest log lines.** The excerpt is trimmed from the front, because
  journalctl puts the traceback last and that's the whole point.

## Files

```
local_bitcoiners_botalert.py     the script — takes the failed unit name as argv[1]
systemd/lb-bot-alert@.service    templated unit; %i is the failed unit
```

## Wiring a bot up to it

Add to the bot's `[Unit]` section:

```ini
OnFailure=lb-bot-alert@%n.service
```

`%n` expands to the full unit name, so `boost-publisher.service` triggers
`lb-bot-alert@boost-publisher.service.service`. Then:

```bash
sudo systemctl daemon-reload
```

Currently wired: `boost-publisher.service`.

Note `OnFailure=` only catches **non-zero exits**. A bot that handles its own
error and returns 0 — like boost-publisher's `[error] Could not reach Alby Hub`
path — will not trigger this. Bots should exit non-zero on failures worth waking
someone for.

## Testing

`LB_BOT_ALERT_DRY_RUN=1` prints the issue instead of filing it:

```bash
LB_BOT_ALERT_DRY_RUN=1 python3 local_bitcoiners_botalert.py boost-publisher.service
```

The unit needs `User=reed` and `Environment=HOME=/home/reed` — `gh` reads its
auth from `~/.config/gh/hosts.yml`, and systemd doesn't set `HOME` for `User=`
alone. Without it `gh` runs unauthenticated and the alert silently fails.
