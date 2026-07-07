import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCreateTrip, useTrips } from '../api/hooks'
import type { TripCreate } from '../api/types'
import { formatDate, formatMoney, todayISO } from '../utils'

const blankTrip = (): TripCreate => ({
  name: '',
  destination: '',
  start_date: todayISO(),
  end_date: todayISO(),
  base_currency: 'USD',
  total_budget: 0,
})

function NewTripForm({ onDone }: { onDone: () => void }) {
  const createTrip = useCreateTrip()
  const [form, setForm] = useState<TripCreate>(blankTrip())
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof TripCreate>(key: K, value: TripCreate[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = () => {
    setError(null)
    createTrip.mutate(form, {
      onSuccess: onDone,
      onError: (e) => setError(e.message),
    })
  }

  return (
    <div className="card form-card">
      <h3 className="card-title">New trip</h3>
      <div className="form-grid">
        <label>
          Trip name
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Tokyo, Off the Clock"
          />
        </label>
        <label>
          Destination
          <input
            value={form.destination}
            onChange={(e) => set('destination', e.target.value)}
            placeholder="Tokyo, Japan"
          />
        </label>
        <label>
          Starts
          <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
        </label>
        <label>
          Ends
          <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
        </label>
        <label>
          Budget
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.total_budget}
            onChange={(e) => set('total_budget', Number(e.target.value))}
          />
        </label>
        <label>
          Currency
          <input
            value={form.base_currency}
            maxLength={3}
            onChange={(e) => set('base_currency', e.target.value.toUpperCase())}
          />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!form.name || !form.destination || createTrip.isPending}
          onClick={submit}
        >
          Create trip
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function TripsPage() {
  const { data: trips, isLoading, error } = useTrips()
  const [showForm, setShowForm] = useState(false)

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow mono">Departures board</p>
          <h1>Your trips</h1>
        </div>
        <button type="button" className="btn primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : 'New trip'}
        </button>
      </div>

      {showForm && <NewTripForm onDone={() => setShowForm(false)} />}

      {isLoading && <p className="empty">Loading trips…</p>}
      {error && (
        <p className="form-error">
          Can't reach the API ({(error as Error).message}). Is the backend running on port 8000?
        </p>
      )}

      {trips && trips.length === 0 && !showForm && (
        <div className="card empty-card">
          <h3>No trips yet</h3>
          <p>Create the first one, or seed the Tokyo demo: <code>python -m app.seed</code></p>
        </div>
      )}

      <div className="trip-grid">
        {trips?.map((trip) => (
          <Link key={trip.id} to={`/trips/${trip.id}`} className="card trip-card">
            <p className="eyebrow mono">{trip.destination}</p>
            <h3>{trip.name}</h3>
            <p className="trip-dates mono">
              {formatDate(trip.start_date)} → {formatDate(trip.end_date)}
            </p>
            <p className="trip-budget mono">
              budget {formatMoney(trip.total_budget, trip.base_currency)}
            </p>
          </Link>
        ))}
      </div>
    </>
  )
}
