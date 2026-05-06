# Local Bitcoiners — Claude Code Notes

This repo holds two related things:

- **Website** (root): the public localbitcoiners.com site — `index.html`,
  `boosts.html`, `assets/`, `functions/`, `transcripts/`, etc.
- **Bots** (`bots/`): automated Nostr publishing bots that monitor incoming
  Lightning payments via Alby Hub and publish kind-1 notes to Nostr.

## Working in this repo

When asked to make changes, look at the file paths in the request to figure
out which side you're on, and stay on that side unless explicitly told
otherwise. Website changes don't need to know about the bots, and bot
changes don't need to know about the website.

## ⚠️  Don't modify `bots/` without asking

The bots run on a single dedicated machine, sign with real Nostr keys, and
publish irreversible events to public relays. Reed is the only person who
runs and maintains them. **Always ask before making changes inside `bots/`,
even small ones** — including refactors, formatting passes, or "obvious"
fixes. The bots have subtle invariants that aren't always visible from the
code (sat-split divisors, episode-id key shapes, state-file conventions),
and a wrong publish can't be undone.

If you're working on the website and a change incidentally touches `bots/`,
stop and ask first.

## Bot infrastructure documentation

The detailed bot infrastructure notes live in `bots/CLAUDE.md` (gitignored,
machine-local only) and `bots/nostr bots/bots-config.md` (also gitignored).
The public `bots/README.md` covers what the bots do at a high level.
