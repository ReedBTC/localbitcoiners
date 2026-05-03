// Re-export the nostr-tools surface the static HTML pages consume,
// so we can vendor a self-hosted bundle and stop pulling code from
// esm.sh at runtime. Loading third-party JS from a CDN with no SRI
// gave anyone who can MITM esm.sh full DOM access in our origin —
// session-token theft, fake boosts under the donor's npub, etc.
//
// Vite emits this as `assets/widgets/nostr-tools.js` (ESM). The
// only consumer today is boosts.html (`SimplePool`, `nip19`,
// `verifyEvent`); add new exports here when a page needs more.

export { SimplePool } from 'nostr-tools/pool'
export { verifyEvent } from 'nostr-tools/pure'
export * as nip19 from 'nostr-tools/nip19'
