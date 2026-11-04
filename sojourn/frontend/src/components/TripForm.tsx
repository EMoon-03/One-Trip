// One form for both creating a trip (Trips page) and editing one (trip page).
// Pass `trip` to edit; leave it out to create.

import { useId, useState, type FormEvent } from 'react'
import { fetchTimezone, useCreateTrip, useUpdateTrip } from '../api/hooks'
import type { Trip, TripCreate } from '../api/types'
import { browserZone, zoneCity } from '../time'
import { todayISO } from '../utils'
import PlaceSearchInput from './PlaceSearchInput'
import ZoneSelect from './ZoneSelect'

const fromTrip = (trip?: Trip): TripCreate =>
  trip
    ? {
        name: trip.name,
        destination: trip.destination,
        start_date: trip.start_date,
        end_date: trip.end_date,
        base_currency: trip.base_currency,
        total_budget: trip.total_budget,
        notes: trip.notes,
        timezone: trip.timezone,
      }
    : {
        name: '',
        destination: '',
        start_date: todayISO(),
        end_date: todayISO(),
        base_currency: 'USD',
        total_budget: 0,
        timezone: browserZone(), // a guess; most people change it to the destination's
      }

export default function TripForm({ trip, onClose }: { trip?: Trip; onClose: () => void }) {
  const editing = trip !== undefined
  const createTrip = useCreateTrip()
  const updateTrip = useUpdateTrip(trip?.id ?? -1)
  const [form, setForm] = useState<TripCreate>(() => fromTrip(trip))
  const [error, setError] = useState<string | null>(null)
  const [zoneNote, setZoneNote] = useState<string | null>(null)
  const destId = useId()

  const set = <K extends keyof TripCreate>(key: K, value: TripCreate[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const datesOk = form.end_date >= form.start_date // ISO dates compare as strings
  const valid = form.name.trim() && form.destination.trim() && datesOk && form.base_currency.length === 3
  const pending = createTrip.isPending || updateTrip.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    const done = { onSuccess: onClose, onError: (err: Error) => setError(err.message) }
    if (editing) updateTrip.mutate(form, done)
    else createTrip.mutate(form, done)
  }

  return (
    <form className="panel" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h2 className="panel-title">{editing ? 'Edit trip' : 'New trip'}</h2>
      <div className="form-grid">
        <label className="field">
          Trip name
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Tokyo, Off the Clock"
            autoFocus
          />
        </label>
        <div className="field">
          <label htmlFor={destId}>Destination</label>
          <PlaceSearchInput
            id={destId}
            describedBy={zoneNote ? `${destId}-note` : undefined}
            value={form.destination}
            placeholder="Tokyo, Japan"
            onChange={(text) => set('destination', text)}
            onSelect={async (p) => {
              set('destination', p.label || p.name)
              setZoneNote(null)
              if (p.lat === null || p.lng === null) return
              // Picking the destination sets the trip's time zone.
              try {
                const { timezone } = await fetchTimezone(p.lat, p.lng)
                set('timezone', timezone)
                setZoneNote(`Time zone set to ${zoneCity(timezone)} time from ${p.label || p.name}.`)
              } catch {
                /* leave the zone as it was; it's still editable below */
              }
            }}
          />
          {zoneNote && (
            <span className="field-note" id={`${destId}-note`}>
              {zoneNote}
            </span>
          )}
        </div>
        <label className="field">
          Start date
          <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
        </label>
        <label className="field">
          End date
          <input
            type="date"
            value={form.end_date}
            min={form.start_date}
            onChange={(e) => set('end_date', e.target.value)}
          />
        </label>
        <label className="field">
          Budget
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.total_budget || ''}
            placeholder="0"
            onChange={(e) => set('total_budget', Number(e.target.value))}
          />
        </label>
        <label className="field">
          Currency
          <input
            value={form.base_currency}
            maxLength={3}
            onChange={(e) => set('base_currency', e.target.value.toUpperCase())}
          />
        </label>
        <label className="field">
          <span>
            Time zone <span className="hint">at the destination</span>
          </span>
          <ZoneSelect
            value={form.timezone}
            onChange={(zone) => {
              set('timezone', zone)
              setZoneNote(null)
            }}
            shortcuts={
              form.timezone !== browserZone()
                ? [{ value: browserZone(), label: `Your time zone (${zoneCity(browserZone())})` }]
                : []
            }
          />
        </label>
      </div>
      {editing && trip.timezone !== form.timezone && (
        <p className="form-note">
          Times you've entered stay as written (10:30 stays 10:30) and now mean {zoneCity(form.timezone)} time.
          Reminders move to match.
        </p>
      )}
      {!datesOk && <p className="form-error">The end date can't be before the start date.</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {editing ? 'Save changes' : 'Create trip'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
