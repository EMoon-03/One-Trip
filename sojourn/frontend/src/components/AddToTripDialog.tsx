// "Add to trip": pick a trip, a day and (optionally) a time; the saved place
// becomes a stop with its coordinates, category and time zone filled in.
// Opened from a place card (trip choosable) or from a trip's "nearby"
// suggestions (trip fixed).

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAddSavedToTrip, useTrips } from '../api/hooks'
import type { SavedPlace, Trip } from '../api/types'
import { dayNumber, eachDate, formatDate, tripPhase } from '../utils'
import { useToast } from './Toast'

/** The day a new stop most likely belongs on: today if the trip is on, else day 1. */
const defaultDay = (trip: Trip) => {
  const phase = tripPhase(trip)
  return phase.kind === 'now' ? phase.today : trip.start_date
}

export default function AddToTripDialog({
  place,
  trip: fixedTrip,
  onClose,
}: {
  place: SavedPlace | null // null = closed
  trip?: Trip
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const { data: allTrips = [] } = useTrips()
  const add = useAddSavedToTrip()
  const { toast } = useToast()
  const navigate = useNavigate()

  // Trips still to come (or under way) first; finished ones can still take a
  // stop, for logging where you went, but they go last.
  const trips = useMemo(() => {
    const order = { now: 0, upcoming: 1, past: 2 } as const
    return [...allTrips].sort(
      (a, b) =>
        order[tripPhase(a).kind] - order[tripPhase(b).kind] ||
        (tripPhase(a).kind === 'past' ? b.start_date.localeCompare(a.start_date) : a.start_date.localeCompare(b.start_date)),
    )
  }, [allTrips])

  const [tripId, setTripId] = useState<number | null>(null)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState<string | null>(null)

  const trip = fixedTrip ?? trips.find((t) => t.id === tripId)

  // Reset whenever it opens for a (new) place.
  useEffect(() => {
    if (!place) return
    const first = fixedTrip ?? trips[0]
    setTripId(first?.id ?? null)
    setDate(first ? defaultDay(first) : '')
    setTime('')
    setError(null)
  }, [place?.id])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (place && !d.open) d.showModal()
    if (!place && d.open) d.close()
  }, [place])

  const pickTrip = (id: number) => {
    setTripId(id)
    const t = trips.find((x) => x.id === id)
    if (t) setDate(defaultDay(t))
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!place || !trip || !date) return
    setError(null)
    add.mutate(
      { id: place.id, body: { trip_id: trip.id, date, start_time: time || null } },
      {
        onSuccess: () => {
          onClose()
          toast({
            message: `Added “${place.name}” to ${trip.name}, day ${dayNumber(trip.start_date, date)}`,
            action: fixedTrip ? undefined : { label: 'Open trip', onClick: () => navigate(`/trips/${trip.id}`) },
          })
        },
        onError: (err) => setError((err as Error).message),
      },
    )
  }

  return (
    <dialog
      ref={ref}
      className="dialog add-to-trip"
      aria-labelledby="att-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {place && (
        <form onSubmit={submit}>
          <h2 id="att-title" className="dialog-title">
            Add “{place.name}” to a trip
          </h2>

          {trips.length === 0 && !fixedTrip ? (
            <>
              <p className="dialog-body">You don't have a trip yet. Make one, then come back to fill it in.</p>
              <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose}>
                  Close
                </button>
                <Link to="/" className="btn primary" onClick={onClose}>
                  Plan a trip
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="dialog-fields">
                {!fixedTrip && (
                  <label className="field">
                    Trip
                    <select value={tripId ?? ''} onChange={(e) => pickTrip(Number(e.target.value))}>
                      {trips.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {tripPhase(t).kind === 'past' ? ' (finished)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {trip && (
                  <div className="dialog-row">
                    <label className="field">
                      Day
                      <select value={date} onChange={(e) => setDate(e.target.value)}>
                        {eachDate(trip.start_date, trip.end_date).map((d) => (
                          <option key={d} value={d}>
                            Day {dayNumber(trip.start_date, d)}, {formatDate(d)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>
                        Time <span className="hint">optional</span>
                      </span>
                      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                    </label>
                  </div>
                )}
              </div>
              {error && <p className="form-error">{error}</p>}
              <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={!trip || !date || add.isPending}>
                  {add.isPending ? 'Adding…' : 'Add stop'}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </dialog>
  )
}
