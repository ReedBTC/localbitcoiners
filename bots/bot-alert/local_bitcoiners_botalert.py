#!/usr/bin/env python3
"""Open a GitHub issue when an LB bot unit fails. Wired up as systemd
`OnFailure=lb-bot-alert@%n.service`, so systemd runs it with the failed unit
name as argv[1].

Why this exists: boost-publisher crash-looped on a malformed npub every 10
minutes for 3.5 days in 2026-07 — 515 consecutive failures, zero signal. The
bug was fixed within hours of being noticed; the outage was 3.5 days because
nothing was watching. Three website boosts aged out of Alby's fetch window
while it looped and were lost permanently. Detection was a *listener* filing a
bug report. This closes that gap: one issue, within ~20 minutes of the first
failure.

Deliberately does nothing clever. It doesn't restart the unit or try to repair
state — it just makes a silent failure loud, because the fix for that incident
was a human reading a traceback.

Idempotent: one open issue per unit. A crash loop fires this every 10 minutes
and must not open 515 issues, so we check for an already-open issue carrying
this unit's marker and exit quietly if one exists. Close the issue and a later
failure opens a fresh one.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

# Set LB_BOT_ALERT_DRY_RUN=1 to print the issue instead of filing it. Lets the
# systemd path be exercised end-to-end — template, User=, HOME, gh auth — without
# posting to a public repo.
DRY_RUN    = os.environ.get("LB_BOT_ALERT_DRY_RUN") == "1"

REPO       = "ReedBTC/localbitcoiners"
LABEL      = "bot-failure"
LOG_LINES  = 40      # journal tail included in the issue body
# Cap the excerpt by characters, trimming the OLDEST lines. 40 journal lines run
# ~4kB, so this nearly always bites — and journalctl puts the newest line last,
# so trimming the tail end would throw away the traceback that the issue exists
# to show, every time. Keep the end, drop the front.
MAX_TAIL   = 2800

# ─── Redaction ───────────────────────────────────────────────────────────────
# The issue body goes to a PUBLIC repo, so the journal tail is scrubbed before
# it's posted. Bot logs aren't supposed to contain secrets, but "supposed to"
# isn't a security control: an exception's repr can drag in a URL with a token
# in the query string, and this box's journal already carries a Telegram bot
# token in plaintext from an unrelated service. Redact secret *shapes*, plus
# LAN/onion hosts (ALBY_HUB_URL is a private address — not a secret, but not
# something to publish either).
#
# Never resolved against credentials.env: this script has no business reading
# it, and shape-matching doesn't need to.
REDACTIONS = [
    (re.compile(r"nsec1[02-9ac-hj-np-z]{20,}"),                        "[REDACTED nsec]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),                      "[REDACTED gh token]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),                    "[REDACTED gh token]"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),                    "[REDACTED slack token]"),
    # No \b before the digits: these appear as `.../bot<id>:AA...` in API URLs,
    # and `t`→`8` is not a word boundary, so \b would miss the real-world shape.
    (re.compile(r"\d{8,12}:AA[A-Za-z0-9_-]{30,}"),                     "[REDACTED telegram token]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+"),                   "Bearer [REDACTED]"),
    (re.compile(r"(?i)\bauthorization\"?:?\s*\"?[A-Za-z0-9._\-]{8,}"), "authorization: [REDACTED]"),
    (re.compile(r"(?i)\b(token|api[_-]?key|secret)=[^&\s\"']+"),       r"\1=[REDACTED]"),
    (re.compile(r"https?://(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?"),         "[REDACTED lan-host]"),
    (re.compile(r"https?://[a-z2-7]{16,56}\.onion\b"),                 "[REDACTED onion-host]"),
]


def redact(text):
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def run(args, timeout=30):
    """Return (rc, stdout, stderr) — never raises on non-zero."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout or "", p.stderr or ""
    except Exception as e:
        return 1, "", str(e)


def journal_tail(unit, lines):
    rc, out, err = run(["journalctl", "-u", unit, "-n", str(lines),
                        "--no-pager", "-o", "short-iso"])
    return out if rc == 0 and out.strip() else f"(could not read journal: {err.strip()})"


def failure_count(unit):
    """Failures in the last 24h — turns 'it broke' into 'it's been broken a while'."""
    rc, out, _ = run(["journalctl", "-u", unit, "--since", "24 hours ago", "--no-pager"])
    if rc != 0:
        return None
    return sum(1 for line in out.splitlines() if "Failed with result" in line)


def existing_issue(marker):
    """Number of the open issue for this unit, or None.

    Filters `gh issue list` locally rather than using `--search`: GitHub's search
    index is eventually consistent, and a unit failing every 10 minutes would
    race it and open duplicates. Listing open issues and matching the marker in
    the body is exact and immediate.
    """
    rc, out, err = run([
        "gh", "issue", "list", "--repo", REPO, "--state", "open",
        "--label", LABEL, "--limit", "100", "--json", "number,body",
    ])
    if rc != 0:
        # Fail closed: if we can't tell whether an issue exists, don't risk a
        # storm of duplicates. The next failure tries again.
        print(f"[bot-alert] could not list issues, not filing: {err.strip()}")
        sys.exit(0)
    try:
        for issue in json.loads(out or "[]"):
            if marker in (issue.get("body") or ""):
                return issue.get("number")
    except json.JSONDecodeError:
        print("[bot-alert] could not parse gh output, not filing")
        sys.exit(0)
    return None


def ensure_label():
    rc, _, err = run(["gh", "label", "create", LABEL, "--repo", REPO,
                      "--color", "B60205", "--description", "An LB bot unit failed"])
    if rc != 0 and "already exists" not in err.lower():
        print(f"[bot-alert] could not ensure label: {err.strip()}")


def main():
    if len(sys.argv) < 2:
        print("usage: local_bitcoiners_botalert.py <failed-unit-name>")
        return 2

    unit   = sys.argv[1]
    marker = f"<!-- lb-bot-alert:{unit} -->"

    open_number = existing_issue(marker)
    if open_number:
        print(f"[bot-alert] {unit} failed; issue #{open_number} already open — not filing again")
        return 0

    now    = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    count  = failure_count(unit)
    tail   = redact(journal_tail(unit, LOG_LINES)).strip()
    streak = f"{count} failure(s) logged in the last 24h" if count is not None else "failure count unavailable"

    if len(tail) > MAX_TAIL:
        # Cut on a line boundary so the excerpt doesn't open mid-token.
        tail = tail[-MAX_TAIL:]
        tail = "… earlier lines trimmed …\n" + tail.split("\n", 1)[-1]

    body = f"""{marker}
**`{unit}` failed.**

- First noticed: `{now}`
- {streak}

This issue was opened automatically by `bots/bot-alert/` via the unit's
`OnFailure=`. It will not open a second issue for `{unit}` while this one is
open — **close it once the bot is healthy**, or the next failure goes unreported.

The bot retries on its next timer tick. Since `boost-publisher` now pages back to
`last_seen`, a transient failure should drain on its own; a *repeating* failure
means it's stuck on something and needs a human.

### Journal tail (most recent lines, secrets redacted)

```
{tail}
```

Full logs on the box:

```
journalctl -u {unit} -n 200 --no-pager
```
"""
    title = f"[bot-failure] {unit} is failing"

    if DRY_RUN:
        print(f"[bot-alert] DRY RUN — would file in {REPO}:\n"
              f"  title: {title}\n  label: {LABEL}\n  body:\n{body}")
        return 0

    ensure_label()
    rc, out, err = run([
        "gh", "issue", "create", "--repo", REPO,
        "--title", title,
        "--body", body, "--label", LABEL,
    ])
    if rc != 0:
        print(f"[bot-alert] gh issue create failed: {(err or out).strip()}")
        return 1

    print(f"[bot-alert] opened {out.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
