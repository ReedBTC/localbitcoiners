/**
 * Tracks user objects that are "stubs" — built from the localStorage
 * profile cache rather than a real NDKUser with a signer attached.
 *
 * Membership is tracked via a WeakSet so we don't have to attach an
 * enumerable property like __isStub to the user object itself, which
 * would leak through React spread props or warn the user about an
 * unknown DOM attribute.
 *
 * Lives in its own file (rather than inside index.jsx) so consumers
 * like BoostModal can read isStubUser without creating a circular
 * import back to the widget entry.
 */

const stubUsers = new WeakSet()

/** Mark a user object as a stub. Returns the same object for chaining. */
export function markStubUser(u) {
  if (u && typeof u === 'object') stubUsers.add(u)
  return u
}

/** True when `u` is a stub (cache-built, no live signer). False for
 *  null / a real NDKUser / undefined. Safe to call with anything. */
export function isStubUser(u) {
  return !!u && typeof u === 'object' && stubUsers.has(u)
}
