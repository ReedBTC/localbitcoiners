# Decoupling from the home node — design notes

**Status:** brainstorm / not started. Drafted 2026-07-23.

Two related goals:

1. **Resilience** — home internet or node down shouldn't halt boost notes, stats,
   or community feeds.
2. **Portability** — someone else with a podcast, band, or meetup should be able
   to run this stack without access to Reed's Alby Hub.

Nostr-primary ingestion serves both. VPS hosting serves the first and is
independently worth doing.

---

## What already exists

This is less new construction than it looks:

- `bots/community-scan/boost_pipeline.py` **is already a nostr-primary boost
  detector** — NIP-73 `#i podcast:guid:` / `podcast:item:guid:` parsing,
  kind-9735 receipt resolution, bolt11 amount extraction, feed-parameterized.
  It publishes website cards instead of notes. That's the only difference.
- Website boosts already emit nostr evidence at boost time (kind 30078 per leg),
  and `login-widget/src/lib/payAllLegs.js:267` states the bot picks them up
  "via the kind 30078 lookup keyed on payment_hash" — payment_hash is already
  the chosen identity key on that path.
- `shared/boost_formatter.bolt11_amount_msats()` already decodes bolt11.
- Feed-identity gating on the classifier (commit ef1814d) was the first step
  toward a forkable, per-podcast configuration.

---

## The honest limit

The node can't be removed. It can be **demoted from *trigger* to *one witness***.

| Source | Visible on nostr? | Notes |
|---|---|---|
| Website widget | Yes — kind 30078 per leg | keyed by payment_hash |
| Fountain | Yes — kind-1 + 9735 trailer | latency: comment-indexing defer already handled |
| BMB / other NIP-73 apps | Yes | |
| Castamatic, Podverse, plain keysend | **No** | node-only, permanently |
| Tardbox, lb_donation, address boosts | **No** | lnbits `extra.comment` only |

Keysend from non-nostr apps has no nostr trace and never will. The node stays
authoritative for those, and stays the only source that can say *sats actually
landed* rather than *sats were attempted*.

Target architecture: several ingest paths of equal rank, feeding a reconciler
that owns dedup and publish decisions. Node is one path, not the clock.

---

## Linchpin: payment_hash as universal join key

Everything depends on being able to assert "this nostr event and this node tx
are the same boost." payment_hash spans every source:

- Node tx — has it
- lnbits payment — `shared/lnbits_source.py:108` already keys on it
- Website kind 30078 — already carries it
- Fountain / BMB kind-9735 — the bolt11 encodes it in the `p` tagged field;
  we already parse that bolt11 for the amount, so this is a small extension

**Do this first, regardless of what else gets built.** Persist payment_hash on
every `sats.csv` row from all four sources. It's cheap, additive, backward
compatible, changes no behavior, and it converts dedup from a policy problem
into a lookup. It also makes the recurring manual off-node backfill audit
largely automatic.

Without it, multi-source ingest double-publishes. With it, the rest is
tractable.

---

## The hard problem: spoofing

Node-triggered publishing is inherently spoof-proof — sats arrived or they
didn't. Nostr-triggered is not. Anyone can publish a kind-1 tagged
`#i podcast:guid:56fbb1aa` claiming a 1M sat boost.

For community-boosts *cards* this was low stakes. For LB's own publish path —
notes, leaderboards, stats — it would hand strangers write access to the show's
numbers. So nostr-primary requires an explicit evidence ladder:

1. **Node / lnbits settlement.** Highest. Sats confirmed received.
2. **Valid kind-9735** where the receipt is signed by the zap-service pubkey
   advertised in the recipient's lud16 `nostrPubkey`, *and* the bolt11 pays a
   recipient we recognize (our lud16, our node pubkey, or a known split
   recipient from the RSS value block). Strong — attested by the payee's
   infrastructure, not by the claimant.
3. **Website kind 30078 from our own widget.** Trusted as our own code path, but
   asserts *attempted*, not *settled*.
4. **Bare kind-1 with an amount tag, no receipt.** Display only. Never
   publishes, never counts toward leaderboards.

Tier 2 is good enough to publish on — it's what Fountain's own social layer
trusts. Tier 4 must never reach the publish path or `sats.csv` totals.

---

## What this fixes that node-primary structurally cannot

Two failure modes are invisible to a node-triggered bot by construction:

- **Failed node-leg boosts.** Ep019's failing guest leg is the mirror case. When
  *our* leg is the one that fails, the boost really happened, the other
  recipients really got paid, and the node saw nothing. Currently caught by
  running the reverse `#i` scan audit by hand.
- **Node down, splits still paid.** Website and Fountain boosts fan out to many
  recipients. The node being unreachable doesn't stop the boost — it only erases
  our record of it.

This is the strongest argument for the work: it closes a data gap that
node-primary can never close, and retires a recurring manual chore.

---

## Open decision: intended vs. actual sats

Nostr reports *intended* sats. The node reports *actual*. The stated endgame
(see boost-receipt telemetry work) is crediting actual.

If nostr becomes a publishing source, some notes will be intended-only.
Recommendation: carry both fields and let display vs. accounting each pick.
But this is a decision about what the leaderboard *means*, not a technical one,
and it needs answering before nostr is promoted to a publish source.

---

## VPS migration

### Moves today, no real thought required

Pure-nostr bots — nothing but relays and the website repo:

- `community-scan` (quick + deep)
- `follow-packs`
- `bug-watcher`
- `clips-publisher`
- `leaderboards` (reads `sats.csv`; needs the file, not the node)

Moving just these kills most of the home-internet dependency.

### The wall: node-touching bots

Alby Hub is on the LAN. lnbits is `192.168.1.219` via an `/etc/hosts` entry on
ai71. A VPS can reach neither. Options, best first:

**1. NWC instead of the Experimental API token.** NWC rides nostr relays — works
from anywhere, no port-forwarding, no tunnel, revocable per-connection with a
zero spend cap.

*Concern raised:* during the big Alby outage, unrelated wallets (Minibits,
Primal) also had NWC problems. Is NWC secretly Alby-dependent?

*Likely mechanism:* not the wallets — the **relay**. NWC is encrypted
request/response events (kind 23194/23195) over a relay named in the connection
URI. `wss://relay.getalby.com/v1` is the de-facto default in many NWC connection
strings and client libraries, including ones issued by wallets otherwise
unrelated to Alby. If that relay degrades, every connection pointing at it
breaks while both wallet and node are healthy. *This is a hypothesis about the
mechanism — the specific Minibits/Primal attribution is unverified.*

*Mitigation, and it's a good one:* the relay is a URI parameter, and we run
`relay.mynostr.app`. Point Hub and the bot at our own relay and Alby's
infrastructure leaves the path entirely — making NWC **fewer** dependencies than
the API token, not more.

*Must verify before committing:*
- Does Alby Hub let you set the relay on connections it issues?
- Does NWC's transaction-list method give the pagination depth we need? The
  un-paginated window-loss bug (see `project_boost_publisher_window_loss`) was
  expensive; do not switch blind.

**2. cloudflared tunnel.** Already installed on the home box. Works, but the home
box still has to be up — that moves the compute, not the dependency. Reasonable
as an NWC fallback, and the two aren't mutually exclusive (try NWC, fall back to
HTTP-over-tunnel).

**3. lnbits over Tor from the VPS.** Works, adds a fragile hop. Preferred
alternative: leave lnbits as enrichment-only. It already fails safe — unreachable
lnbits yields `{}`, no enrichment, never a crash — so accept degraded boost
comments during an outage rather than engineer around it.

### Managing the bots from home after the move

Desired: keep editing here, push updates over the tunnel. Options:

- **git-pull deploy.** VPS pulls from the repo on a timer or a webhook. Simplest,
  auditable, and rolls back cleanly. Fits the existing restricted-rsync +
  Caddy pattern already used for the community-scan JSON.
- **rsync push over the existing restricted channel.** Already have the pattern
  and the auth. Least new infrastructure.
- **SSH over cloudflared.** Fine for interactive work, less good as the deploy
  mechanism.

Caveat that has bitten before: systemd-timer bots auto-deploy on edit — whatever
is on disk runs at the next tick. Whatever the deploy path, check
`systemctl list-timers` before pushing to a hot bot, same as locally.

This overlaps the existing sats-log VPS migration project (phase 1 done
2026-07-18, phases 2–5 pending). Treat it as the same effort.

---

## Cloudflare edge signing — evaluated, ranked low

Idea: put the LB nsec in Cloudflare Pages encrypted env vars so the site backend
publishes boost notes directly.

Technically fine — Pages secrets are encrypted at rest and not readable from the
client bundle. Reservations:

- The win is **latency** (instant note vs. up to 5 min), not resilience. The
  megathread is append-only; nobody is harmed by a 5-minute delay.
- The cost is a hot signing key for the show identity in a third-party edge
  runtime, plus new state infra (KV or D1) to replace `published_events.json`
  for dedup, plus Pages Functions have no cron — a separate Worker would be
  needed for the reconciliation pass anyway.

**Better shape if the latency ever matters: NIP-46 bunker on the VPS.** Key lives
in exactly one controlled place, the edge requests signatures, connections are
individually revocable, and every signature request is logged. Same latency win,
far smaller blast radius.

Ranked below nostr-primary ingest and the VPS move: those change what's
*possible*, this only changes how fast.

---

## Separate idea: let the donor publish their own boost note

The website is currently a special case in the pipeline. It doesn't have to be.
If the logged-in donor published their own NIP-73 kind-1 — exactly what Fountain
does — then our own site becomes just another boost app to the bot, and the
special-case path collapses into the general one. Bonus: donors get a boost note
in their own feed, which helps reach.

Tradeoff is real: it changes the social surface. Today the show account authors
boost notes with no `p` tag and donors are never notified. Donor-authored notes
flip that. Not obviously wrong — but a product decision, not plumbing.

---

## The fork story

Once the reconciler is source-agnostic, the entire config for a stranger's
podcast is:

- podcast guid
- nsec
- relay list
- *optionally* node credentials

Nostr-primary is what makes it forkable. Nobody else can plug into Reed's Alby
Hub, but anyone can scan relays for their own guid. Node credentials become an
optional enhancement that adds keysend coverage and settlement verification,
rather than a hard prerequisite.

---

## Suggested order

1. **payment_hash on every row.** Extend the bolt11 parser to pull the hash;
   persist from node, lnbits, 30078, and 9735. Cheap, no behavior change.
2. **Shadow ingest.** Run the LB-gated `boost_pipeline` against our own guid,
   write to a side file, publish nothing. Diff against node-derived rows for a
   couple of weeks. Produces real numbers — how many boosts nostr sees that the
   node missed, how many are node-only, how often amounts disagree. Answers
   "is this worth it" with data, and automates the backfill audit as a side
   effect.
3. **VPS move**, pure-nostr bots first. Independent of 1 and 2 — can start any
   time. Then node access via NWC once the relay and pagination questions are
   answered.
4. **Promote nostr to a publishing source** for gap cases only (failed node leg,
   node-down windows), gated on tier-2 evidence, reconciler owning dedup.
5. Bunker / edge signing, only if latency turns out to matter.

Steps 1–3 are strictly additive and cannot break the publish path. That
ordering is deliberate: a bad publish can't be undone.
