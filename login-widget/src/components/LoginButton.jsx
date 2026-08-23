/**
 * The site's one "log in" control, in two skins.
 *
 * ⚠️ IT SAYS NOTHING ABOUT NOSTR, AND THAT IS THE POINT. This may be someone's
 * first contact with it, and they do not need to know that is what it is —
 * they need to know that logging in fills their details in. The word is **Log
 * in**, the mark is the site's own favicon, and the machinery behind it is the
 * Nostr login modal exactly as before. Same rule as the "Your name" field and
 * the "Private Boost" checkbox: no nsec, no npub, no relays, no keys.
 *
 * ⚠️ TWO SKINS, ONE CONTROL, AND THEY MUST STAY RECOGNISABLY THE SAME BUTTON.
 * A visitor meets it in the nav and then again inside the boost modal, and if
 * those read as two different things the second one is a stranger asking for
 * an account at the moment they are about to spend money.
 *
 *   `nav`      on the navy bar. Translucent white, sized to sit beside Donate.
 *   `checkout` on a light modal surface. Brand-bordered and full width.
 *
 * The `checkout` skin is the express-checkout shape a shopper already knows: the
 * mark and the verb, nothing else. It is offered as an ALTERNATIVE to typing a
 * name, not as a gate in front of it — which is why it sits **on the same line
 * as the From field**, right-aligned past it, with a small "or" between. It had
 * a full-width divider above it first and that was worse than the text link it
 * replaced: a rule across the modal reads as a section break, so the two halves
 * of one choice looked like two unrelated things.
 *
 * ⚠️ IT DOES NOT SET ITS OWN WIDTH. The caller does, because it is inline here
 * and full-width elsewhere.
 *
 * `role` is a passthrough for the one caller that mounts this inside a
 * `role="menu"`: the identity dropdown's signed-out branch, where the offer has
 * to be a `menuitem` like every other row of that menu.
 */

const MARK = '/assets/favicon.png'

export default function LoginButton({ variant = 'nav', onClick, className = '', role }) {
  if (variant === 'checkout') {
    return (
      <button
        type="button"
        role={role}
        onClick={onClick}
        className={`inline-flex items-center justify-center gap-2 py-2.5 px-3.5 rounded-lg border-2 border-[var(--brand,#00aff0)] bg-[var(--modal-field,#ffffff)] text-[var(--brand-dd,#0a6fa8)] text-sm font-semibold whitespace-nowrap hover:bg-[var(--brand-tint,rgba(0,175,240,0.12))] focus:outline-none focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))] transition-colors ${className}`}
        aria-label="Log in to Local Bitcoiners"
      >
        {/* Decorative: the label already says what the button does, so the mark
            is not given alt text a screen reader would read as a second word. */}
        <img src={MARK} alt="" aria-hidden="true" width="18" height="18" className="w-[18px] h-[18px] rounded-full shrink-0" />
        <span>Log in</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium border border-white/20 bg-white/[0.08] hover:bg-white/[0.16] hover:border-white/[0.34] transition-colors ${className}`}
      style={{ color: '#f5eedc' }}
      aria-label="Log in to Local Bitcoiners"
    >
      <img src={MARK} alt="" aria-hidden="true" width="18" height="18" className="w-[18px] h-[18px] rounded-full shrink-0" />
      <span>Log in</span>
    </button>
  )
}
