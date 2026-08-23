/**
 * MyMeetupsModal — list the logged-in user's published NIP-52 calendar
 * events (31922/31923) with a one-click Boost button on each row.
 *
 * The lowest-friction path from "I have a meetup on Nostr" to "I just
 * boosted my meetup." No naddr typing, no searching — the user's own
 * events are fetched directly from relays via the shared NDK instance.
 *
 * Boost handoff routes through the parent-supplied callback (which calls
 * api.openShowBoost with a {naddr}-prefilled message) so the show-boost
 * modal's wallet/signer gates apply unchanged.
 */
import { BOOST_EXISTING_TEMPLATE, interpolateNaddr } from '../lib/eventAnnouncement.js'
import { useMyMeetups, formatMeetupWhen } from '../hooks/useMyMeetups.js'
import MeetupModalChrome from './MeetupModalChrome.jsx'

function splitFuturePast(events) {
  const now = Math.floor(Date.now() / 1000)
  const upcoming = []
  const past = []
  for (const p of events) {
    const cutoff = p.endUnix ?? p.startUnix
    if (cutoff >= now) upcoming.push(p)
    else past.push(p)
  }
  upcoming.sort((a, b) => a.startUnix - b.startUnix)
  past.sort((a, b) => b.startUnix - a.startUnix)
  return { upcoming, past }
}

export default function MyMeetupsModal({ user, onClose, onBoostMeetup, onRequestSignIn, embedded = false }) {
  const { events, error } = useMyMeetups(user?.pubkey)

  const handleBoost = (p) => {
    if (!p?.naddr) return
    const msg = interpolateNaddr(BOOST_EXISTING_TEMPLATE, p.naddr)
    onClose?.()
    onBoostMeetup?.(msg)
  }

  // Embedded (the /feeds "Find" modal drawer): body only — no modal chrome,
  // card, or heading (the accordion row already supplies the title/subtitle).
  if (embedded) {
    if (!user?.pubkey) {
      return (
        <div className="lb-embed-flow">
          <p className="lb-muted" style={{ margin: 0 }}>
            Sign in with Nostr to see and feature the meetups you’ve published.
          </p>
          <button onClick={() => onRequestSignIn?.()} className="lb-btn lb-btn-primary" style={{ marginTop: '0.7rem' }}>
            Sign in
          </button>
        </div>
      )
    }
    return (
      <div className="lb-embed-flow">
        {events === null && <LoadingRows />}
        {error && <div className="lb-error">{error}</div>}
        {events && events.length === 0 && !error && (
          <p style={{ color: 'var(--muted,#5a7488)', fontSize: '0.9rem', fontStyle: 'italic', margin: 0 }}>
            You haven’t published a meetup yet. Use “Create” to publish one.
          </p>
        )}
        {events && events.length > 0 && (
          <Sections events={events} onBoost={handleBoost} boostLabel="Feature" />
        )}
      </div>
    )
  }

  // Logged out → the modal still opens (no login bounce), but there's
  // nothing to list without an identity, so show a sign-in prompt rather
  // than a misleading "no meetups yet". A stub user has a pubkey, so this
  // only triggers when truly signed out.
  if (!user?.pubkey) {
    return (
      <MeetupModalChrome
        ariaLabel="Boost one of your meetups"
        onClose={onClose}
        maxWidth="34rem"
      >
        <div className="lb-card text-center">
          <h2 className="lb-card-heading">Your meetups on Nostr</h2>
          <p className="lb-muted" style={{ margin: '0.5rem 0 1.1rem' }}>
            Sign in with Nostr to see the meetups you’ve published and boost them.
          </p>
          <button onClick={() => onRequestSignIn?.()} className="lb-btn lb-btn-primary">
            Sign in
          </button>
        </div>
      </MeetupModalChrome>
    )
  }

  return (
    <MeetupModalChrome
      ariaLabel="Boost one of your meetups"
      onClose={onClose}
      maxWidth="34rem"
    >
      <div className="lb-card">
        <h2 className="lb-card-heading">Your meetups on Nostr</h2>
        <p className="lb-muted" style={{ marginTop: '0.25rem', marginBottom: '1rem' }}>
          Pick one to boost — your event’s naddr is included with the boost message.
        </p>

        {events === null && <LoadingRows />}

        {error && <div className="lb-error">{error}</div>}

        {events && events.length === 0 && !error && (
          <p style={{ color: 'var(--muted,#5a7488)', fontSize: '0.92rem', fontStyle: 'italic' }}>
            You haven’t published a meetup yet. Use “Create new” to publish one, or paste an naddr if it lives under a different npub.
          </p>
        )}

        {events && events.length > 0 && (
          <Sections events={events} onBoost={handleBoost} />
        )}
      </div>
    </MeetupModalChrome>
  )
}

function Sections({ events, onBoost, boostLabel = 'Boost' }) {
  const { upcoming, past } = splitFuturePast(events)
  return (
    <>
      {upcoming.length > 0 && (
        <Group label={`Upcoming (${upcoming.length})`}>
          {upcoming.map(p => <Row key={p.naddr || p.id} p={p} onBoost={onBoost} boostLabel={boostLabel} />)}
        </Group>
      )}
      {past.length > 0 && (
        <Group label={`Past (${past.length})`} faded>
          {past.map(p => <Row key={p.naddr || p.id} p={p} onBoost={onBoost} boostLabel={boostLabel} />)}
        </Group>
      )}
    </>
  )
}

function Group({ label, faded, children }) {
  return (
    <div style={{ marginTop: '0.5rem', opacity: faded ? 0.85 : 1 }}>
      <div style={{
        fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--muted,#5a7488)', fontWeight: 600,
        margin: '0.85rem 0 0.5rem',
      }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function Row({ p, onBoost, boostLabel = 'Boost' }) {
  return (
    <div className="lb-meetup-row">
      <div className="lb-meetup-row-body">
        <div className="lb-meetup-row-title">{p.title || 'Untitled meetup'}</div>
        <div className="lb-meetup-row-meta">
          {formatMeetupWhen(p)}{p.location ? ` · ${p.location}` : ''}
        </div>
      </div>
      <button type="button" className="lb-meetup-row-boost" onClick={() => onBoost(p)}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
        {boostLabel}
      </button>
    </div>
  )
}

function LoadingRows() {
  return (
    <div style={{ display: 'grid', gap: '0.55rem' }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="lb-skeleton" style={{ height: '54px' }} />
      ))}
    </div>
  )
}
