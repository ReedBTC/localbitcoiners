/**
 * Self-encrypt / self-decrypt arbitrary strings using whatever signer the
 * current NDK session has. Used to protect the NWC connection URI at rest:
 * we encrypt it *to ourselves* before writing to localStorage, so the
 * stored ciphertext is useless without the user's signer.
 *
 * Works across every login method the widget supports (NIP-07 extension,
 * raw nsec via NDKPrivateKeySigner, NIP-46 bunker via Nip46BunkerSigner).
 * All of them implement the NDKSigner ABI:
 *   signer.encrypt(recipientUser, plaintext, 'nip44'|'nip04')
 *   signer.decrypt(senderUser, ciphertext, 'nip44'|'nip04')
 *
 * Recipient is the user themselves — encrypt(self, ...) for both sides.
 *
 * Tries NIP-44 first (modern, authenticated). Falls back to NIP-04 on
 * signers that don't expose NIP-44 (rare in 2026 but still seen on older
 * extensions and some bunker apps). Both produce ciphertext-with-iv as
 * a single base64-ish string we can shove in localStorage.
 *
 * The schema marker ('44:'/'04:') is prepended so decrypt can pick the
 * right scheme without trial-and-error round-trips through the signer.
 */

const NIP44_PREFIX = '44:'
const NIP04_PREFIX = '04:'

/**
 * Check whether a signer supports the requested encryption scheme.
 * NDK exposes encryptionEnabled() but it's optional in the ABI; treat
 * "method missing" as "yes both" for backwards compat. The NIP-46 wrapper
 * in this codebase always returns ['nip04','nip44'] which is correct.
 */
async function supports(signer, scheme) {
  try {
    if (typeof signer.encryptionEnabled !== 'function') return true
    const list = await signer.encryptionEnabled(scheme)
    if (Array.isArray(list)) return list.includes(scheme)
    return true
  } catch {
    return true
  }
}

/**
 * Encrypt `plaintext` to `selfUser` using the given signer.
 * Returns a string with a scheme prefix so decrypt knows what to use.
 *
 * Throws if both NIP-44 and NIP-04 fail. Caller should treat that as a
 * fatal NWC-connect failure and surface to the user.
 */
export async function encryptForSelf(signer, selfUser, plaintext) {
  if (!signer) throw new Error('No signer available for encryption')
  if (!selfUser) throw new Error('No self-user available for encryption')

  if (await supports(signer, 'nip44')) {
    try {
      const ct = await signer.encrypt(selfUser, plaintext, 'nip44')
      return NIP44_PREFIX + ct
    } catch {
      // fall through to nip04
    }
  }

  // NIP-04 fallback. Older signers, or rare cases where NIP-44 errored.
  const ct = await signer.encrypt(selfUser, plaintext, 'nip04')
  return NIP04_PREFIX + ct
}

/**
 * Decrypt a string produced by encryptForSelf. Reads the scheme prefix
 * and dispatches to NIP-44 or NIP-04 on the signer.
 *
 * Throws on malformed input, scheme mismatch, or signer rejection. Most
 * common failure: user logged in as a different npub than the one the
 * ciphertext was encrypted to — caller catches and prompts re-connect.
 */
export async function decryptFromSelf(signer, selfUser, ciphertext) {
  if (!signer) throw new Error('No signer available for decryption')
  if (!selfUser) throw new Error('No self-user available for decryption')
  if (typeof ciphertext !== 'string' || ciphertext.length < 4) {
    throw new Error('Ciphertext is empty or malformed')
  }

  if (ciphertext.startsWith(NIP44_PREFIX)) {
    return signer.decrypt(selfUser, ciphertext.slice(NIP44_PREFIX.length), 'nip44')
  }
  if (ciphertext.startsWith(NIP04_PREFIX)) {
    return signer.decrypt(selfUser, ciphertext.slice(NIP04_PREFIX.length), 'nip04')
  }
  throw new Error('Ciphertext missing scheme prefix')
}
