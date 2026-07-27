// Re-export the nostr-tools surface the static HTML pages consume,
// so we can vendor a self-hosted bundle and stop pulling code from
// esm.sh at runtime. Loading third-party JS from a CDN with no SRI
// gave anyone who can MITM esm.sh full DOM access in our origin —
// session-token theft, fake boosts under the donor's npub, etc.
//
// Vite emits this as `assets/widgets/nostr-tools.js` (ESM). Consumers:
// boosts.html (`SimplePool`, `nip19`, `verifyEvent`) and merch.js
// (adds `getEventHash` + `nip59` for NIP-17/Gamma gift-wrapped orders).
// Add new exports here when a page needs more.
//
// NOTE on gift-wrap: nip59.createWrap() builds the outer kind-1059 with
// its own ephemeral key, so merch.js uses it directly. The inner seal
// (kind 13) is NOT built here — it must be signed by the user's real
// signer (NIP-07/NIP-46/throwaway), which we only reach through
// LBLogin.getNDK().signer.encrypt() at runtime. getEventHash is exported
// so merch.js can compute the rumor id without a private key.

export { SimplePool } from 'nostr-tools/pool'
export { verifyEvent, getEventHash } from 'nostr-tools/pure'
export * as nip19 from 'nostr-tools/nip19'
export * as nip59 from 'nostr-tools/nip59'
