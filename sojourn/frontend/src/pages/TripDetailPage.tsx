import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useDeleteTrip, useItinerary, useReminders, useSummary, useTrip } from '../api/hooks'
import BudgetTab from '../components/BudgetTab'
import ConfirmDialog from '../components/ConfirmDialog'
import DayStrip from '../components/DayStrip'
import ItineraryTab from '../components/ItineraryTab'
import RemindersTab from '../components/RemindersTab'
import TripForm from '../components/TripForm'
import TripMap from '../components/TripMap'
import { Icon, Skeleton, type IconName } from '../components/ui'
import { formatInZone, zoneAbbr, zoneCity } from '../time'
import { usePageTitle } from '../usePageTitle'
import { dayNumber, formatMoney, formatRange, tripPhase } from '../utils'

type Tab = 'itinerary' | 'map' | 'budget' | 'reminders'
const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'itinerary', label: 'Itinerary', icon: 'route' },
  { key: 'map', label: 'Map', icon: 'map' },
  { key: 'budget', label: 'Budget', icon: 'wallet' },
  { key: 'reminders', label: 'Reminders', icon: 'bell' },
]
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.key === v)

function TripSkeleton() {
  return (
    <div aria-label="Loading trip" role="status">
      <Skeleton width={70} height={14} />
      <Skeleton width="50%" height={40} style={{ marginTop: 28 }} />
      <Skeleton width="34%" height={16} style={{ marginTop: 14 }} />
      <Skeleton width="100%" height={64} radius={8} style={{ marginTop: 32 }} />
      <Skeleton width="100%" height={300} radius={8} style={{ marginTop: 32 }} />
    </div>
  )
}

export default function TripDetailPage() {
  const { tripId } = useParams()
  const id = Number(tripId)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const { data: trip, isLoading, error } = useTrip(id)
  const { data: summary } = useSummary(id)
  const { data: items = [] } = useItinerary(id)
  const { data: reminders = [] } = useReminders(id)
  const deleteTrip = useDeleteTrip()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Clicking a day in the strip: which day to scroll to (+ a counter so the same day can be re-picked).
  const [focus, setFocus] = useState<{ date: string; n: number } | null>(null)
  usePageTitle(trip?.name)

  // The tab lives in the URL (?tab=budget): refresh, back and shared links keep it.
  const tabParam = params.get('tab')
  const tab: Tab = isTab(tabParam) ? tabParam : 'itinerary'
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    if (t === 'itinerary') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }

  if (isLoading) return <TripSkeleton />
  if (error || !trip)
    return (
      <div className="empty-state">
        <h2>Trip not found</h2>
        <p>It may have been deleted, or the link is wrong.</p>
        <Link to="/" className="btn">
          Back to trips
        </Link>
      </div>
    )

  const phase = tripPhase(trip)
  const days = dayNumber(trip.start_date, trip.end_date)
  const budget = trip.total_budget
  const spent = summary?.total_spent ?? 0
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0

  const now = Date.now()
  const pending = reminders.filter((r) => r.status === 'pending')
  const due = pending.filter((r) => new Date(r.remind_at).getTime() <= now)
  const nextReminder = pending
    .filter((r) => new Date(r.remind_at).getTime() > now)
    .sort((a, b) => a.remind_at.localeCompare(b.remind_at))[0]
  const plannedDays = new Set(items.map((i) => i.date)).size

  const jumpToDay = (date: string) => {
    setTab('itinerary')
    setFocus((f) => ({ date, n: (f?.n ?? 0) + 1 }))
  }

  return (
    <div className="trip-page">
      <div className="back-row">
        <Link to="/" className="back-link">
          <Icon name="back" size={16} />
          Trips
        </Link>
        {!editing && (
          <div className="back-row-actions">
            <button type="button" className="btn-text" onClick={() => setEditing(true)}>
              Edit trip
            </button>
            <button type="button" className="btn-text danger" onClick={() => setConfirming(true)}>
              Delete trip
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <TripForm trip={trip} onClose={() => setEditing(false)} />
      ) : (
        <header className="trip-head">
          <p className={`phase-pill phase-${phase.kind}`}>{phase.label}</p>
          <h1>{trip.name}</h1>
          <p className="trip-sub">
            {trip.destination}, {formatRange(trip.start_date, trip.end_date)} ({days} day{days === 1 ? '' : 's'})
            <span className="trip-zone">
              {' '}
              {zoneCity(trip.timezone)} time, {zoneAbbr(trip.timezone)}
            </span>
          </p>
        </header>
      )}

      {/* At a glance: each fact opens the tab it summarizes. */}
      <div className="glance">
        <button type="button" className="glance-item" onClick={() => setTab('itinerary')}>
          <span className="glance-label">
            <Icon name="route" size={14} /> Plan
          </span>
          <span className="glance-value">
            {items.length} stop{items.length === 1 ? '' : 's'}
          </span>
          <span className="glance-note">
            {plannedDays} of {days} days planned
          </span>
        </button>
        <button type="button" className="glance-item" onClick={() => setTab('reminders')}>
          <span className="glance-label">
            <Icon name="bell" size={14} /> {due.length > 0 ? 'Due now' : 'Next reminder'}
          </span>
          {due.length > 0 ? (
            <span className="glance-value tone-warn">
              {due.length} reminder{due.length === 1 ? '' : 's'}
            </span>
          ) : nextReminder ? (
            <span className="glance-value glance-clip">{nextReminder.message}</span>
          ) : (
            <span className="glance-value muted">None set</span>
          )}
          <span className="glance-note">
            {due.length > 0
              ? due[0].message
              : nextReminder
                ? formatInZone(nextReminder.remind_at, nextReminder.effective_timezone)
                : 'Add one for check-in or a booking'}
          </span>
        </button>
        <button type="button" className="glance-item" onClick={() => setTab('budget')}>
          <span className="glance-label">
            <Icon name="wallet" size={14} /> Budget
          </span>
          {budget > 0 ? (
            <>
              <span className="glance-value">
                {formatMoney(spent, trip.base_currency)}
                <span className="muted glance-of"> of {formatMoney(budget, trip.base_currency)}</span>
              </span>
              <span
                className="mini-track"
                role="progressbar"
                aria-label="Budget used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                <span style={{ width: `${pct}%` }} className={spent > budget ? 'over' : pct > 80 ? 'warn' : ''} />
              </span>
            </>
          ) : (
            <>
              <span className="glance-value muted">No budget</span>
              <span className="glance-note">Set one with Edit trip</span>
            </>
          )}
        </button>
      </div>

      <DayStrip trip={trip} items={items} today={phase.kind === 'now' ? phase.today : undefined} onSelect={jumpToDay} />

      <div className="tabs" role="tablist" aria-label="Trip sections">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
            {key === 'reminders' && due.length > 0 && <span className="tab-badge">{due.length}</span>}
          </button>
        ))}
      </div>

      {tab === 'itinerary' && <ItineraryTab trip={trip} focus={focus} today={phase.kind === 'now' ? phase.today : undefined} />}
      {tab === 'map' && <TripMap trip={trip} />}
      {tab === 'budget' && <BudgetTab trip={trip} />}
      {tab === 'reminders' && <RemindersTab trip={trip} />}

      {/* Phones: the sections move to a bar at the bottom, within thumb reach. */}
      <nav className="bottom-nav" aria-label="Trip sections">
        {TABS.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'active' : ''}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              setTab(key)
              window.scrollTo({ top: 0 })
            }}
          >
            <span className="bn-icon">
              <Icon name={icon} size={20} />
              {key === 'reminders' && due.length > 0 && <span className="bn-badge">{due.length}</span>}
            </span>
            {label}
          </button>
        ))}
      </nav>

      <ConfirmDialog
        open={confirming}
        title={`Delete “${trip.name}”?`}
        confirmLabel="Delete trip"
        busy={deleteTrip.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => deleteTrip.mutate(trip.id, { onSuccess: () => navigate('/') })}
      >
        <p>
          This removes its {items.length} stop{items.length === 1 ? '' : 's'}, {reminders.length} reminder
          {reminders.length === 1 ? '' : 's'} and every expense. It can't be undone.
        </p>
      </ConfirmDialog>
    </div>
  )
}
