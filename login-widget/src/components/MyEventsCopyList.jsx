/**
 * MyEventsCopyList — lists the logged-in user's published meetups inside
 * the composer's "Import / Export Options" disclosure. Each tight row
 * (title + date only) has an orange "Copy" button that seeds the composer
 * form from that event — the same end state as pasting its naddr, minus
 * the trip to another app to look the naddr up.
 *
 * Fetching is lazy: `enabled` is wired to the disclosure's open state so
 * the relay round-trip only happens once the user expands it.
 */
import { useMyMeetups, formatMeetupWhen } from '../hooks/useMyMeetups.js'

export default function MyEventsCopyList({ pubkey, enabled, onCopy, manageUrl }) {
  const { events, error } = useMyMeetups(pubkey, enabled)

  // Nothing to show until the disclosure is opened.
  if (!enabled) return null

  // Logged out → there's no npub to pull past meetups from. Say so plainly
  // instead of letting useMyMeetups report an empty list as "none published".
  // The JSON upload and naddr-paste imports above still work logged out.
  if (!pubkey) {
    return (
      <div style={{ borderTop: '1px solid var(--border,#cfe2ee)', paddingTop: '0.7rem', marginTop: '0.2rem' }}>
        <p style={{ color: 'var(--muted,#5a7488)', fontSize: '0.82rem', fontStyle: 'italic', margin: 0 }}>
          Sign in to import from meetups you’ve already published.
        </p>
      </div>
    )
  }

  const sorted = events
    ? [...events].sort((a, b) => (b.startUnix || 0) - (a.startUnix || 0))
    : null

  return (
    <div style={{ borderTop: '1px solid var(--border,#cfe2ee)', paddingTop: '0.7rem', marginTop: '0.2rem' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: '0.5rem', marginBottom: '0.5rem',
      }}>
        <span style={{
          fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
          color: 'var(--muted,#5a7488)', fontWeight: 600,
        }}>
          Import from your meetups
        </span>
        {manageUrl && (
          <a
            href={manageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--orange,#00aff0)', fontSize: '0.78rem', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}
            onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
            onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
          >
            Manage your events ↗
          </a>
        )}
      </div>

      {sorted === null && !error && (
        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="lb-skeleton" style={{ height: '42px' }} />
          ))}
        </div>
      )}

      {error && <div className="lb-error">{error}</div>}

      {sorted && sorted.length === 0 && !error && (
        <p style={{ color: 'var(--muted,#5a7488)', fontSize: '0.82rem', fontStyle: 'italic', margin: 0 }}>
          No meetups published under your npub yet.
        </p>
      )}

      {sorted && sorted.length > 0 && (
        <div className="lb-myevents-list">
          {sorted.map(p => (
            <div key={p.naddr || p.id} className="lb-meetup-row lb-meetup-row--compact">
              <div className="lb-meetup-row-body">
                <div className="lb-meetup-row-title">{p.title || 'Untitled meetup'}</div>
                <div className="lb-meetup-row-meta">{formatMeetupWhen(p)}</div>
              </div>
              <button
                type="button"
                className="lb-meetup-row-copy"
                onClick={() => onCopy?.(p.raw)}
                title="Import this meetup into the form"
              >
                Import
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
