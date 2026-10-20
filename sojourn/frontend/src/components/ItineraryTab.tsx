import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { fetchTimezone, useCreateItem, useDeleteItem, useItinerary, useUpdateItem } from '../api/hooks'
import type { ItineraryCategory, ItineraryItem, ItineraryItemCreate, Trip } from '../api/types'
import { pendingKey, usePendingDeletes } from '../pendingDeletes'
import { categoryColor, dayNumber, eachDate, formatDate, formatTime, label } from '../utils'
import { browserZone, differsFromBrowser, zoneAbbr, zoneCity } from '../time'
import PlaceSearchInput from './PlaceSearchInput'
import ZoneSelect from './ZoneSelect'
import { useToast } from './Toast'
import { AddPanel, Icon, ListSkeleton } from './ui'

const CATEGORIES: ItineraryCategory[] = ['flight', 'lodging', 'food', 'activity', 'transport', 'other']

/** Pass a category color to CSS as --c (used by .station and .cat). */
const lineColor = (category: string) => ({ '--c': categoryColor(category) }) as CSSProperties

type Place = { place_id: string | null; lat: number; lng: number }

const formFrom = (trip: Trip, item?: ItineraryItem, initialDate?: string) => ({
  title: item?.title ?? '',
  date: item?.date ?? initialDate ?? trip.start_date,
  start_time: formatTime(item?.start_time ?? null),
  end_time: formatTime(item?.end_time ?? null),
  category: item?.category ?? ('activity' as ItineraryCategory),
  location_name: item?.location_name ?? '',
  notes: item?.notes ?? '',
  timezone: item?.timezone ?? '', // '' = the trip's zone
  // Set when a search result is picked, or when the stop already has
  // coordinates (place_id may be missing, e.g. seeded or older stops).
  // Cleared as soon as the user types a different place name.
  place: (item && item.lat !== null && item.lng !== null
    ? { place_id: item.place_id, lat: item.lat, lng: item.lng }
    : null) as Place | null,
})

/**
 * Add a stop (no `item`) or edit one (`item` given). Adding keeps the form
 * open and clears it, so several stops can go in quickly; saving an edit
 * closes it.
 */
function StopForm({
  trip,
  item,
  initialDate,
  onClose,
}: {
  trip: Trip
  item?: ItineraryItem
  initialDate?: string
  onClose: () => void
}) {
  const editing = item !== undefined
  const createItem = useCreateItem(trip.id)
  const updateItem = useUpdateItem(trip.id)
  const [form, setForm] = useState(() => formFrom(trip, item, initialDate))
  const [error, setError] = useState<string | null>(null)
  const [zoneNote, setZoneNote] = useState<string | null>(null)
  const whereId = useId()

  type Form = ReturnType<typeof formFrom>
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  const valid = form.title.trim() && form.date
  const pending = createItem.isPending || updateItem.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    // Every field is sent, so clearing an input (e.g. the end time) clears it on the server too.
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
      timezone: form.timezone || null,
    }
    const onError = (err: Error) => setError(err.message)
    if (editing) updateItem.mutate({ id: item.id, body }, { onSuccess: onClose, onError })
    else createItem.mutate(body, { onSuccess: () => setForm(formFrom(trip, undefined, form.date)), onError })
  }

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h2 className="panel-title">{editing ? 'Edit stop' : initialDate ? `Add a stop on ${formatDate(initialDate)}` : 'Add a stop'}</h2>
      <div className="form-grid">
        <label className="field">
          What
          <input
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="teamLab Planets"
            autoFocus
          />
        </label>
        <div className="field">
          <label htmlFor={whereId}>Where</label>
          <PlaceSearchInput
            id={whereId}
            describedBy={zoneNote ? `${whereId}-note` : undefined}
            value={form.location_name}
            placeholder="Search for a place"
            onChange={(text) => setForm((f) => ({ ...f, location_name: text, place: null }))}
            onSelect={async (p) => {
              const located = p.lat !== null && p.lng !== null
              setForm((f) => ({
                ...f,
                location_name: p.name,
                place: located ? { place_id: p.place_id, lat: p.lat!, lng: p.lng! } : null,
              }))
              setZoneNote(null)
              if (!located) return
              // The place decides the stop's time zone: a JFK departure runs on New York time.
              try {
                const { timezone } = await fetchTimezone(p.lat!, p.lng!)
                const own = timezone === trip.timezone ? '' : timezone
                setForm((f) => ({ ...f, timezone: own }))
                if (own) setZoneNote(`Time zone set to ${zoneCity(own)} time from ${p.name}.`)
              } catch {
                /* keep whatever zone was chosen; the field is still editable */
              }
            }}
          />
          {zoneNote && (
            <span className="field-note" id={`${whereId}-note`}>
              {zoneNote}
            </span>
          )}
        </div>
        <label className="field">
          Day
          <input
            type="date"
            value={form.date}
            min={trip.start_date}
            max={trip.end_date}
            onChange={(e) => set('date', e.target.value)}
          />
        </label>
        <label className="field">
          Type
          <select value={form.category} onChange={(e) => set('category', e.target.value as ItineraryCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Starts
          <input type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} />
        </label>
        <label className="field">
          <span>
            Ends <span className="hint">optional</span>
          </span>
          <input type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} />
        </label>
        <label className="field">
          Time zone
          <ZoneSelect
            value={form.timezone}
            onChange={(zone) => {
              set('timezone', zone === trip.timezone ? '' : zone)
              setZoneNote(null)
            }}
            shortcuts={[
              { value: '', label: `Trip time (${zoneCity(trip.timezone)})` },
              ...(browserZone() !== trip.timezone
                ? [{ value: browserZone(), label: `Your time (${zoneCity(browserZone())})` }]
                : []),
            ]}
          />
        </label>
        <label className="field span-all">
          <span>
            Notes <span className="hint">optional</span>
          </span>
          <input
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Buy tickets in advance"
          />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {editing ? 'Save changes' : 'Add stop'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {editing ? 'Cancel' : 'Close'}
        </button>
      </div>
    </form>
  )
}

export default function ItineraryTab({
  trip,
  focus,
  today,
}: {
  trip: Trip
  focus?: { date: string; n: number } | null
  today?: string
}) {
  const { data: all = [], isLoading } = useItinerary(trip.id)
  const deleteItem = useDeleteItem(trip.id)
  const { undoableDelete } = useToast()
  const pending = usePendingDeletes()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [addingDate, setAddingDate] = useState<string | null>(null)
  const routeRef = useRef<HTMLOListElement>(null)

  const items = all.filter((i) => !pending.has(pendingKey('stop', i.id)))

  // Every day of the trip gets a place on the route, planned or not, plus any
  // stops left outside the dates (e.g. after the trip was shortened).
  // The API returns stops sorted by (date, start_time).
  const byDate = new Map<string, ItineraryItem[]>()
  for (const date of eachDate(trip.start_date, trip.end_date)) byDate.set(date, [])
  for (const item of items) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item])
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))

  // The day strip asked for a day: scroll it into view.
  useEffect(() => {
    if (!focus) return
    const el = routeRef.current?.querySelector<HTMLElement>(`[data-date="${focus.date}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el?.classList.add('is-focused')
    const t = setTimeout(() => el?.classList.remove('is-focused'), 1600)
    return () => clearTimeout(t)
  }, [focus])

  const remove = (stop: ItineraryItem) =>
    undoableDelete({ key: pendingKey('stop', stop.id), label: stop.title, commit: () => deleteItem.mutate(stop.id) })

  const inRange = (date: string) => date >= trip.start_date && date <= trip.end_date

  return (
    <div className="tab-body">
      {isLoading && <ListSkeleton rows={5} />}

      {!isLoading && differsFromBrowser(trip.timezone) && (
        <p className="zone-note">
          Times are {zoneCity(trip.timezone)} time ({zoneAbbr(trip.timezone)}) unless a stop shows another zone.
        </p>
      )}

      {!isLoading && (
        <ol className="route" ref={routeRef}>
          {days.map(([date, stops]) => {
            const isToday = date === today
            return (
              <li
                key={date}
                className={`route-day${isToday ? ' is-today' : ''}${stops.length === 0 ? ' is-empty' : ''}`}
                data-date={date}
              >
                <div className="day-label">
                  <span className="day-num">
                    {inRange(date) ? `Day ${dayNumber(trip.start_date, date)}` : 'Outside the trip'}
                    {isToday && <span className="today-tag">Today</span>}
                  </span>
                  <span className="day-date">{formatDate(date)}</span>
                  {stops.length > 0 && addingDate !== date && (
                    <button type="button" className="day-add" onClick={() => setAddingDate(date)}>
                      <Icon name="plus" size={13} /> Add
                    </button>
                  )}
                </div>

                <ol className="day-stops">
                  {stops.length === 0 && addingDate !== date && (
                    <li className="stop is-empty-day">
                      <div className="stop-time" />
                      <div className="rail" aria-hidden="true">
                        <span className="station hollow" />
                      </div>
                      <div className="stop-body">
                        <p className="stop-empty-text">Nothing planned yet</p>
                        <button type="button" className="btn-text day-add-empty" onClick={() => setAddingDate(date)}>
                          <Icon name="plus" size={13} /> Add a stop
                        </button>
                      </div>
                    </li>
                  )}

                  {stops.map((stop) => (
                    <li key={stop.id} className="stop">
                      <div className="stop-time">
                        {formatTime(stop.start_time)}
                        {stop.end_time && <span className="stop-time-end">{formatTime(stop.end_time)}</span>}
                        {stop.timezone && stop.timezone !== trip.timezone && (
                          <span className="stop-zone" title={`${zoneCity(stop.timezone)} time`}>
                            {zoneAbbr(stop.timezone, new Date(`${stop.date}T12:00:00Z`))}
                          </span>
                        )}
                      </div>

                      <div className="rail" aria-hidden="true">
                        <span className="station" style={lineColor(stop.category)} />
                      </div>

                      {editingId === stop.id ? (
                        <div className="panel stop-edit">
                          <StopForm trip={trip} item={stop} onClose={() => setEditingId(null)} />
                        </div>
                      ) : (
                        <>
                          <div className="stop-body">
                            <p className="stop-title">{stop.title}</p>
                            <p className="stop-meta">
                              <span className="cat" style={lineColor(stop.category)}>
                                {label(stop.category)}
                              </span>
                              {stop.location_name && <span>{stop.location_name}</span>}
                            </p>
                            {stop.notes && <p className="stop-notes">{stop.notes}</p>}
                          </div>

                          <div className="row-actions">
                            <button
                              type="button"
                              className="icon-btn edit"
                              aria-label={`Edit ${stop.title}`}
                              title="Edit stop"
                              onClick={() => setEditingId(stop.id)}
                            >
                              <Icon name="edit" size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Delete ${stop.title}`}
                              title="Delete stop"
                              onClick={() => remove(stop)}
                            >
                              <Icon name="x" size={15} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}

                  {addingDate === date && (
                    <li className="stop stop-adding">
                      <div className="stop-time" />
                      <div className="rail" aria-hidden="true">
                        <span className="station hollow" />
                      </div>
                      <div className="panel stop-edit">
                        <StopForm trip={trip} initialDate={date} onClose={() => setAddingDate(null)} />
                      </div>
                    </li>
                  )}
                </ol>
              </li>
            )
          })}
        </ol>
      )}

      {!isLoading && items.length === 0 && (
        <p className="empty" style={{ marginTop: 20 }}>
          Start with the fixed points: flights, check-ins, anything you've booked. Pick a day above, or:
        </p>
      )}

      <AddPanel label="Add stop">{(close) => <StopForm trip={trip} onClose={close} />}</AddPanel>
    </div>
  )
}
