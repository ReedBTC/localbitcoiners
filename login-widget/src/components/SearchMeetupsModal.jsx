/**
 * SearchMeetupsModal — find a meetup on Nostr and boost it.
 *
 * Three input modes (detected from a single text field):
 *   • naddr / nevent / note  → resolve directly to that event
 *   • npub / nprofile        → fetch that author's NIP-52 events
 *   • free text              → Primal user_search → pick an author →
 *                              fetch that author's NIP-52 events
 *
 * Each resulting event row gets a one-click Boost button that hands
 * off to api.openShowBoost via the parent-supplied callback (same
 * pattern as MyMeetupsModal).
 *
 * Patterns lifted from mynostr's UserSearch + EventsDiscover; see the
 * repo at github.com/ReedBTC/mynostr.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait } from '../lib/ndk.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
} from '../lib/eventTypes.js'
import { BOOST_EXISTING_TEMPLATE, interpolateNaddr } from '../lib/eventAnnouncement.js'
import { searchAuthors } from '../lib/primalSearch.js'
import MeetupModalChrome from './MeetupModalChrome.jsx'

const DEBOUNCE_MS = 350

function classify(raw) {
  const s = String(raw || '').trim().replace(/^nostr:/i, '')
  if (!s) return { kind: 'empty' }
  const lower = s.toLowerCase()
  if (lower.startsWith('naddr1') || lower.startsWith('nevent1') || lower.startsWith('note1')) {
    try {
      const d = nip19.decode(s)
      if (d.type === 'naddr') return { kind: 'naddr', data: d.data, raw: s }
      if (d.type === 'nevent') return { kind: 'nevent', data: d.data, raw: s }
      if (d.type === 'note') return { kind: 'note', data: { id: d.data }, raw: s }
      return { kind: 'invalid' }
    } catch { return { kind: 'invalid' } }
  }
  if (lower.startsWith('npub1') || lower.startsWith('nprofile1')) {
    try {
      const d = nip19.decode(s)
      if (d.type === 'npub') return { kind: 'author', pubkey: d.data }
      if (d.type === 'nprofile') return { kind: 'author', pubkey: d.data.pubkey }
      return { kind: 'invalid' }
    } catch { return { kind: 'invalid' } }
  }
  return { kind: 'text', value: s }
}

function formatWhen(p) {
  if (!p || !Number.isFinite(p.startUnix)) return ''
  const ms = p.startUnix * 1000
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear()
  if (p.isDateBased) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      year: sameYear ? undefined : 'numeric',
      timeZone: 'UTC',
    }).format(new Date(ms))
  }
  const tz = p.startTzid || undefined
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    year: sameYear ? undefined : 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(new Date(ms))
}

async function fetchAuthorEvents(pubkey, signal) {
  if (!pubkey) return []
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})
  if (signal?.aborted) return []
  const set = await ndk.fetchEvents({
    kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
    authors: [pubkey],
    limit: 200,
  })
  const byCoord = new Map()
  for (const ev of set || []) {
    const d = ev.tags?.find(t => t[0] === 'd')?.[1]
    if (!d) continue
    const key = `${ev.kind}:${ev.pubkey}:${d}`
    const prev = byCoord.get(key)
    if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) byCoord.set(key, ev)
  }
  const parsed = []
  for (const ev of byCoord.values()) {
    const p = parseCalendarEvent({
      id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
      tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
    })
    if (p) parsed.push(p)
  }
  // Future first (asc), then past (desc by start).
  const now = Math.floor(Date.now() / 1000)
  const upcoming = parsed.filter(p => (p.endUnix ?? p.startUnix) >= now).sort((a, b) => a.startUnix - b.startUnix)
  const past = parsed.filter(p => (p.endUnix ?? p.startUnix) < now).sort((a, b) => b.startUnix - a.startUnix)
  return [...upcoming, ...past]
}

async function fetchByCoordinate({ kind, pubkey, identifier }) {
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})
  const set = await ndk.fetchEvents({
    kinds: [kind],
    authors: [pubkey],
    '#d': [identifier],
    limit: 5,
  })
  let latest = null
  for (const ev of set || []) {
    if (!latest || (ev.created_at || 0) > (latest.created_at || 0)) latest = ev
  }
  if (!latest) return []
  const p = parseCalendarEvent({
    id: latest.id, pubkey: latest.pubkey, kind: latest.kind,
    tags: latest.tags || [], content: latest.content || '', created_at: latest.created_at,
  })
  return p ? [p] : []
}

function formatFollowers(n) {
  if (n == null) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M followers`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k followers`
  return `${n} followers`
}

export default function SearchMeetupsModal({ onClose, onBoostMeetup, embedded = false }) {
  const [query, setQuery] = useState('')
  const [phase, setPhase] = useState('idle')  // idle | searching | authors | events | error
  const [authors, setAuthors] = useState([])
  const [events, setEvents] = useState([])
  const [selectedAuthor, setSelectedAuthor] = useState(null) // {pubkey, name, picture}
  const [errorMsg, setErrorMsg] = useState('')
  const debounceRef = useRef(null)
  const reqIdRef = useRef(0)
  const abortRef = useRef(null)

  const cls = useMemo(() => classify(query), [query])

  useEffect(() => () => {
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()
  }, [])

  // Reset derived state whenever the user edits the field. Each new
  // keystroke kicks off either a fresh debounce (text) or an immediate
  // resolve (bech32 prefixes).
  useEffect(() => {
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    setAuthors([]); setEvents([]); setSelectedAuthor(null); setErrorMsg('')

    if (cls.kind === 'empty') { setPhase('idle'); return }
    if (cls.kind === 'invalid') { setPhase('error'); setErrorMsg('That doesn’t look like a Nostr identifier.'); return }

    const reqId = ++reqIdRef.current
    const ac = new AbortController()
    abortRef.current = ac

    if (cls.kind === 'naddr') {
      setPhase('searching')
      ;(async () => {
        try {
          const list = await fetchByCoordinate({
            kind: cls.data.kind,
            pubkey: cls.data.pubkey,
            identifier: cls.data.identifier,
          })
          if (reqId !== reqIdRef.current) return
          if (list.length === 0) {
            setPhase('error'); setErrorMsg('Couldn’t find that event on the connected relays.')
          } else {
            setEvents(list); setPhase('events')
          }
        } catch {
          if (reqId !== reqIdRef.current) return
          setPhase('error'); setErrorMsg('Lookup failed. Please try again.')
        }
      })()
      return
    }

    if (cls.kind === 'author') {
      setPhase('searching')
      ;(async () => {
        try {
          const list = await fetchAuthorEvents(cls.pubkey, ac.signal)
          if (reqId !== reqIdRef.current) return
          if (list.length === 0) {
            setPhase('error'); setErrorMsg('That account hasn’t published any meetups (kind 31922 / 31923).')
          } else {
            setSelectedAuthor({ pubkey: cls.pubkey })
            setEvents(list); setPhase('events')
          }
        } catch {
          if (reqId !== reqIdRef.current) return
          setPhase('error'); setErrorMsg('Lookup failed. Please try again.')
        }
      })()
      return
    }

    if (cls.kind === 'text') {
      setPhase('searching')
      debounceRef.current = setTimeout(async () => {
        try {
          const list = await searchAuthors(cls.value, 8)
          if (reqId !== reqIdRef.current) return
          if (!list.length) {
            setPhase('error'); setErrorMsg('No matching accounts found.')
          } else {
            setAuthors(list); setPhase('authors')
          }
        } catch {
          if (reqId !== reqIdRef.current) return
          setPhase('error'); setErrorMsg('Search failed. Please try again.')
        }
      }, DEBOUNCE_MS)
      return
    }

    if (cls.kind === 'nevent' || cls.kind === 'note') {
      setPhase('error')
      setErrorMsg('Paste an naddr (calendar event address) instead — kind 31922/31923 events are addressable, not single notes.')
    }
  }, [cls])

  const pickAuthor = async (a) => {
    setSelectedAuthor(a)
    setPhase('searching')
    setEvents([])
    setErrorMsg('')
    const reqId = ++reqIdRef.current
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const list = await fetchAuthorEvents(a.pubkey, ac.signal)
      if (reqId !== reqIdRef.current) return
      if (list.length === 0) {
        setPhase('error'); setErrorMsg('This account hasn’t published any meetups yet.')
      } else {
        setEvents(list); setPhase('events')
      }
    } catch {
      if (reqId !== reqIdRef.current) return
      setPhase('error'); setErrorMsg('Lookup failed. Please try again.')
    }
  }

  const backToAuthors = () => {
    setSelectedAuthor(null)
    setEvents([])
    setPhase('authors')
  }

  const handleBoost = (p) => {
    if (!p?.naddr) return
    const msg = interpolateNaddr(BOOST_EXISTING_TEMPLATE, p.naddr)
    onClose?.()
    onBoostMeetup?.(msg)
  }

  const boostLabel = embedded ? 'Feature' : 'Boost'

  // Shared body — the search field + its result phases. Wrapped in modal chrome
  // for the /meetups path, or rendered bare inside the /feeds "Find" drawer.
  const body = (
    <>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Account name, npub1…, or naddr1…"
          className="lb-input"
          autoComplete="off"
          spellCheck="false"
          autoCapitalize="off"
          autoCorrect="off"
          style={{ fontFamily: 'inherit', fontSize: '0.92rem' }}
          autoFocus
        />

        {phase === 'idle' && (
          <p style={{ color: 'var(--muted,#5a7488)', fontSize: '0.85rem', marginTop: '0.85rem' }}>
            Start typing to find an organizer, or paste the event address (naddr1…).
          </p>
        )}

        {phase === 'searching' && (
          <div style={{ marginTop: '0.85rem', display: 'grid', gap: '0.5rem' }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="lb-skeleton" style={{ height: '46px' }} />
            ))}
          </div>
        )}

        {phase === 'error' && errorMsg && (
          <div className="lb-error" style={{ marginTop: '0.85rem' }}>{errorMsg}</div>
        )}

        {phase === 'authors' && authors.length > 0 && (
          <div style={{ marginTop: '0.85rem' }}>
            <div style={{
              fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--muted,#5a7488)', fontWeight: 600, marginBottom: '0.5rem',
            }}>
              Pick an account
            </div>
            {authors.map(a => (
              <button
                key={a.pubkey}
                type="button"
                className="lb-author-pick"
                onClick={() => pickAuthor(a)}
              >
                {a.picture
                  ? <img src={a.picture} alt="" loading="lazy" />
                  : <div className="lb-author-pick" style={{ padding: 0, width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--border,#cfe2ee)', background: 'var(--cream-d,#e2eef7)' }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lb-author-pick-name">{a.name || a.pubkey.slice(0, 12) + '…'}</div>
                  {a.followers != null && (
                    <div className="lb-author-pick-sub">{formatFollowers(a.followers)}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {phase === 'events' && events.length > 0 && (
          <div style={{ marginTop: '0.85rem' }}>
            {selectedAuthor && authors.length > 0 && (
              <button
                type="button"
                onClick={backToAuthors}
                style={{
                  background: 'none', border: 'none', color: 'var(--navy,#0b3a52)',
                  cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
                  padding: 0, marginBottom: '0.5rem', textDecoration: 'underline',
                }}
              >
                ← Pick a different account
              </button>
            )}
            <div style={{
              fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--muted,#5a7488)', fontWeight: 600, marginBottom: '0.5rem',
            }}>
              {events.length === 1 ? '1 meetup' : `${events.length} meetups`}
            </div>
            {events.map(p => (
              <div key={p.naddr || p.id} className="lb-meetup-row">
                <div className="lb-meetup-row-body">
                  <div className="lb-meetup-row-title">{p.title || 'Untitled meetup'}</div>
                  <div className="lb-meetup-row-meta">
                    {formatWhen(p)}{p.location ? ` · ${p.location}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="lb-meetup-row-boost"
                  onClick={() => handleBoost(p)}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
                  </svg>
                  {boostLabel}
                </button>
              </div>
            ))}
          </div>
        )}
    </>
  )

  if (embedded) return <div className="lb-embed-flow">{body}</div>

  return (
    <MeetupModalChrome
      ariaLabel="Search Nostr for a meetup to boost"
      onClose={onClose}
      maxWidth="34rem"
    >
      <div className="lb-card">
        <h2 className="lb-card-heading">Search Nostr for a meetup</h2>
        <p className="lb-muted" style={{ marginTop: '0.25rem', marginBottom: '1rem' }}>
          Search by account name, npub, or paste an naddr.
        </p>
        {body}
      </div>
    </MeetupModalChrome>
  )
}
