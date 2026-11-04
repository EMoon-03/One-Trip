// Saved places: everywhere you want to go (or went), with or without a trip.
// The whole list is small, so it's loaded once and filtered here: switching
// collection, status, tag or search is instant. Filters live in the URL
// (?c=2&status=want&tag=ramen) so back/refresh/shared links keep them.

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useDeleteSaved,
  useSavedPlaces,
  useUpdateCollection,
  useUpdateSaved,
} from '../api/hooks'
import type { Collection, PlaceStatus, SavedPlace } from '../api/types'
import AddToTripDialog from '../components/AddToTripDialog'
import SavedPlaceForm, { StarRating } from '../components/SavedPlaceForm'
import { useToast } from '../components/Toast'
import { Icon, Skeleton } from '../components/ui'
import { pendingKey, usePendingDeletes } from '../pendingDeletes'
import { usePageTitle } from '../usePageTitle'
import { categoryColor, formatDate, label, todayInZone } from '../utils'

const TAGS_SHOWN = 8

const lineColor = (category: string) => ({ '--c': categoryColor(category) }) as CSSProperties

/** The first trip stop at this place that's already behind you, if any. */
const pastVisit = (p: SavedPlace) => p.in_trips.find((t) => t.date < todayInZone(t.trip_timezone))

// ------------------------------------------------------------ collections ---

function NewCollection({ onCreated }: { onCreated: (c: Collection) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const create = useCreateCollection()
  const [error, setError] = useState<string | null>(null)

  if (!open)
    return (
      <button type="button" className="coll-new" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> New collection
      </button>
    )

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: (c) => {
          setName('')
          setOpen(false)
          setError(null)
          onCreated(c)
        },
        onError: (err) => setError((err as Error).message),
      },
    )
  }

  return (
    <form className="coll-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Tokyo eats"
        aria-label="Collection name"
        maxLength={80}
        autoFocus
        onBlur={() => !name.trim() && setOpen(false)}
      />
      {error && <p className="form-error">{error}</p>}
    </form>
  )
}

function CollectionHead({ coll, onDeleted }: { coll: Collection; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(coll.name)
  const [description, setDescription] = useState(coll.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const update = useUpdateCollection()
  const del = useDeleteCollection()
  const { undoableDelete } = useToast()

  useEffect(() => {
    setEditing(false)
    setName(coll.name)
    setDescription(coll.description ?? '')
  }, [coll.id, coll.name, coll.description])

  const save = (e: FormEvent) => {
    e.preventDefault()
    update.mutate(
      { id: coll.id, body: { name: name.trim(), description: description.trim() || null } },
      { onSuccess: () => setEditing(false), onError: (err) => setError((err as Error).message) },
    )
  }

  if (editing)
    return (
      <form className="panel coll-edit" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
        <div className="form-grid">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </label>
          <label className="field">
            <span>
              Description <span className="hint">optional</span>
            </span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={!name.trim() || update.isPending}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    )

  return (
    <div className="coll-head">
      <div>
        <h2 className="coll-title">{coll.name}</h2>
        {coll.description && <p className="muted">{coll.description}</p>}
      </div>
      <div className="coll-actions">
        <button type="button" className="btn-text" onClick={() => setEditing(true)}>
          Rename
        </button>
        <button
          type="button"
          className="btn-text danger"
          onClick={() => {
            onDeleted()
            undoableDelete({
              key: pendingKey('collection', coll.id),
              label: coll.name,
              commit: () => del.mutate(coll.id),
            })
          }}
        >
          Delete collection
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ card ---

function PlaceCard({
  place,
  onEdit,
  onAddToTrip,
  onTag,
}: {
  place: SavedPlace
  onEdit: () => void
  onAddToTrip: () => void
  onTag: (t: string) => void
}) {
  const update = useUpdateSaved()
  const del = useDeleteSaved()
  const { undoableDelete } = useToast()
  const visit = place.status === 'want' ? pastVisit(place) : undefined
  const setStatus = (status: PlaceStatus) => update.mutate({ id: place.id, body: { status } })

  return (
    <article className={`place-card${place.status === 'visited' ? ' is-visited' : ''}`} id={`place-${place.id}`}>
      <div className="place-top">
        <span className="cat" style={lineColor(place.category)}>
          <span className="cat-dot" aria-hidden="true" />
          {label(place.category)}
        </span>
        {place.status === 'visited' && (
          <span className="visited-pill">
            <Icon name="check" size={12} /> Been there
          </span>
        )}
        {place.lat === null && (
          <span className="place-nomap" title="No location: it won't show on maps or in nearby suggestions">
            Not on the map
          </span>
        )}
      </div>

      <h3 className="place-name">{place.name}</h3>
      {place.address && place.address !== place.name && <p className="place-addr">{place.address}</p>}

      {place.status === 'visited' && (
        <StarRating value={place.rating} onChange={(rating) => update.mutate({ id: place.id, body: { rating } })} name={place.name} size={17} />
      )}

      {place.notes && <p className="place-notes">{place.notes}</p>}

      {place.tags.length > 0 && (
        <div className="place-tags">
          {place.tags.map((t) => (
            <button key={t} type="button" className="tag" onClick={() => onTag(t)} title={`Show places tagged ${t}`}>
              {t}
            </button>
          ))}
        </div>
      )}

      {visit && (
        <p className="place-hint">
          You were there on {formatDate(visit.date)}.{' '}
          <button type="button" className="link-btn" onClick={() => setStatus('visited')}>
            Mark visited and rate it
          </button>
        </p>
      )}

      {place.in_trips.length > 0 && (
        <ul className="place-trips">
          {place.in_trips.map((t) => (
            <li key={t.stop_id}>
              <Icon name="route" size={13} />
              <Link to={`/trips/${t.trip_id}`}>{t.trip_name}</Link>
              <span className="muted">{formatDate(t.date)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="place-actions">
        <button type="button" className="btn-text" onClick={onAddToTrip}>
          <Icon name="plus" size={14} /> Add to trip
        </button>
        {!visit && (
          <button
            type="button"
            className="btn-text"
            onClick={() => setStatus(place.status === 'want' ? 'visited' : 'want')}
            disabled={update.isPending}
          >
            {place.status === 'want' ? 'Mark visited' : 'Want to go again'}
          </button>
        )}
        <span className="row-actions">
          <button type="button" className="icon-btn edit" aria-label={`Edit ${place.name}`} title="Edit" onClick={onEdit}>
            <Icon name="edit" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete ${place.name}`}
            title="Delete"
            onClick={() =>
              undoableDelete({ key: pendingKey('saved', place.id), label: place.name, commit: () => del.mutate(place.id) })
            }
          >
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
    </article>
  )
}

// ------------------------------------------------------------------ page ---

export default function SavedPage() {
  usePageTitle('Saved places')
  const { data: allPlaces, isLoading, error } = useSavedPlaces()
  const { data: allCollections = [] } = useCollections()
  const pending = usePendingDeletes()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [addToTrip, setAddToTrip] = useState<SavedPlace | null>(null)
  const [allTags, setAllTags] = useState(false)

  const places = (allPlaces ?? []).filter((p) => !pending.has(pendingKey('saved', p.id)))
  const collections = allCollections.filter((c) => !pending.has(pendingKey('collection', c.id)))

  const collId = params.get('c') ? Number(params.get('c')) : null
  const coll = collections.find((c) => c.id === collId) ?? null
  const status = (['want', 'visited'] as const).find((s) => s === params.get('status')) ?? null
  const tag = params.get('tag')

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: key !== 'c' }) // collections are "places" for Back; filters aren't
  }

  // A link to #place-12 (from a stop's bookmark) scrolls to and flashes the card.
  useEffect(() => {
    const id = window.location.hash.match(/^#place-(\d+)$/)?.[1]
    if (!id || !allPlaces) return
    const el = document.getElementById(`place-${id}`)
    el?.scrollIntoView({ block: 'center' })
    el?.classList.add('is-focused')
    const t = setTimeout(() => el?.classList.remove('is-focused'), 1600)
    return () => clearTimeout(t)
  }, [allPlaces])

  const inScope = coll ? places.filter((p) => p.collection_ids.includes(coll.id)) : places
  const q = query.trim().toLowerCase()
  const shown = inScope.filter(
    (p) =>
      (!status || p.status === status) &&
      (!tag || p.tags.includes(tag)) &&
      (!q || [p.name, p.address, p.notes, ...p.tags].some((s) => s?.toLowerCase().includes(q))),
  )
  // Places you've been to but haven't marked yet go first: they need a rating.
  const ordered = [...shown].sort((a, b) => Number(!!pastVisit(b) && b.status === 'want') - Number(!!pastVisit(a) && a.status === 'want'))

  const tagCounts = new Map<string, number>()
  for (const p of inScope) for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const counts = {
    all: inScope.length,
    want: inScope.filter((p) => p.status === 'want').length,
    visited: inScope.filter((p) => p.status === 'visited').length,
  }
  const filtered = !!(status || tag || q)
  const clearFilters = () => {
    setQuery('')
    const next = new URLSearchParams(params)
    next.delete('status')
    next.delete('tag')
    setParams(next, { replace: true })
  }

  const visitedTotal = places.filter((p) => p.status === 'visited').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Saved places</h1>
          {allPlaces && allPlaces.length > 0 && (
            <p className="page-sub">
              {places.length} place{places.length === 1 ? '' : 's'}, {visitedTotal} visited
              {collections.length > 0 && `, in ${collections.length} collection${collections.length === 1 ? '' : 's'}`}
            </p>
          )}
        </div>
        {!adding && allPlaces && allPlaces.length > 0 && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="bookmark" size={15} />
            Save a place
          </button>
        )}
      </div>

      {adding && (
        <section className="panel" aria-label="Save a place">
          <SavedPlaceForm collectionId={coll?.id} onClose={() => setAdding(false)} />
        </section>
      )}

      {error && <p className="form-error">Couldn't load your saved places: {(error as Error).message}</p>}

      {isLoading && (
        <div className="place-grid" aria-label="Loading saved places">
          {[0, 1, 2].map((i) => (
            <div key={i} className="place-card">
              <Skeleton width={70} height={12} />
              <Skeleton width="70%" height={20} style={{ marginTop: 12 }} />
              <Skeleton width="50%" height={13} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
      )}

      {allPlaces && allPlaces.length === 0 && !adding && (
        <div className="empty-state welcome">
          <h2>Keep a list of places worth the trip</h2>
          <ol className="welcome-steps">
            <li>
              <strong>Save places before you have a trip.</strong> That ramen bar a friend mentioned, a museum for a rainy
              day. Tag them, rate them, group them into collections.
            </li>
            <li>
              <strong>Add them to a trip in two clicks.</strong> Pick the day; the location and time zone come along.
            </li>
            <li>
              <strong>Get reminded they exist.</strong> When a trip passes near a saved place, its itinerary suggests it.
            </li>
          </ol>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="bookmark" size={15} />
            Save your first place
          </button>
        </div>
      )}

      {allPlaces && allPlaces.length > 0 && (
        <div className="saved-layout">
          <nav className="coll-nav" aria-label="Collections">
            <p className="coll-nav-label">Collections</p>
            <button
              type="button"
              className={`coll-link${coll ? '' : ' active'}`}
              aria-current={coll ? undefined : 'page'}
              onClick={() => setParam('c', null)}
            >
              All places <span className="count">{places.length}</span>
            </button>
            {collections.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`coll-link${coll?.id === c.id ? ' active' : ''}`}
                aria-current={coll?.id === c.id ? 'page' : undefined}
                onClick={() => setParam('c', String(c.id))}
              >
                {c.name} <span className="count">{places.filter((p) => p.collection_ids.includes(c.id)).length}</span>
              </button>
            ))}
            <NewCollection onCreated={(c) => setParam('c', String(c.id))} />
          </nav>

          <div className="saved-main">
            {coll && <CollectionHead coll={coll} onDeleted={() => setParam('c', null)} />}

            <div className="saved-filters">
              <div className="search-box">
                <Icon name="search" size={15} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search names, notes, tags"
                  aria-label="Search saved places"
                />
              </div>
              <div className="segmented" role="radiogroup" aria-label="Status">
                {([
                  [null, 'All', counts.all],
                  ['want', 'Want to go', counts.want],
                  ['visited', 'Been there', counts.visited],
                ] as const).map(([value, text, n]) => (
                  <button
                    key={text}
                    type="button"
                    role="radio"
                    aria-checked={status === value}
                    className={status === value ? 'active' : ''}
                    onClick={() => setParam('status', value)}
                  >
                    {text} <span className="seg-count">{n}</span>
                  </button>
                ))}
              </div>
            </div>

            {tags.length > 0 && (
              <div className="chip-row tag-filter" role="group" aria-label="Filter by tag">
                {(allTags ? tags : tags.filter(([t], i) => i < TAGS_SHOWN || t === tag)).map(([t, n]) => (
                  <button
                    key={t}
                    type="button"
                    className={`chip${tag === t ? ' active' : ''}`}
                    aria-pressed={tag === t}
                    onClick={() => setParam('tag', tag === t ? null : t)}
                  >
                    {t} <span className="chip-count">{n}</span>
                  </button>
                ))}
                {tags.length > TAGS_SHOWN && (
                  <button type="button" className="chip is-more" onClick={() => setAllTags((v) => !v)} aria-expanded={allTags}>
                    {allTags ? 'Fewer tags' : `${tags.length - TAGS_SHOWN} more`}
                  </button>
                )}
              </div>
            )}

            {ordered.length === 0 ? (
              <div className="saved-empty">
                {filtered ? (
                  <>
                    <p>No places match.</p>
                    <button type="button" className="btn" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </>
                ) : coll ? (
                  <>
                    <p>Nothing in {coll.name} yet. Save a place here, or open any place's edit form and tick this collection.</p>
                    {!adding && (
                      <button type="button" className="btn" onClick={() => setAdding(true)}>
                        <Icon name="bookmark" size={15} /> Save a place to {coll.name}
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="place-grid">
                {ordered.map((p) =>
                  editingId === p.id ? (
                    <section key={p.id} className="panel place-edit" aria-label={`Edit ${p.name}`}>
                      <SavedPlaceForm place={p} onClose={() => setEditingId(null)} />
                    </section>
                  ) : (
                    <PlaceCard
                      key={p.id}
                      place={p}
                      onEdit={() => setEditingId(p.id)}
                      onAddToTrip={() => setAddToTrip(p)}
                      onTag={(t) => setParam('tag', t)}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <AddToTripDialog place={addToTrip} onClose={() => setAddToTrip(null)} />
    </>
  )
}
