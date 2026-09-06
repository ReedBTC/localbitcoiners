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
  rebuilt bundle, then run the five test scripts from the repo root:
  `node scripts/test-sign-boost.mjs`, `test-boost-modal-render.mjs`,
  `test-keysend-upgrade.mjs`, `test-boostbox.mjs`, `test-payment-lookup.mjs`.
  They prove shapes, not rendering — after a structural change, open a modal
  in a browser.
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

Two payment-path rules ported from OnlyBoosts on 2026-09-04 (their 1f673bd5
and 18d0febb), applied to BOTH boost paths here, since the show's own leg
runner (`payAllLegs.js`) restates the keysend leg rather than importing it:

- **The wallet is the second source of truth for an unconfirmed leg.**
  `paymentLookup.js` (pure) + `nwc.js#lookupPayment` (NIP-47 `lookup_invoice`
  by payment hash, through the raw `executeNip47Request` because the SDK's
  `lookupInvoice` rejects a keysend's empty invoice) +
  `externalBoost.js#confirmLegSettled` (wallet and LUD-21 under one deadline).
  A keysend stamps sha256(preimage) on the leg *before* the pay call so a lost
  reply still leaves something to look up. Every ambiguous-payment site goes
  through `confirmLegSettled`: the external leg loop and its watcher / Check
  again, `payAllLegs.js`, the retry guard in `MultiLegBoostForm.jsx`, and
  `payInvoiceVerified`. ⚠️ Only the wallet's explicit `state: "failed"` moves
  UNCERTAIN to FAILED (the status that offers a re-pay); it is never inferred
  from NOT_FOUND, a missing `settled_at`, or an error. `test-payment-lookup.mjs`
  is red on each of those inferences and scans the call sites.
- **A node address is not always a pubkey.** A value block's `type: "node"`
  recipient may be the whole connection string `<pubkey>@<host>:<port>`, and
  a wallet refuses it. `keysendLookup.js#nodePubkeyOf` takes the head under
  the strict compressed-pubkey test; all four keysend call sites (both paths,
  NWC and WebLN) pay what it returns and fail cleanly before any wallet is
  asked when it returns null. `leg.recipient.address` stays as published.
  `test-keysend-upgrade.mjs` scans the call sites.

## Featured sections on /feeds (lb-v71 → lb-v75)

Every tab has the same gold Featured box (`featuredHead()` and the credit
builders in `featured-shared.js` are the only place its chrome lives; the
Events card keeps its own credit builder in `calendar-events.js`, kept in
step by hand). An item is featured when a show boost's
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
- **Episode rows in `meetups.csv` have no naddr and no `event_kind`**
  (`extract_meetup_rows` in `bots/sats-log/local_bitcoiners_satslog.py`):
  their key is `coordinate = podcast:item:guid:<guid>`, the guid urldecoded
  from the OnlyBoosts URL path *whole* — item guids are opaque, some contain
  slashes, some are full URLs. Split on `/` or treat a blank `event_kind` as
  malformed and the Podcasts tab silently empties.
- **An anonymous feature is credited by name, not by profile.** A boost paid
  without a Nostr identity reaches the log with `sender_npub` empty and
  `sender_name` carrying whatever the booster typed (the boost form stamps
  "A Local Bitcoiner" when that field is blank, and the sats-log side keeps the
  two columns mutually exclusive). Both credit builders render that name as
  plain text with no avatar, falling back to the literal for rows written
  before the `sender_name` tag existed; `ANON_BOOSTER_NAME` in
  `calendar-events.js` is the single definition.
- **A feature lives 33 days** (`FEATURE_TTL_DAYS` in `featured-shared.js`,
  enforced by `inFeaturedRange`), then the item rejoins its feed with the
  Feature button back; re-boosting renews. Events are exempt (`ttlDays: 0` in
  `feeds.js`): featured until the event happens.

## Stats, supporters and boosts pages (lb-v76, 2026-08-29)

`/stats` is tiles and ranked lists; `/supporters` is the OnlyBoosts community
wall (podium of 5, 21 visible, Show more / fewer); `/boosts.html` has a
Sort + 1W/1M/All head. Things that fail silently if missed:

- **`COSTS` in `assets/js/stats.js` is hand-maintained.** One entry per
  monthly bill (Fountain + Riverside). The Rev (Net) / Reed (Net) tiles
  subtract half of it each, prorated across the bill's calendar month, so a
  missing month quietly overstates both hosts. Reed supplies the numbers;
  Aug and Sep 2026 were entered at July's figure (74,700 sats).
- **Sat tiers are retired.** No 100k/69k/21k buckets, rings or labels
  anywhere; `supporter-set.js` unions every kind-39089 pack the show
  publishes, so a stale tier or coders pack left on relays re-adds its
  members. The bot must delete retired packs, not just stop updating them.
  Done 2026-08-29: the four tier packs and the coders pack were published
  empty, and `RETIRED_PACKS` in the follow-packs bot keeps re-asserting that,
  so only `lb-supporters-all` and `lb-supporters-guests` carry members.
- **Stream rows in `sats.json` are per-(episode, supporter) aggregates**
  stamped with last activity, not payments. A 1W/1M window on streamers
  means "who streamed in it", and their sats can include earlier listens of
  the same episode; boost and zap rows are per payment. Say so in any new
  subline, do not present a stream window as exact.
- **By App tiles are data-driven** from `row.app`; a new app appears on its
  own the first time it boosts. Colors are a fixed map (`appColorVar`);
  add one when a new app shows up grey.
- **Two range windows are intentionally off by design; do not "fix" them.**
  The 1M on the stats page's Biggest Boosts - Notes section is 33 days
  (`MONTH_WINDOW_DAYS` in `stats-boosts.js`, an easter egg), and the 1W on
  `boosts.html` is 8 days (`WEEK_WINDOW_DAYS`, one day of overlap so Reed and
  Rev can find where they left off reading boosts on the show). Every other
  1W / 1M on the site is 7 / 30 days. The 33-day subline is now stated on the
  page, in `stats.html`'s static copy and in `updateSub` (Reed's call,
  2026-09-01) — keep both in step; the 1M pill's own "Last 30 days" label is
  the bucket's shorthand and stays. The 8-day 1W is still unadvertised.
- **The top-boosts leaderboard bot uses that same 33 days**
  (`TB_WINDOW_DAYS` in `bots/leaderboards/local_bitcoiners_leaderboards.py`,
  measured back from the moment the bot fires). It used to rank all time.
  The bot's weekly note and the site's Biggest Boosts section are meant to
  show the same set — change one window and change the other.
- **The range/sort widgets exist twice on purpose**: `assets/js/head-controls.js`
  for module pages (boosts.html), a classic-script copy inside `stats.js`.
  The `.pcast-range` / `.pcast-sort` CSS is copied per page (feeds, stats,
  boosts, supporters) with `--accent` / `--accent-d` / `--tint` set locally.

## Backfilled rows in the sats ledger

Some `data/sats.csv` rows record boosts that were **sent but never arrived** —
a value-split leg failed at the payer's wallet, so our node never saw the
money and only Nostr proves the boost happened. They are marked by a
`total_sats_method` beginning `nostr backfill (`, and they carry `our_sats=0`
with the donor's Nostr note id as the `payment_hash`.

Their five split columns hold the **intended** RSS split, not sats actually
received — the columns must sum to `total_sats` (`apply_value_splits` rescales
them otherwise, and the stats-page split chart assumes that conservation), so
the failed recipient's bucket over-credits by the unpaid leg. Anything
reasoning about *money received* rather than *boosts sent* should exclude
these rows; supporter counts and episode totals are meant to include them.

## Bot infrastructure documentation

The detailed bot infrastructure notes live in `bots/CLAUDE.md` (gitignored,
machine-local only) and `bots/nostr bots/bots-config.md` (also gitignored).
The public `bots/README.md` covers what the bots do at a high level.
