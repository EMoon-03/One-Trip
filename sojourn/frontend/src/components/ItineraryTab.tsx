import { useState } from 'react'
import { useCreateItem, useDeleteItem, useItinerary } from '../api/hooks'
import type { ItineraryCategory, ItineraryItem, ItineraryItemCreate, Trip } from '../api/types'
import { categoryColor, dayNumber, formatDate, formatTime } from '../utils'
import PlaceSearchInput from './PlaceSearchInput'

const CATEGORIES: ItineraryCategory[] = ['flight', 'lodging', 'food', 'activity', 'transport', 'other']

function AddStopForm({ trip }: { trip: Trip }) {
  const createItem = useCreateItem(trip.id)
  const blank = () => ({
    title: '',
    date: trip.start_date,
    start_time: '',
    end_time: '',
    category: 'activity' as ItineraryCategory,
    location_name: '',
    notes: '',
    // Set only when a search result is picked; cleared if the user keeps typing.
    place: null as { place_id: string; lat: number; lng: number } | null,
  })
  const [form, setForm] = useState(blank())
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof ReturnType<typeof blank>>(key: K, value: ReturnType<typeof blank>[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = () => {
    setError(null)
    const body: ItineraryItemCreate = {
      title: form.title,
      date: form.date,
      category: form.category,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      location_name: form.location_name || null,
      place_id: form.place?.place_id ?? null,
      lat: form.place?.lat ?? null,
      lng: form.place?.lng ?? null,
      notes: form.notes || null,
    }
    createItem.mutate(body, {
      onSuccess: () => setForm(blank()),
      onError: (e) => setError(e.message),
    })
  }

  return (
    <div className="card form-card">
      <h3 className="card-title">Add stop</h3>
      <div className="form-grid">
        <label>
          What
          <input
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="teamLab Planets"
          />
        </label>
        <label>
          Where
          <PlaceSearchInput
            value={form.location_name}
            placeholder="Search a place — Toyosu, teamLab…"
            onChange={(text) =>
              setForm((f) => ({ ...f, location_name: text, place: null }))
            }
            onSelect={(p) =>
              setForm((f) => ({
                ...f,
                location_name: p.name,
                place: { place_id: p.place_id, lat: p.lat, lng: p.lng },
              }))
            }
          />
        </label>
        <label>
          Date
          <input
            type="date"
            value={form.date}
            min={trip.start_date}
            max={trip.end_date}
            onChange={(e) => set('date', e.target.value)}
          />
        </label>
        <label>
          Category
          <select value={form.category} onChange={(e) => set('category', e.target.value as ItineraryCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starts
          <input type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} />
        </label>
        <label>
          Ends
          <input type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} />
        </label>
        <label className="span-2">
          Notes
          <input
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Buy tickets in advance"
          />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!form.title || !form.date || createItem.isPending}
          onClick={submit}
        >
          Add stop
        </button>
      </div>
    </div>
  )
}

export default function ItineraryTab({ trip }: { trip: Trip }) {
  const { data: items = [], isLoading } = useItinerary(trip.id)
  const deleteItem = useDeleteItem(trip.id)

  // Group by date; the API already returns items sorted by (date, start_time),
  // so insertion order gives us sorted days with sorted stops.
  const byDate = new Map<string, ItineraryItem[]>()
  for (const item of items) {
    const list = byDate.get(item.date) ?? []
    list.push(item)
    byDate.set(item.date, list)
  }

  return (
    <div className="tab-body">
      {isLoading && <p className="empty">Loading itinerary…</p>}

      {!isLoading && items.length === 0 && (
        <div className="card empty-card">
          <h3>No stops yet</h3>
          <p>Add the first one below — a flight, a check-in, a meal worth planning around.</p>
        </div>
      )}

      {[...byDate.entries()].map(([date, stops]) => (
        <section key={date} className="card day-card">
          <header className="day-head">
            <span className="eyebrow mono">Day {dayNumber(trip.start_date, date)}</span>
            <span className="day-date">{formatDate(date)}</span>
          </header>

          <div className="metro">
            {stops.map((stop) => (
              <div key={stop.id} className="stop">
                <div className="stop-time mono">
                  <span>{formatTime(stop.start_time) || '·'}</span>
                  {stop.end_time && <span className="stop-time-end">{formatTime(stop.end_time)}</span>}
                </div>

                <div className="rail" aria-hidden="true">
                  <span className="dot" style={{ background: categoryColor(stop.category) }} />
                </div>

                <div className="stop-body">
                  <div className="stop-title">
                    {stop.title}
                    {stop.location_name && <span className="stop-loc"> · {stop.location_name}</span>}
                  </div>
                  {stop.notes && <div className="stop-notes">{stop.notes}</div>}
                </div>

                <div className="stop-side">
                  <span
                    className="tag"
                    style={{ color: categoryColor(stop.category), borderColor: categoryColor(stop.category) }}
                  >
                    {stop.category}
                  </span>
                  <button
                    type="button"
                    className="btn icon"
                    aria-label={`Delete ${stop.title}`}
                    onClick={() => deleteItem.mutate(stop.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <AddStopForm trip={trip} />
    </div>
  )
}
