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

## The homepage is rails, the feeds are pages (rails-homepage, lb-v95; headings and Top Episodes lb-v100)

Since 2026-11-07 (Reed, after the OnlyBoosts homepage's feedback: "nobody
likes the tabs") `index.html` is the hero, the latest-episode card, the
Episodes / Boosts / Stats row, then one sideways row of tiles per
community section, the OnlyBoosts discovery homepage's shape: "Meet the Community" (the top ten supporters, round tiles, name alone, on the white
full-width band `#community-band`), then under `#feeds` "Find Upcoming Events", "Shop with Local Bitcoiners", "Discover New Podcasts" and "Read Articles from the Community", each heading linking its own page: `events.html`, `market.html`,
`podcasts.html`, `articles.html` (`/events` …). **Every rail heading is a
call to action, not a label, in Title Case** (Rev on the 2026-11-08 call, Reed agreed; the wording is Reed's own, 2026-11-09:
the site's purpose is discovery and "Community Events" told a first-time
visitor nothing about what to do there; it replaced the one-day "Community
<Feed>" labels of lb-v99). Keep them accurate: the events and marketplace
rails are everything community members posted, not a curated pick, so no
heading promises curation. Beside each of the four's See all link sits
"Feature an event / item / episode / article", a link to the same page
dressed as the featured tiles are (gold ring, gold circle with the white
bolt; Reed, 2026-11-10: so the visitor learns what the gold-ringed tiles
are) (Reed, 2026-11-10: nothing is featured FROM the homepage, the link
sends them to the page's gold box and the cards' Feature buttons); the
`.rail-actions` pair wraps under the heading where it no longer fits
beside it. Then "Check Out Our Top Episodes", the last
rail (Reed and Rev, 2026-11-08; it was Latest Episodes for a day: the top
episodes are where new listeners are told to start, "latest" reads as the
one you already heard): the stats page's Episode Leaderboard in its
opening Overall view, the first ten, the rule in `episode-rank.js` (a NEW
pure module, `scripts/test-episode-rank.mjs`; `renderLeaderboard` in
`stats.js` is the classic-script copy, change both), each tile the show's
cover with the episode's city or meetup across its top (`.rt-cap`, the
place parsed from the title by `episodeTileParts`: after the colon in the
" w/<Guest>: <Place>" part, else a colon segment that does not say
"Meetups", else episode 1's "| <Place>" tail; Reed does NOT want
per-episode art, "the same background with the location on it"), the rank
chip (`#1`, `T#1` on a tie) on its corner, the title cut at " w/", ": " and
" | Ep.", the sub line "w/ <name>" ("&" between two names) or "Solo rip"
(Reed's words, keep both), a tile is a LINK to `/ep###`, the heading links
`/stats#episode-leaderboard`; the inline RSS script publishes the parsed
items as `window.__lbEpisodeItems` + the `lb:episodes` event, and
`supporters.js` publishes the ledger rows it fetched for the Community
rail as `window.__lbSatsRows` + the `lb:sats` event (null on a failure),
so the rail fetches neither twice (it fetches `/api/sats` itself only when
no `lb:sats` comes inside 15 s). Latest Boosts keeps its name (Rev: the
endless boost feed is right as it is). The page ends in Latest Boosts
(`#home-boosts`, `home-boosts.js`, 2026-11-08):
the boost wall's cards newest first, 25 per "Load more boosts", in the
page's own `--feed-track` column, without the boosts page's sort and
range and without the New Member badge; `fetchBoostThread` +
`renderChildCards` + `configureBoostActions` exactly as `boosts.html`, and
the login widget is kicked when the section loads so the action bar works. A tile is the picture, the title and one line (date, price,
show, author); featured items come first with a gold ring and the bolt; a
click opens the page's own card in a modal (an event card with the whole
event: `renderEventCard(…, { description: true })` adds the picture across
the card and the NIP-52 content as paragraphs, Reed 2026-11-08; an episode
card; the article reader; a listing opens merch.js's product modal). The tabs,
the Featured / All sub-row and the `?feed=` URL state are gone. Things that
fail silently if missed:

- **The rails read the pages' own data, never their own.** `home-rails.js`
  calls `loadEventRail` + `renderEventCard` (feeds.js), `loadMarketItems` +
  `priceText` + `openListing` (feeds-market.js), `loadPodcastItems` +
  `railEpisodes` + `openEpisodeCard` (feeds-podcasts.js), `loadArticleItems`
  + `openArticleReader` + `articleAuthorName` (feeds-articles.js),
  and the featured sets from the `featured-*` modules, so a rail and its
  page agree on what is featured and in what order. `loadEventRail`'s state
  must keep the SAME SHAPE as `loadEvents`'s (`featuredCoords`, `featuredBy`,
  `featuredAt` included): the two share the localStorage cache and its
  hydrator writes every field (the rail went blank on a second visit before
  that). The Community rail is `supporters.js`'s rail mode (`renderRail`,
  `RAIL_SIZE` 10, `#community-root`), the wall's cards restyled as tiles by
  `home-rails.css`; `/supporters` keeps the wall. WHO is on it is the
  stats page's Supporter Leaderboard in its opening "Episodes Supported"
  view (Reed, 2026-11-08: the hosts read that list off on the show), the
  rule restated in `leaderboardPeople` (hosts out, npub else name,
  distinct `episode_num`, stable sort, ten); change `renderIdentityBoard`
  in `stats.js` and change it too.
- **Rail orders are Reed's (2026-11-07).** Events: featured first, then
  soonest; in-person only like the page's default, except a featured event
  of any type; and only events that have NOT STARTED (`startMs > now`,
  2026-11-08: a weekend event on its second day printed its start date and
  read as past), where the page keeps events in progress. Marketplace: paid features and the house store's listings
  first (a house listing displays as featured), then the page's Buy-Now-first
  order. Podcast Boosts: features first, then "most boosters over the
  narrowest air-date window with something in it", the page's opening sort.
  Articles: features first, then the page's order, and ONLY ARTICLES WITH
  A COVER (2026-11-08, featured ones included; the avatar fallback made a
  row of faces; the page lists them all). Pictures: the event's image else
  the organizer's avatar; the article's cover.
- **The feed pages are one panel each, hydrated by `feeds.js` off
  `<body data-active-feed>`**, with `data-feed-view="page"`: the gold box
  first, then the list, and an item appears ONCE: all four renderers leave
  a featured item out of the list again (the 2026-09-06 "All includes the
  featured items" rule is reversed; the `visible` sets do the exclusion).
  The Events panel head's Create button is hidden on the page (the box's
  copy shows). `feed-page.js` carries what the homepage's inline block
  carried for the feeds (the widget loader, Create, the Find modal, the
  nav's Boost / Log in) and the page's URL: the controls are plain query
  params (`/events?range=1m&type=virtual`, `/market?cart=1`), written from
  `lb:feed-params`; `initialFeedParams` accepts the body's feed when the
  URL names none. `feed-page.css` is the pages' scaffold; `feeds.css` is
  the former inline block of `index.html` (panels, cards, boxes, modals,
  the per-feed accents), linked by the pages AND the homepage (the modals
  need the card styles); its tab-chrome rules are dead.
- **The pre-rails URLs still route.** `index.html`'s head script forwards
  `/?feed=<tab>…`, `/#<tab>` and `/#market-cart` (published notes carry
  them) to the pages, keeping `range/sort/type/short` and `cart`.
  `_redirects`: `/feeds` → `/#feeds` (the rails), `/meetups`, `/newevent` →
  `/events`, `/merch` → `/market`. The note templates (three
  `FEATURE_TEMPLATE`s, `PROMOTE_TEMPLATE`, the three in the widget's
  `eventAnnouncement.js`) print `https://localbitcoiners.com/<page>`.
  `nav.js`'s cart rule keys on `/market` (and the old homepage test for
  cached copies); the nav partial's Community group links the four pages.
- **Every column is `--feed-track`** (defined in `feeds.css`): 60rem, and
  72rem from 1100px up, OnlyBoosts' `--page-track` of its favorites-recommend
  branch (Reed, 2026-11-08: "that's what I want the width of our page to
  be"; the @media rule sits right after the base `:root` so it wins). It is
  `.featured-wrap`, `.home-module`, `.rail`, the pages' `.feeds-shell-wrap`;
  the nav bar is OB's 1240px. Rails show 4 tiles from 640px, 5 from 900px
  and 10 from 1100px (OB's counts), scrolling for the rest. `/supporters`
  keeps its own 60rem wall.

## Featured sections on the feeds (lb-v71 → lb-v75)

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

- **The Feature boost pays the maker the show's reassignable leg** (32%,
  the show's V4V wallet `lb_v4v@getalby.com`) via `openShowBoost({ feature })`; see
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
- **The Episode Leaderboard ranks by the wall's chart rule** (since
  2026-09-22): Overall (default), Most Sats, Most Boosts, Most Supporters.
  Overall is each episode's competition rank in the three summed, lowest
  first, ties supporters → sats → boosts, ranked over every episode before
  the top-10 cut. It is a ranked list, not bars (the OnlyBoosts chart-board
  row): `#`-prefixed position (T# on a shared place), title linking to the
  episode page, and at the right the view's total or, on Overall, the three
  component ranks as sats / boosts / supporters under a "rank in" head.
  `compRanks` is duplicated in `stats.js` (classic script),
  `supporters.js` (module) and `assets/js/episode-rank.js` (the pure module
  the homepage's Top Episodes rail ranks by, since 2026-11-09, whose
  `overallOrder` restates `renderLeaderboard`'s Overall step for step), and
  the weekly episodesats note ranks by the same rule (`eps_rank` in
  `bots/leaderboards/local_bitcoiners_leaderboards.py`, since 2026-09-22);
  change the rule in all four. The "My Stats" view is
  gone; Episodes You've Supported covers it.
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

## The boost wall shows the booster's own note (lb-v86, 2026-10-17)

The OnlyBoosts model, Reed's call: one card per boost, the booster's OWN
kind-1 (Fountain, the site's episode flow, BullishBoosts, …) when the wall
record carries it, the show bot's note otherwise. Same cards on `boosts.html`,
every `/ep###` and the stats page's Biggest Boosts. The bots side stores the
donor note on the wall record (`donor_event`, `donor_note_id`, `donor_match`,
`message`; the bot's `boost_wall.py` is the schema) and the weekly topboosts
note embeds it. Things that fail silently if missed:

- **The show note is still the key.** Thread position, `EXCLUDED_NOTE_IDS`,
  the card cache, `getBoostMeta`, the New Member payment-hash join and the
  `childrenOf` map all key on the record's `event`. `renderNoteCard(ev)`
  takes the thread event and swaps `displayEventFor(ev)` in for the author,
  body, Nostr link and action bar; the card's time is `boostTimeOf` (the
  payment's `settled_at`), the clock the Latest sort and the range windows
  use, so a list sorted by Latest reads monotonic. Never put the donor event into the
  thread; it is not a reply to the root and `buildThread` would drop it.
- **Nothing reads the shown note's text or time.** A Fountain donor note is
  the comment only: no sats, no app, no episode. Sats, settled time and
  episode come from the record through `assets/js/boost-record.js`
  (`boostSatsOf`, `boostTimeOf`, `episodeNumMatches`), a NEW module on
  purpose so it is testable in Node (`scripts/test-boost-record.mjs`) and
  so `boosts-thread.js` grows no new export. The 💰 and 🎙️ regexes are
  fallbacks for events without a record only. Sort and range windows use
  `settled_at`: donor notes land anywhere from 13 min before to 15 min after
  the payment, and the show note's `created_at` is the bot's publish time.
- **The meta row** (`.note-meta`: ⚡ sats, "via app", the episode TITLE
  linking to `/ep###`; since lb-v90 the OnlyBoosts card, Reed's call
  2026-10-29) prints on every card whose record carries `sats`, including
  show cards whose text already says it (the pre-ledger records have no sats
  and get no row). The parts and the link live in
  `assets/js/boost-card-meta.js` (`metaRowOf`; a NEW module on purpose, the
  same reason as `boost-record.js`, whose `metaStripParts` stays for stale
  importers and is no longer read), tested by
  `scripts/test-boost-card-meta.mjs`. The title is the record's
  `episode_title` with the `Local Bitcoiners •` prefix cut; the number alone
  is the fallback, "Show boost" for show-level records. The episode's own
  page passes `hideEpisode: true` (sats and app only; the title would restate
  the heading).
- **The author is clickable on a person's note, never on the show bot's**
  (`renderNoteCard`, keyed off the root nevent's author TLV): the site-wide
  rule from `assets/js/onlyboosts.js`, their OnlyBoosts page when they have
  one (blue dot on the avatar) or a copy of their npub (toast via
  `.lb-toast`). The NAME is the control (`<a>` or `<button>`), the avatar
  wrapper a mouse-only duplicate (`aria-hidden`, `tabindex=-1`). The link-or-
  copy choice is made at render and never revised, so `fetchBoostThread`
  awaits `ready()` (2.5 s cap, resolves on failure) before `onPartial` and
  before returning; `onlyboosts.css` must be linked on every page that
  renders these cards (`boosts.html`, `stats.html`, the `/ep###` head in
  `functions/_middleware.js`).
- **A donor note is verified three times**: signature (same chunked pass as
  the show note), signer == the record's `sender_npub` (a named sender that
  does not decode as an npub refuses the note; only a blank sender admits any
  signer), and, on a Fountain
  record, comment == the record's `message` (`donorEventProblem`;
  `normalizeComment` folds the ledger's literal `\n` pairs, Fountain's
  trailer in either form and the no-comment sentinel). The third catches the
  bots' npub-only tier pairing one booster's note with their other boost
  minutes apart (Reed found one on 2026-10-19). Any failure drops the donor
  note and renders the show note; the record is never dropped. A record with `donor_note_id` but no `donor_event` is
  "known, not fetched" and renders the show note too.
- **Fountain's trailer is stripped at render only** (`stripFountainTrailer`,
  the bot's rule, no-op unless the trailing nevent is a kind-9735 zap
  receipt, with or without Fountain's episode URL before it since
  BoostMeBitch appends the receipt alone). The signed event is never rewritten; `finishBoostThread` scans
  the stripped text so the receipt is not fetched as a quoted note.
- **Replies to a donor card are top-level replies to the booster's note**
  (`buildReplyTags`: a parent that does not reference the thread root gets
  `['e', parent.id, '', 'root']` and nothing else). Like, repost and zap act
  on the shown note and its author's lud16.

## Links inside a note paint what they point at (boost-media-previews, lb-v92)

Reed's ask, 2026-11-07: people share GIFs in boosts now, and a note full of
bare URLs read as a block of blue text. `renderSegmentsInto` in
`boosts-thread.js` (the one tokenizer behind the boost wall, `/ep###`, the
stats page's Biggest Boosts and the Podcast Boosts feed's messages) now
treats a `link` token three ways: a picture or clip renders inline, a page
link renders as a shortened anchor with an Open Graph card under it, and
anything else stays an anchor. Things that fail silently if missed:

- **App boilerplate comes off at render** (`stripBoilerplate` in
  `note-media.js`, OnlyBoosts' rule of the same day, called in
  `renderContentInto`, the embed snippet and the Podcast Boosts feed): a
  listen link ALONE on its line (the bot's `🔗 https://fountain.fm/episode/…`,
  Fountain's donor-note footer, BoostMeBuddy / BoostMeBitch `?podcast=`,
  Podcast Index, pod.link, OnlyBoosts, this site's bare `localbitcoiners.com`
  and `/ep###`), a share-card image (`/og/boost.png`) and the three app
  banners anywhere. A link inside the booster's sentence stays, and so do
  the 📅 / 📄 / 🛒 feature lines. Measured 2026-11-07: 597 of 616 wall
  records carried a URL, almost all of them these. The strip is display
  only; `finishBoostThread` scans the unstripped text for quoted notes.
  Widen `LISTEN_LINK_RE` when a new app's footer shows up as blue text.
- **What a URL is lives in `assets/js/note-media.js`** (a NEW module on
  purpose, pure, tested by `scripts/test-note-media.mjs`): image / video by
  extension, else by the note's NIP-92 `imeta` tag (`m image/png` beside the
  url; the renderer passes the SHOWN event's tags, so a donor note's imeta
  is read, not the show note's). `linkLabel` is the anchor text (host and
  path, 48 chars; the href keeps the whole URL), `splitTrailingPunct` keeps
  a sentence's full stop out of the href. OnlyBoosts rejected inline images
  on 2026-08-21 as making the cards too tall and brought them back on
  2026-11-07 in a 280×200 box; `.note-media` in `boosts-thread.css` is that
  same box (OB's `a.msg-media`), so a card reads alike on both sites.
- **Preview cards come from `/api/link-preview?url=`**, a Pages Function
  that fetches the page at the edge (8 s, 256 KB, public http(s) hosts only;
  `previewTargetProblem` in `functions/_shared/link-preview-parse.js` refuses
  loopback, private ranges, odd ports) and answers `{kind: page | image |
  none}` with a day of cache. The parse is pure and tested beside
  note-media. The browser side (`assets/js/link-preview.js`, NEW) appends a
  hidden slot after the anchor, fetches once the slot is within 400 px of
  the viewport, memoises per URL in memory and sessionStorage, and swaps in
  the card, or inline media when the URL served an image, or nothing on a
  miss. Three cards per body (`PREVIEWS_PER_BODY`); quoted notes (`inEmbed`)
  get none unless the caller sets `previews: true`, which the Podcast
  Boosts feed does because its messages are top-level.
- **Everything from the endpoint is untrusted**: text through textContent,
  image URLs through the http(s) check before `<img>`, never innerHTML.
- **A block inside a pre-wrap body eats one newline on each side**
  (`trimTrailingNewline` and the `afterBlock` flag), or every GIF carries a
  blank line above and below it. A preview that later misses leaves the
  shorter gap; that is accepted.

## "New Member!" badge on the boost wall (lb-v84, 2026-10-08)

`boosts.html` marks a supporter's first boost with a gold "🎉 New Member!"
line above the note body and a brand-orange left edge on the card, so the
hosts can welcome newcomers as they read boosts off. The rule lives in
`assets/js/new-member.js` (a NEW module on purpose; `boosts-thread.js` is
shared and cached) and `scripts/test-new-member.mjs` covers it. Reed's
calls, each of which fails silently if loosened:

- **Npubs only.** Identity is `sender_npub`; a name-only boost (Fountain
  username, keysend boostagram name, the site's "A Local Bitcoiner" default)
  never gets the badge and does not spend the npub's. Names vary by app and
  a regular boosting without their npub attached looked like a newcomer.
- **Hosts and past guests are never new.** `HOST_NPUBS` in the module plus
  every npub from `/api/guests`, whichever came first, the episode or the
  boost. The guest list is required: if it cannot be read, no card gets a
  badge, rather than a guest welcomed by mistake.
- **Only `kind: "boost"` rows count; streams and zaps neither earn nor
  block.** Stream rows are stamped with last activity (see below), so a
  prior stream cannot be ordered against a boost. A long-time streamer's
  first boost is flagged, and that is the intended meaning.
- **The join is by payment hash.** Every boost-wall record matches a ledger
  row by `payment_hash` with the same `settled_at` (466 of 466 on
  2026-10-08). A card the ledger has not seen gets no badge; unknown is
  never new. The page pairs cards with events by list position after
  `renderChildCards`, and the pass is idempotent because cards are cached.
- Boosts page only; the episode and stats pages render the same cards
  without it.

## Donor notes on the boost wall (donor-notes-wall, 2026-10-17)

The wall shows the booster's OWN kind-1 note when one exists and the show's
note otherwise (Reed: "the onlyboosts model"). `data/boost_wall.json` records
carry `donor_event` (the donor's raw signed kind-1), `donor_note_id`,
`donor_match` and `message` beside the unchanged `event`; the site tests
`"donor_event" in rec`, and `event` is always present. The rules live in
`bots/shared/donor_notes.py` and `bots/shared/test_donor_notes.py` pins them.
Things that fail silently if missed:

- **Six rules decide whether a note is the donor's.** The signer must be a
  person (the show key and every OnlyBoosts publisher account are out, and a
  `P` tag is never read); when the ledger knows the npub the note's pubkey
  must be it; a sats-only match suppresses our claim but never attributes;
  an npub-only match with a second note from that npub in the ±15 min
  window is a burst and is paired by episode (the note's NIP-73 item guid
  through the RSS index, else its "for Ep. N" line, then time order inside
  an episode; a note that contradicts itself or names an episode the burst
  lacks is left out and listed); and a Fountain boost's note must carry the
  boost's comment (rule 5, 2026-10-19: the note's text with Fountain's
  trailer stripped contains the ledger `message`, or both are empty; an
  empty note is a different boost, not "no signal", and a same-size note
  that says something else is refused). Only the donor's notes that pass
  are candidates, nearest first; two passing is still a burst. Rule 6
  (2026-10-29, `app_match`): a payment with no npub (a BoostMeBuddy /
  BoostMeBitch / OnlyBoosts keysend) attributes as `sats+app` only on exact
  sats, the note's app equal to the payment's, the note's episode
  POSITIVELY equal (silence is no match), the payment's message however
  short contained in the note (a `nostr:` mention stands for an "@Name"),
  and exactly one person's note passing; it runs after find_match's tiers
  fail, so the publisher's claim decision never sees it. `donor_text`
  / `comment_agrees` in `donor_notes.py` are the one normalisation: the
  ledger keeps newlines as the two characters `\n` and pre-2026-05-10 rows
  keep the whole trailer. Website share notes never carry the message, so
  the rule is Fountain's alone. `set_donor_note` refuses a mismatched
  pair, so a wrong `donor_event` cannot reach the file through any writer.
  After a rule change, `backfill_donor_notes.py --redo` re-pairs the whole
  wall (the plain run only fills records that have no note yet).
- **Three writers, one join.** The publisher captures the note live (the
  receipt's share note when donor-signed, `decide()`'s index match via
  `match_out`, or the claim veto note); `build_boost_wall.py` runs a 7-day
  reconcile for the late cases (`--donor-days`); `backfill_donor_notes.py`
  walks the whole wall once (dry run by default, `--apply` to write). All
  three record `donor_note_id` / `donor_match` / `donor_pubkey` in
  `published_events.json`, which is what the wall is rebuilt from; a
  `donor_note_id` without `donor_event` means "known, not fetched yet".
- **The wall sorts by `settled_at`**, falling back to the show note's
  `created_at` only for the bare records. Never by the donor note's
  `created_at`: it lands anywhere from 13 min before settlement to 15 min
  after.
- **The weekly topboosts note embeds the donor's note** when the record has
  one (`tb_resolve_event_ids`, nevent authored by `donor_pubkey`), our
  standalone otherwise. Reed's call, 2026-10-17.
- **Website donor notes carry the message; Fountain's carry a trailer.**
  `message` on the meta is the ledger's clean copy for the site to use under
  a Fountain note; the signed `donor_event.content` is never rewritten.

## Transcripts: repo .txt for ep001–ep020, the feed's SRT after that

Since 2026-10-25 nobody hand-posts transcripts. `transcripts/` keeps the 20
Riverside exports (15 of them with speaker labels; ep001–004 and ep006 are
plain paragraphs) and the Download Transcript button, in all three places
(`functions/_middleware.js` for `/ep###`, the inline episode script in
`index.html` and `episodes.html`), uses the repo `.txt` when it exists and
otherwise the item's `<podcast:transcript>` SRT from the feed, fetched to a
blob and saved as `local-bitcoiners-ep###.srt` (`[data-lb-download-file]`
in `episode-enhance.js`, the MP3 button's trick; the host ignores `download`
cross-origin but allows CORS). Two things that fail silently if missed:

- **There is no `404.html`, so a missing path is the homepage with a 200.**
  "Does the .txt exist" must test for `text/plain`, never `res.ok` alone;
  before this rule the button on ep021+ downloaded `index.html` under a
  `.txt` name. Adding a `404.html` later is fine, the check still holds.
- **The edge check is `env.ASSETS.fetch` (HEAD).** Without the binding
  (a unit harness) it answers "no" and the button falls through to the feed.

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
