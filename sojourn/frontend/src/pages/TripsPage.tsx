import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useItinerary, useReminders, useSummary, useTrips } from '../api/hooks'
import type { Trip } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import DayStrip from '../components/DayStrip'
import TripForm from '../components/TripForm'
import { Icon, Skeleton } from '../components/ui'
import { formatInZone, zoneCity } from '../time'
import { usePageTitle } from '../usePageTitle'
import { dayNumber, formatMoney, formatRange, greeting, tripPhase } from '../utils'

const daysLabel = (t: Trip) => {
  const n = dayNumber(t.start_date, t.end_date)
  return `${n} day${n === 1 ? '' : 's'}`
}

/** The trip that matters most right now: the one happening, else the soonest. */
function pickNext(trips: Trip[]): Trip | undefined {
  const now = trips.filter((t) => tripPhase(t).kind === 'now')
  if (now.length) return now[0]
  return trips
    .filter((t) => tripPhase(t).kind === 'upcoming')
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0]
}

function NextUpCard({ trip }: { trip: Trip }) {
  const { data: items = [] } = useItinerary(trip.id)
  const { data: reminders = [] } = useReminders(trip.id)
  const { data: summary } = useSummary(trip.id)
  const phase = tripPhase(trip)

  const now = Date.now()
  const pending = reminders.filter((r) => r.status === 'pending')
  const due = pending.filter((r) => new Date(r.remind_at).getTime() <= now)
  const next = pending
    .filter((r) => new Date(r.remind_at).getTime() > now)
    .sort((a, b) => a.remind_at.localeCompare(b.remind_at))[0]

  const budget = trip.total_budget
  const spent = summary?.total_spent ?? 0
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0

  return (
    <Link to={`/trips/${trip.id}`} className="nextup">
      <div className="nextup-head">
        <div>
          <p className={`nextup-when phase-${phase.kind}`}>
            {phase.kind === 'now' ? `Happening now, ${phase.label.toLowerCase()}` : `Next up, ${phase.label.toLowerCase()}`}
          </p>
          <h2 className="nextup-title">{trip.name}</h2>
          <p className="nextup-sub">
            {trip.destination}, {formatRange(trip.start_date, trip.end_date)} ({daysLabel(trip)})
          </p>
        </div>
        <span className="nextup-open">
          Open trip <Icon name="back" size={14} />
        </span>
      </div>

      <DayStrip trip={trip} items={items} today={phase.today} />

      <dl className="nextup-facts">
        <div>
          <dt>
            <Icon name="bell" size={14} /> {due.length > 0 ? 'Due now' : 'Next reminder'}
          </dt>
          <dd>
            {due.length > 0 ? (
              <span className="tone-warn">
                {due[0].message}
                {due.length > 1 && ` and ${due.length - 1} more`}
              </span>
            ) : next ? (
              <>
                {next.message}
                <span className="muted"> {formatInZone(next.remind_at, next.effective_timezone)}</span>
              </>
            ) : (
              <span className="muted">None set</span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="route" size={14} /> Planned
          </dt>
          <dd>
            {items.length} stop{items.length === 1 ? '' : 's'}
            <span className="muted"> on {new Set(items.map((i) => i.date)).size} of {dayNumber(trip.start_date, trip.end_date)} days</span>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="wallet" size={14} /> Budget
          </dt>
          <dd>
            {budget > 0 ? (
              <>
                {formatMoney(spent, trip.base_currency)} <span className="muted">of {formatMoney(budget, trip.base_currency)}</span>
                <span className="mini-track" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} className={spent > budget ? 'over' : pct > 80 ? 'warn' : ''} />
                </span>
              </>
            ) : (
              <span className="muted">No budget set</span>
            )}
          </dd>
        </div>
      </dl>
    </Link>
  )
}

function TripCard({ trip }: { trip: Trip }) {
  const phase = tripPhase(trip)
  return (
    <Link to={`/trips/${trip.id}`} className={`trip-card phase-${phase.kind}`}>
      <p className="trip-when">{phase.label}</p>
      <h3>{trip.name}</h3>
      <p className="trip-card-dest">{trip.destination}</p>
      <div className="trip-card-foot">
        <span>
          {formatRange(trip.start_date, trip.end_date)}
          <span className="muted">, {daysLabel(trip)}</span>
        </span>
        {trip.total_budget > 0 && <span className="muted">{formatMoney(trip.total_budget, trip.base_currency)}</span>}
      </div>
    </Link>
  )
}

function Group({ title, trips }: { title: string; trips: Trip[] }) {
  if (trips.length === 0) return null
  return (
    <section className="trip-group">
      <h2 className="section-title">
        {title}
        <span className="count">{trips.length}</span>
      </h2>
      <div className="trip-grid">
        {trips.map((t) => (
          <TripCard key={t.id} trip={t} />
        ))}
      </div>
    </section>
  )
}

export default function TripsPage() {
  const { user } = useAuth()
  const { data: trips, isLoading, error } = useTrips()
  const [showForm, setShowForm] = useState(false)
  usePageTitle('Trips')

  const firstName = (user?.display_name || '').split(' ')[0]
  const next = trips ? pickNext(trips) : undefined
  const rest = (trips ?? []).filter((t) => t.id !== next?.id)
  const byPhase = (kind: 'now' | 'upcoming' | 'past') => rest.filter((t) => tripPhase(t).kind === kind)
  const past = byPhase('past').sort((a, b) => b.start_date.localeCompare(a.start_date))

  return (
    <>
      <div className="page-head home-head">
        <div>
          <h1>{firstName ? `${greeting()}, ${firstName}` : 'Trips'}</h1>
          {trips && trips.length > 0 && (
            <p className="page-sub">
              {next
                ? tripPhase(next).kind === 'now'
                  ? `You're in ${zoneCity(next.timezone)} right now.`
                  : `${next.name} starts ${tripPhase(next).label.toLowerCase()}.`
                : 'No trips coming up. Time to plan one?'}
            </p>
          )}
        </div>
        {!showForm && trips && trips.length > 0 && (
          <button type="button" className="btn primary" onClick={() => setShowForm(true)}>
            <Icon name="plus" size={15} />
            New trip
          </button>
        )}
      </div>

      {showForm && <TripForm onClose={() => setShowForm(false)} />}

      {isLoading && (
        <div className="nextup is-loading" aria-label="Loading trips">
          <Skeleton width={120} height={13} />
          <Skeleton width="45%" height={30} style={{ marginTop: 12 }} />
          <Skeleton width="30%" height={15} style={{ marginTop: 10 }} />
          <Skeleton width="100%" height={56} style={{ marginTop: 24 }} radius={8} />
        </div>
      )}
      {error && (
        <p className="form-error">
          Couldn't load your trips: {(error as Error).message}. Check that the API is running on port 8000.
        </p>
      )}

      {trips && trips.length === 0 && !showForm && (
        <div className="empty-state welcome">
          <h2>Plan your first trip</h2>
          <ol className="welcome-steps">
            <li>
              <strong>Add the trip.</strong> A destination and dates; the time zone fills itself in.
            </li>
            <li>
              <strong>Fill in the days.</strong> Flights, check-ins and plans, each on the route.
            </li>
            <li>
              <strong>Track the money and the moments.</strong> Expenses against a budget, and reminders that reach
              you even with the app closed.
            </li>
          </ol>
          <button type="button" className="btn primary" onClick={() => setShowForm(true)}>
            <Icon name="plus" size={15} />
            New trip
          </button>
        </div>
      )}

      {next && <NextUpCard trip={next} />}
      <Group title="Happening now" trips={byPhase('now')} />
      <Group title={next ? 'Also coming up' : 'Upcoming'} trips={byPhase('upcoming').sort((a, b) => a.start_date.localeCompare(b.start_date))} />
      <Group title="Past trips" trips={past} />
    </>
  )
}
