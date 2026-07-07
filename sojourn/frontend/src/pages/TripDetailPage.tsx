import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useDeleteTrip, useSummary, useTrip } from '../api/hooks'
import BudgetTab from '../components/BudgetTab'
import ItineraryTab from '../components/ItineraryTab'
import RemindersTab from '../components/RemindersTab'
import TripMap from '../components/TripMap'
import { formatDate, formatMoney } from '../utils'

type Tab = 'itinerary' | 'map' | 'budget' | 'reminders'
const TABS: { key: Tab; label: string }[] = [
  { key: 'itinerary', label: 'Itinerary' },
  { key: 'map', label: 'Map' },
  { key: 'budget', label: 'Budget' },
  { key: 'reminders', label: 'Reminders' },
]

export default function TripDetailPage() {
  const { tripId } = useParams()
  const id = Number(tripId)
  const navigate = useNavigate()

  const { data: trip, isLoading, error } = useTrip(id)
  const { data: summary } = useSummary(id)
  const deleteTrip = useDeleteTrip()
  const [tab, setTab] = useState<Tab>('itinerary')

  if (isLoading) return <p className="empty">Loading trip…</p>
  if (error || !trip)
    return (
      <p className="form-error">
        Trip not found. <Link to="/">Back to trips</Link>
      </p>
    )

  const budget = trip.total_budget
  const spent = summary?.total_spent ?? 0
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0
  const over = budget > 0 && spent > budget
  const warn = budget > 0 && !over && spent / budget > 0.8

  const removeTrip = () => {
    if (!window.confirm(`Delete "${trip.name}" and everything in it?`)) return
    deleteTrip.mutate(trip.id, { onSuccess: () => navigate('/') })
  }

  return (
    <>
      <Link to="/" className="back-link mono">
        ← Trips
      </Link>

      <div className="trip-head">
        <div>
          <h1>{trip.name}</h1>
          <p className="trip-sub mono">
            {trip.destination} · {formatDate(trip.start_date)} → {formatDate(trip.end_date)}
          </p>
        </div>
        <button type="button" className="btn ghost danger" onClick={removeTrip}>
          Delete trip
        </button>
      </div>

      {budget > 0 && (
        <div className="budget-track-wrap">
          <div className="budget-labels mono">
            <span>Spent {formatMoney(spent, trip.base_currency)}</span>
            <span>Budget {formatMoney(budget, trip.base_currency)}</span>
          </div>
          <div
            className="budget-track"
            role="progressbar"
            aria-label="Budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
          >
            <div
              className={`budget-fill${over ? ' over' : warn ? ' warn' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

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
          </button>
        ))}
      </div>

      {tab === 'itinerary' && <ItineraryTab trip={trip} />}
      {tab === 'map' && <TripMap trip={trip} />}
      {tab === 'budget' && <BudgetTab trip={trip} />}
      {tab === 'reminders' && <RemindersTab trip={trip} />}
    </>
  )
}
