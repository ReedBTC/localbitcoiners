import { isSafeUrl } from '../lib/utils.js'

/**
 * Reusable avatar — image when available, colored initial-circle fallback
 * when not. Optional walletDot renders a small green dot in the bottom-
 * right to signal "Lightning wallet connected" at a glance.
 *
 * Falls back gracefully through three layers of degradation:
 *   1. profile.image present + safe URL → render <img>
 *   2. display name available → first letter on a deterministic colored bg
 *   3. nothing → '?' on neutral bg
 */

// Pick a stable hue from the npub so the same user always gets the same
// fallback color. Doesn't need to be cryptographic — just a quick hash.
function hueFromNpub(npub) {
  if (!npub) return 30  // orange-ish default
  let h = 0
  for (let i = 0; i < npub.length; i++) {
    h = (h * 31 + npub.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

export default function AvatarPill({
  profile,
  npub,
  size = 28,        // diameter in px
  walletDot = false,
}) {
  const sizePx = `${size}px`
  const dotSize = Math.max(8, Math.round(size * 0.32))
  const imgSrc = profile?.image
  const showImg = imgSrc && isSafeUrl(imgSrc)
  const displayName = profile?.displayName || profile?.name || ''
  const initial = displayName.trim().charAt(0).toUpperCase() || '?'
  const hue = hueFromNpub(npub)
  const bgColor = `hsl(${hue}, 50%, 35%)`

  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full overflow-visible flex-shrink-0"
      style={{ width: sizePx, height: sizePx }}
    >
      {showImg ? (
        <img
          src={imgSrc}
          alt=""
          className="w-full h-full rounded-full object-cover"
          onError={(e) => { e.target.style.display = 'none' }}
        />
      ) : (
        <span
          className="w-full h-full rounded-full flex items-center justify-center text-white font-semibold select-none"
          style={{
            backgroundColor: bgColor,
            fontSize: `${Math.max(10, Math.round(size * 0.42))}px`,
          }}
          aria-hidden="true"
        >
          {initial}
        </span>
      )}
      {walletDot && (
        <span
          className="absolute bg-green-500 border-2 border-neutral-900 rounded-full"
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            right: `-${Math.round(dotSize * 0.15)}px`,
            bottom: `-${Math.round(dotSize * 0.15)}px`,
          }}
          aria-label="Lightning wallet connected"
          title="Lightning wallet connected"
        />
      )}
    </span>
  )
}
