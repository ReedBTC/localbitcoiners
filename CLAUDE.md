# Local Bitcoiners — Claude Code Notes

This repo holds two related things:

- **Website** (root): the public localbitcoiners.com site — `index.html`,
  `boosts.html`, `assets/`, `functions/`, `transcripts/`, etc.
- **Bots** (`bots/`): automated Nostr publishing bots that monitor incoming
  Lightning payments via Alby Hub and publish kind-1 notes to Nostr.

## Working in this repo

Reed manages both the website and the bots from this directory. When asked
to make changes, look at the file paths in the request to figure out which
side you're on. Website changes don't need to know about the bots, and bot
changes don't need to know about the website — but you're free to work on
either side.

## ⚠️  Editing `bots/` is fine — but STOP before any publish or payment

You can freely edit bot code, configs, and refactors. The hard line is at
*execution that can't be undone*: the bots sign with real Nostr keys and
publish irreversible events to public relays, and they move real sats.

**Confirm with Reed before running anything that signs/publishes Nostr
events or sends payments** — that includes live bot runs, publish/send
commands, and the weekly leaderboard publish path. Code edits, dry runs,
and read-only inspection don't need a check-in.

Watch the subtle invariants that aren't always visible from the code
(sat-split divisors, episode-id key shapes, state-file conventions) — a
wrong publish can't be undone, so when a code change feeds the publish
path, double-check those before you let it run.

## The login/boost widget (post-OnlyBoosts-port, lb-v70)

The boost flow was ported back from the OnlyBoosts fork in 2026-08 (merge
`f7ea1e3`). Four invariants fail silently if missed:

- **Every widget change ends the same way**: `cd login-widget && npm run build`
  (three vite targets, including the edge signer
  `functions/_shared/nostr-sign.js`), bump `VERSION` in `sw.js`, commit the
  rebuilt bundle, then run the four test scripts from the repo root:
  `node scripts/test-sign-boost.mjs`, `test-boost-modal-render.mjs`,
  `test-keysend-upgrade.mjs`, `test-boostbox.mjs`. They prove shapes, not
  rendering — after a structural change, open a modal in a browser.
- **`assets/css/theme.css` and the widget's `var()` fallbacks are mirrors.**
  Every `var()` in `login-widget/src` carries a literal fallback equal to its
  token (a stale cached theme.css against a fresh bundle otherwise renders the
  modal transparent). `test-boost-modal-render.mjs` fails on drift; edit the
  token and re-mirror the fallbacks in one commit.
- **`functions/api/sign-boost.js` signs with the SHOW KEY** (`LB_SIGN_NSEC`
  secret + `SIGN_RATELIMIT` KV, set on Preview and Production). Its validators
  restate constants from the widget builders (banner URLs, feed guid, the
  amount cap) — change both sides in one commit; `test-sign-boost.mjs` feeds
  the validators from the shipped builders and fails on drift. If a builder
  emits a new tag, add it to that family's allowlist in the same change.
- **The site-signed show note must stay byte-identical to the bots' standalone
  note** (`bots/shared/boost_formatter.py#format_note_from_info` +
  `build_boost_claim_tags`): the bots skip their own standalone when the
  receipt's `share_note` author is the show pubkey, precisely because the
  site's note is theirs. Change the bot's note format and
  `buildShowSiteNoteTemplate` in `login-widget/src/lib/boostagram.js`
  together, or the texts drift apart on the show's own profile.

## Featured sections on /feeds (lb-v71)

Every tab has a gold Featured box. An item is featured when a show boost's
message references it: an naddr (calendar event 31922/31923, article 30023,
listing 30402) or the OnlyBoosts episode URL
(`https://onlyboosts.social/episode/<item guid>`). The sats-log bot scans
messages into the boosted-item log the site reads at `/api/meetups`; each tab
filters that one file to its kind (`assets/js/featured-*.js`, shared parts in
`featured-shared.js`). Two things fail silently if missed:

- **The Feature boost pays the maker the show's reassignable leg** (34%,
  aquafox30) via `openShowBoost({ feature })`; see
  `login-widget/src/lib/featureSplit.js` and `BoostModal.splitsForFeature`.
  Host legs are never reassignable. A podcast episode's leg becomes the
  podcast's value block (proportional, keysend nodes included). A feature
  with a pubkey and no address is resolved in the widget before the modal
  opens; self-features fall back to standard splits.
- **The site-signed show note mirrors the bot's web-link lines**
  (`webLinksForMessage` in `boostagram.js` ↔ `_WEB_LINK_BY_KIND` in
  `bots/shared/boost_formatter.py`): 📅 plektos, 📄 mynostr, 🛒 shopstr, one
  line per naddr, after 💬. Adding a featurable kind means both sides plus
  `FEATURABLE_KINDS` in the bot. The episode URL needs no extra line.
- **A feature lives 33 days** (`FEATURE_TTL_DAYS` in `featured-shared.js`,
  enforced by `inFeaturedRange`), then the item rejoins its feed with the
  Feature button back; re-boosting renews. Events are exempt (`ttlDays: 0` in
  `feeds.js`): featured until the event happens.

## Bot infrastructure documentation

The detailed bot infrastructure notes live in `bots/CLAUDE.md` (gitignored,
machine-local only) and `bots/nostr bots/bots-config.md` (also gitignored).
The public `bots/README.md` covers what the bots do at a high level.
