# Sending boosts that Helipad and the Local Bitcoiners bots recognize

A guide for app developers who want a boost to a Podcasting 2.0 value block to
show up on the podcaster's side as a *boost tied to the show and episode*, not
as an anonymous Lightning payment.

Everything here is verified against the Helipad source (`src/boost.rs`,
`src/metadata.rs`, `src/lnaddress.rs`, `src/lightning.rs`), the Local Bitcoiners
bots in `bots/shared/boost_formatter.py`, and live payments observed on the
Local Bitcoiners node.

## TL;DR

There are exactly two payment shapes that get recognized. Pick per recipient,
at send time, based on what the recipient's lightning address supports.

| | **Path A: keysend + TLV boostagram** | **Path B: lightning address (LNURL-pay) + RSS Payment metadata** |
|---|---|---|
| Discover | `GET https://<domain>/.well-known/keysend/<user>` returns `{"tag":"keysend","pubkey":…,"customData":[…]}` | `GET https://<domain>/.well-known/lnurlp/<user>` (standard LUD-16) |
| Pay | keysend to `pubkey`, with TLV `7629169` = boostagram JSON **and** every `customData` entry as its own TLV | request an invoice with `comment=rss::payment::boost <metadata URL> <message>` and pay it |
| Metadata lives | inline in the TLV | at the metadata URL: it must answer `HEAD` with an `x-rss-payment` header |
| Helipad | always recognized | recognized when the URL's domain is `fountain.fm`, `castamatic.com`, `tardbox.com`, or one the podcaster added under *Settings → Additional metadata domains* |
| LB bots | always recognized | recognized for `fountain.fm`, `castamatic.com`, `tardbox.com/boost/` URLs only |
| Wallet needs | keysend with custom TLV records (LND, CLN, Alby Hub via NWC `pay_keysend`, …) | any wallet that can pay a BOLT11 invoice |

What does **not** work, on either side:

- A NIP-57 zap to the lightning address, even with NIP-73 `i`/`k` podcast tags
  in the zap request. Helipad and the bots never see the zap request; the
  payment arrives as an invoice whose memo is the comment.
- A plain LNURL-pay comment that is just the message. Helipad shows it as a
  "Lightning Invoice" from "Lightning Invoice" with no podcast or episode. The
  LB bots ignore it.
- A keysend without TLV `7629169`. Helipad ignores it entirely.

Publishing a kind-1 Nostr note with `i`/`k` podcast tags is great for
indexers such as OnlyBoosts, but it is separate from the payment and does not
make the payment recognizable. Do both.

## How the payee side decides

Helipad, on every settled invoice on the podcaster's LND node
(`parse_boost_from_invoice`):

1. If any HTLC carries TLV `7629169`, parse it as a boostagram. Done. This is
   checked first and applies to keysends **and** to BOLT11 payments that
   carried custom records.
2. Otherwise, if the invoice has no payment request, ignore it (bare keysend).
3. Otherwise, if the memo matches `rss::payment::<action> https://<domain>/…`
   with an accepted domain (or the Podcast Guru `V4V: https://boost.podcastguru.io/…`
   form), `HEAD` the URL, read the `x-rss-payment` header, and build the boost
   from that JSON.
4. Otherwise, if there is a memo, record a generic "Lightning Invoice" boost
   with the memo as the message. Not tied to any show.

The Local Bitcoiners bots (`classify_lb_tx`) follow the same idea from the Alby
Hub transaction list: TLV boostagram with `action == "boost"`, or a
`rss::payment::boost` description whose URL host they know how to read. The
node is a shared split recipient for several shows, so a boost also has to
positively identify the feed (see *Feed identity* below) or it is dropped.

## Path A: keysend with a TLV boostagram

### 1. Resolve the lightning address for keysend first

```
GET https://getalby.com/.well-known/keysend/reed
```

```json
{"status":"OK","tag":"keysend",
 "pubkey":"02dd4192fdc62041cba0b5b6808534c66d7615a2362f2859d957d74d3685c77692",
 "customData":[{"customKey":"696969","customValue":"4"}]}
```

If this returns JSON with `tag: "keysend"`, keysend to `pubkey`. Send **every**
`customData` entry as a TLV record on the payment, key and value exactly as
given (for Alby that is TLV `696969` = the UTF-8 string `"4"`, which routes the
payment to the right account behind the node). Without it the payment is
rejected or lands in the wrong place.

If the request 404s or returns HTML (minibits.cash and primal.net do), fall
back to Path B. Helipad's own sender does exactly this: keysend endpoint first,
then LNURL-pay.

### 2. Attach TLV `7629169` with the boostagram JSON

The field names come from [bLIP-10](https://github.com/lightning/blips/blob/master/blip-0010.md)
and the [satoshis.stream TLV registry](https://github.com/satoshisstream/satoshis.stream/blob/main/TLV_registry.md).
This is the boost from 2026-09-03 rewritten as a keysend leg to Reed:

```json
{
  "action": "boost",
  "app_name": "bullishBoosts",
  "app_version": "1.0.0",
  "podcast": "Local Bitcoiners",
  "feedID": "7683299",
  "guid": "56fbb1aa-da79-5e4b-bebc-3b934ab8914c",
  "url": "https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU",
  "episode": "Quiet on Quantum Loud on Privacy w/Satsie and Armin: Boston, MA | Ep. 027",
  "episode_guid": "12649a7e-ad7e-4db6-a384-56900442ab6c",
  "itemID": "59848974289",
  "message": "I've got my eyes on Payjoin. 👀 Hopefully can integrate it into some of my projects when the tools become easier to use.",
  "sender_name": "The Bullish ₿itcoiner",
  "sender_id": "a10260a2aa2f092d85e2c0b82e95eac5f8c60ea19c68e4898719b58ccaa23e3e",
  "senderPubkey": "a10260a2aa2f092d85e2c0b82e95eac5f8c60ea19c68e4898719b58ccaa23e3e",
  "name": "reed@getalby.com",
  "value_msat": 37000,
  "value_msat_total": 111000,
  "ts": 1788410272
}
```

Which fields each reader actually uses:

| Field | Helipad | LB bots |
|---|---|---|
| `action` | `boost` or `stream` | must be `boost` |
| `podcast` | displayed | feed gate: must be exactly `Local Bitcoiners` if present |
| `feedID` / `feedId` / `feed_id` | | feed gate: `7683299` if present |
| `url` | | feed gate: the Fountain feed URL if present |
| `guid` / `feedGuid` / `podcastGuid` | | feed gate: `56fbb1aa-…` if present |
| `episode` | displayed | episode title; placeholder values (`0`, `undefined`, …) are treated as absent |
| `episode_guid` / `item_guid` (either case) | | ties the boost to the episode; strongly recommended |
| `boost_link` / `boostLink` | | optional episode URL |
| `message` | displayed | the note text |
| `sender_name` / `senderName` | displayed | display name |
| `senderPubkey` / `sender_pub_key` / `pubkey` (hex) | | credits the sender's npub on the site. `sender_id` alone is **not** read for this |
| `value_msat` | this leg | |
| `value_msat_total` / `valueMsatTotal` | headline amount | headline amount (full boost, all recipients). Keysend carries no split divisor, so send it |
| `remote_feed_guid` / `remote_item_guid` | resolved via Podcast Index for value-time splits | |

Missing feed-identity fields abstain; a present field that names a
*different* feed rejects the boost. Send `podcast`, `feedID`, `guid` and `url`
and it will always pass.

Encode the JSON as UTF-8 bytes in the TLV. Keep it under LND's custom-record
size comfort zone (a few hundred bytes is fine; a message of a few sentences
is fine).

### Variant: BOLT11 invoice + TLV custom records

Helipad's own sender pays LNURL-pay invoices *and* attaches TLV `7629169` as
custom records on the payment. Helipad reads those records off the settled
invoice's HTLC, so this shows up as a full boost too. It only works if the
sending node can attach custom records to an invoice payment (LND `SendPaymentV2`
`dest_custom_records` can; NWC `pay_invoice` cannot). The LB bots have not been
tested with this variant. Treat it as a bonus, not a plan.

## Path B: lightning address with RSS Payment metadata

This is what Fountain, Castamatic and BoostMeBitch/Tardbox do, and it works
with any wallet that can pay an invoice. The payment is a normal LNURL-pay to
the recipient's lightning address; the boost metadata is hosted at a URL and
referenced from the invoice comment.

### 1. The comment

```
rss::payment::boost https://castamatic.com/boost/AD7A6B29-F07E-4709-85DC-452D65EF682B Split test
```

- Literal `rss::payment::` then the action (`boost` or `stream`), a space, the
  metadata URL, then optionally a space and the message.
- The URL must be `https://` and contain no whitespace. Helipad reads up to
  the first whitespace. The LB bots strip a trailing `?payment=<id>` from the
  URL (Fountain's shape) and treat everything after the URL as the message.
- Watch `commentAllowed` on the LNURL-pay response. reed@getalby.com allows
  255 characters; the URL plus message must fit, so use short ids (Fountain
  uses a 20-character id, Tardbox a 26-character ULID).
- The LNURL service must put the comment into the invoice description so it
  reaches the payee's node as the memo. getalby.com does (verified on the LB
  node); check any other provider before relying on it.

### 2. The metadata URL

Helipad sends `HEAD <url>` (User-Agent `Helipad/<version>`) and reads the
`x-rss-payment` response header: URL-encoded JSON. Retry once after 10 s, so
the record must exist before the payment settles, or within seconds after.

Helipad reads these keys: `action`, `app_name`, `feed_title`, `item_title`,
`message`, `sender_name`, `value_msat_total`, `remote_feed_guid`,
`remote_item_guid`. Fountain and Castamatic also send `feed_guid`, `item_guid`,
`sender_npub`, `split`, `value_msat`, `recipient_address`, `timestamp`,
`group`; send them too, because other readers use them. A live Castamatic
record, decoded:

```json
{
  "action": "boost",
  "app_name": "Castamatic",
  "app_version": "13.2.0",
  "feed_guid": "7c6f7875-2b73-491e-b32c-e2c8d6e91d53",
  "feed_title": "Chad and Reeds Podcast",
  "item_guid": "2c0b0505-89d6-4384-8c51-8334efe6bfde",
  "item_title": "003. Dimly LIT",
  "message": "Split test",
  "sender_name": "ChadF",
  "recipient_address": "reed@getalby.com",
  "recipient_name": "Reed",
  "split": 33,
  "value_msat": 3000,
  "value_msat_total": 333000,
  "group": "425F3578-B3B0-4ACB-94D3-6EC0275D9A32",
  "position": 5645,
  "timestamp": "2026-08-28T11:31:37.582Z",
  "remote_feed_guid": "04e812f9-1993-5aa1-9ab5-a9cf0cd81e82",
  "remote_item_guid": "22910b47-bfe6-4ac4-a771-d73569dac524"
}
```

`group` is one id shared by every leg of the same boost, so a reader can
reassemble the whole payment from the legs it received. `value_msat` is this
leg, `value_msat_total` the whole boost. Tardbox adds `sender_id` (hex pubkey),
`sender_npub` and `boost_link`.

### 3. The domain gate

Helipad only fetches metadata for `fountain.fm`, `castamatic.com`,
`tardbox.com`, plus whatever the podcaster typed into *General settings →
Additional metadata domains*. A new app hosting records on its own domain
therefore needs every podcaster to add that domain, or a Helipad pull request
adding it to the built-in list. Until then the boost shows up as a generic
"Lightning Invoice" with the raw comment as its message.

The Local Bitcoiners bots are stricter: they read metadata only from
`fountain.fm` (episode page plus the Fountain comments API), `castamatic.com`
(the JSON at the URL) and `tardbox.com/boost/` (the HTML boost page). Any
other host runs the Fountain code path and produces a sparse boost with no
sender, message or episode.

Tardbox is BoostMeBitch's boost-page service. Whether it accepts records from
other apps is a question for its maintainer, not something this document can
promise.

## Feed identity for Local Bitcoiners

Use these exact values wherever a field asks for them.

| | |
|---|---|
| Podcast title | `Local Bitcoiners` |
| Podcast guid | `56fbb1aa-da79-5e4b-bebc-3b934ab8914c` |
| Podcast Index feed id | `7683299` |
| Feed URL | `https://feeds.fountain.fm/uv4pyDVtNAiiCCx5emOU` |
| Episode guid | the `<guid>` of the RSS item, e.g. `12649a7e-ad7e-4db6-a384-56900442ab6c` for Ep. 027 |

The value block is lightning-address only:

```xml
<podcast:value type="lightning" method="lnaddress">
  <podcast:valueRecipient name="reed@getalby.com" split="33" type="lnaddress" address="reed@getalby.com"/>
  <podcast:valueRecipient name="revhodl@minibits.cash" split="33" type="lnaddress" address="revhodl@minibits.cash"/>
  <podcast:valueRecipient name="aquafox30@primal.net" split="32" type="lnaddress" address="aquafox30@primal.net"/>
  <podcast:valueRecipient name="Fountain" split="2" type="lnaddress" address="boostbot@fountain.fm"/>
</podcast:value>
```

Episodes override this with guest splits; always read the item-level block
when there is one. Of the hosts, only `reed@getalby.com` exposes the keysend
well-known endpoint today, so a spec-following client ends up sending Path A
to Reed and Path B to the others. That is fine: each recipient's tooling only
ever sees its own leg.

## Testing

Send a small boost (a few sats per leg) with a distinctive message. On the
Local Bitcoiners side, Reed can confirm within minutes whether Helipad shows
it as a boost with podcast and episode filled in, and whether the bots'
dry-run classifier picks it up. A boost that arrives as "Lightning Invoice"
in Helipad, or that the bots log as unclassified, is on one of the
unsupported shapes above.
