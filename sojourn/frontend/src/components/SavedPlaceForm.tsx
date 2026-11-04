// Save a place (no `place`) or edit one. "Where" searches like the stop form
// does and fills in the coordinates; "Name" is your own label for it.

import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useCollections, useCreateSaved, useSavedTags, useUpdateSaved } from '../api/hooks'
import type { ItineraryCategory, PlaceStatus, SavedPlace, SavedPlaceCreate } from '../api/types'
import { label } from '../utils'
import PlaceSearchInput from './PlaceSearchInput'
import { Icon } from './ui'

export const CATEGORIES: ItineraryCategory[] = ['food', 'activity', 'lodging', 'transport', 'flight', 'other']
const MAX_TAGS = 12

type Located = { place_id: string | null; lat: number; lng: number }

const formFrom = (place?: SavedPlace, collectionId?: number) => ({
  name: place?.name ?? '',
  where: place?.address ?? '',
  located: (place && place.lat !== null && place.lng !== null
    ? { place_id: place.place_id, lat: place.lat, lng: place.lng }
    : null) as Located | null,
  category: place?.category ?? ('food' as ItineraryCategory),
  status: place?.status ?? ('want' as PlaceStatus),
  rating: place?.rating ?? null,
  tags: place?.tags ?? [],
  collection_ids: place?.collection_ids ?? (collectionId !== undefined ? [collectionId] : []),
  notes: place?.notes ?? '',
})

/** Five stars; clicking the current rating clears it. */
export function StarRating({
  value,
  onChange,
  size = 18,
  name,
}: {
  value: number | null
  onChange?: (v: number | null) => void
  size?: number
  name: string
}) {
  if (!onChange) {
    if (!value) return null
    return (
      <span className="stars is-static" role="img" aria-label={`Rated ${value} of 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={n <= value ? 'on' : ''}>
            <Icon name="star" size={size} filled={n <= value} />
          </span>
        ))}
      </span>
    )
  }
  return (
    <span className="stars" role="group" aria-label={`Rating for ${name}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={value !== null && n <= value ? 'on' : ''}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          aria-pressed={value === n}
          title={value === n ? 'Clear rating' : `${n} of 5`}
          onClick={() => onChange(value === n ? null : n)}
        >
          <Icon name="star" size={size} filled={value !== null && n <= value} />
        </button>
      ))}
    </span>
  )
}

/** Type a tag and press Enter (or a comma); your existing tags are one click away. */
function TagEditor({ id, tags, onChange }: { id: string; tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const { data: known = [] } = useSavedTags()
  const add = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 30)
    if (t && !tags.includes(t) && tags.length < MAX_TAGS) onChange([...tags, t])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }
  const suggestions = known.map((k) => k.tag).filter((t) => !tags.includes(t) && t.includes(draft.trim().toLowerCase())).slice(0, 8)

  return (
    <div className="tag-editor">
      <div className="tag-input">
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={tags.length ? '' : 'ramen, late night…'}
          disabled={tags.length >= MAX_TAGS}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="tag-suggest">
          {suggestions.map((t) => (
            <button key={t} type="button" className="tag is-suggest" onClick={() => add(t)}>
              <Icon name="plus" size={11} />
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SavedPlaceForm({
  place,
  collectionId,
  onClose,
  onSaved,
}: {
  place?: SavedPlace
  collectionId?: number // pre-select when saving from inside a collection
  onClose: () => void
  onSaved?: (p: SavedPlace) => void
}) {
  const editing = place !== undefined
  const create = useCreateSaved()
  const update = useUpdateSaved()
  const { data: collections = [] } = useCollections()
  const [form, setForm] = useState(() => formFrom(place, collectionId))
  const [error, setError] = useState<string | null>(null)
  const ids = useId()

  type Form = ReturnType<typeof formFrom>
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  const valid = form.name.trim().length > 0
  const pending = create.isPending || update.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    const body: SavedPlaceCreate = {
      name: form.name.trim(),
      category: form.category,
      status: form.status,
      rating: form.rating,
      notes: form.notes.trim() || null,
      address: form.where.trim() || null,
      place_id: form.located?.place_id ?? null,
      lat: form.located?.lat ?? null,
      lng: form.located?.lng ?? null,
      tags: form.tags,
      collection_ids: form.collection_ids,
    }
    const onError = (err: Error) => setError(err.message)
    if (editing) update.mutate({ id: place.id, body }, { onSuccess: (p) => (onSaved?.(p), onClose()), onError })
    else create.mutate(body, { onSuccess: (p) => (onSaved?.(p), onClose()), onError })
  }

  const toggleCollection = (id: number) =>
    set('collection_ids', form.collection_ids.includes(id) ? form.collection_ids.filter((c) => c !== id) : [...form.collection_ids, id])

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h2 className="panel-title">{editing ? `Edit ${place.name}` : 'Save a place'}</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${ids}-where`}>Where</label>
          <PlaceSearchInput
            id={`${ids}-where`}
            value={form.where}
            placeholder="Search for a restaurant, sight, café…"
            onChange={(text) => setForm((f) => ({ ...f, where: text, located: null }))}
            onSelect={(p) =>
              setForm((f) => ({
                ...f,
                name: f.name.trim() ? f.name : p.name,
                where: p.address || p.name,
                located: p.lat !== null && p.lng !== null ? { place_id: p.place_id, lat: p.lat, lng: p.lng } : null,
              }))
            }
          />
          {form.where && !form.located && (
            <span className="field-note">Pick a search result to put it on the map and get "nearby" suggestions.</span>
          )}
        </div>
        <label className="field">
          Name
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ichiran Shibuya" autoFocus={!editing} />
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
        <div className="field">
          <span id={`${ids}-status`}>Status</span>
          <div className="segmented" role="radiogroup" aria-labelledby={`${ids}-status`}>
            {(['want', 'visited'] as PlaceStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={form.status === s}
                className={form.status === s ? 'active' : ''}
                onClick={() => set('status', s)}
              >
                {s === 'want' ? 'Want to go' : 'Been there'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>
            Rating <span className="hint">optional</span>
          </span>
          <StarRating value={form.rating} onChange={(v) => set('rating', v)} name={form.name || 'this place'} />
        </div>
        <div className="field span-all">
          <label htmlFor={`${ids}-tags`}>
            Tags <span className="hint">press Enter after each</span>
          </label>
          <TagEditor id={`${ids}-tags`} tags={form.tags} onChange={(t) => set('tags', t)} />
        </div>
        {collections.length > 0 && (
          <div className="field span-all">
            <span id={`${ids}-colls`}>Collections</span>
            <div className="chip-row" role="group" aria-labelledby={`${ids}-colls`}>
              {collections.map((c) => {
                const on = form.collection_ids.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip${on ? ' active' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggleCollection(c.id)}
                  >
                    {on && <Icon name="check" size={12} />}
                    {c.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <label className="field span-all">
          <span>
            Notes <span className="hint">optional</span>
          </span>
          <input value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Order the noodles extra firm" />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {editing ? 'Save changes' : 'Save place'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
