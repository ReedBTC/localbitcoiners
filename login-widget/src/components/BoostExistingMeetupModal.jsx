/**
 * BoostExistingMeetupModal — modal wrapper around <BoostExistingEvent>.
 *
 * Opened from the meetups page's "Paste naddr" entry point. The body
 * is the exact same cream card used previously on /newevent; only the
 * mounting surface changed. Boost handoff still routes through
 * api.openShowBoost via the onOpenShowBoostWithMessage prop.
 */
import MeetupModalChrome from './MeetupModalChrome.jsx'
import BoostExistingEvent from './BoostExistingEvent.jsx'

export default function BoostExistingMeetupModal({
  user,
  onClose,
  onRequestSignIn,
  onOpenShowBoostWithMessage,
}) {
  return (
    <MeetupModalChrome
      ariaLabel="Boost a meetup by its naddr or external URL"
      onClose={onClose}
      maxWidth="34rem"
    >
      <BoostExistingEvent
        sessionUser={user}
        onRequestSignIn={() => { onClose?.(); onRequestSignIn?.() }}
        onOpenShowBoostWithMessage={(msg, naddr) => { onClose?.(); onOpenShowBoostWithMessage?.(msg, naddr) }}
      />
    </MeetupModalChrome>
  )
}
