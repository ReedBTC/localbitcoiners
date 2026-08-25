// ⚠️ BUILD ARTIFACT SOURCE, FOR THE EDGE — not for the browser.
//
// The Pages Functions have no npm dependencies and this repo has no root
// package.json: every Function imports relative paths only, which is what
// keeps "no build step for the site itself" true. Signing a Nostr event
// needs a schnorr implementation, and WebCrypto has no secp256k1, so the
// one dependency the edge needs is vendored the same way
// `assets/widgets/nostr-tools.js` already vendors the browser's copy.
//
// Vite emits this as `functions/_shared/nostr-sign.js`. It is imported by
// `functions/api/sign-boost.js` and by nothing else. `scripts/stamp-assets.js`
// leaves it alone: its relative-import rule runs only inside `assets/js`.
//
// The surface is deliberately three functions. `finalizeEvent` is the reviewed
// implementation of serialize → sha256 → schnorr, and hand-writing that
// serialization to save a few kilobytes would put the one part that must be
// exactly right into code nobody has reviewed. `verifyEvent` is here so the
// endpoint's own test can check what it produced, and `nip19` so the key can
// be configured as an nsec as well as hex.
//
// Rebuild: cd login-widget && npm run build
export { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
export * as nip19 from 'nostr-tools/nip19'
