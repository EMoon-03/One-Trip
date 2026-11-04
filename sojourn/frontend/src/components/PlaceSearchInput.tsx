// Debounced place search against /api/places/search. The component neither
// knows nor cares which service answered — Google or OSM. It hands the picked
// place upward WITH coordinates: for Google results it first fetches them
// with /api/places/details.
//
// Google session tokens: one token covers a burst of typing plus the final
// details call, so Google bills the pick, not every keystroke. A new token
// starts after each pick (tokens are single-use).

import { useEffect, useRef, useState } from 'react'
import { fetchPlaceDetails, usePlaceSearch } from '../api/hooks'
import type { PlaceResult } from '../api/types'

const newSession = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export interface PickedPlace extends PlaceResult {
  lat: number | null // null only if the details lookup failed
  lng: number | null
}

interface Props {
  value: string
  placeholder?: string
  id?: string
  describedBy?: string // id of a note that explains the field (e.g. "Time zone set to…")
  onChange: (text: string) => void // user typed — coordinates no longer valid
  onSelect: (place: PickedPlace) => void // user picked a result
}

export default function PlaceSearchInput({ value, placeholder, id, describedBy, onChange, onSelect }: Props) {
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(newSession)
  const [resolving, setResolving] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 350ms debounce keeps us friendly to rate-limited geocoders (Nominatim
  // asks for ~1 req/sec) and avoids a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 350)
    return () => clearTimeout(timer)
  }, [value])

  const { data: results = [], isFetching, error } = usePlaceSearch(open ? debounced : '', session)

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const pick = async (place: PlaceResult) => {
    setOpen(false)
    setPickError(null)
    if (place.lat !== null && place.lng !== null) {
      onSelect(place)
    } else {
      setResolving(true)
      try {
        const d = await fetchPlaceDetails(place.place_id, session)
        onSelect({ ...place, lat: d.lat, lng: d.lng, address: d.address ?? place.address })
      } catch (err) {
        // Keep the name; the stop just won't be on the map.
        setPickError(`Couldn't get this place's location (${(err as Error).message}).`)
        onSelect(place)
      } finally {
        setResolving(false)
      }
    }
    setSession(newSession()) // the session ends with a pick
  }

  const showPanel = open && value.trim().length >= 3

  return (
    <div className="autocomplete" ref={wrapRef}>
      <input
        id={id}
        value={value}
        placeholder={placeholder ?? 'Search for a place'}
        onChange={(e) => {
          onChange(e.target.value)
          setPickError(null)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        role="combobox"
        aria-expanded={showPanel}
        aria-autocomplete="list"
        aria-describedby={describedBy}
      />
      {resolving && <p className="ac-status">Getting the location…</p>}
      {pickError && <p className="ac-status tone-warn">{pickError}</p>}

      {showPanel && (
        <div className="ac-panel" role="listbox">
          {isFetching && <p className="ac-hint">Searching…</p>}
          {error && (
            <p className="ac-hint">
              Place search isn't available right now ({error.message}). You can still type the name.
            </p>
          )}
          {!isFetching && !error && results.length === 0 && (
            <p className="ac-hint">No matches. Keep typing, or use the name as typed.</p>
          )}
          {results.map((place) => (
            <button
              key={place.place_id}
              type="button"
              className="ac-item"
              role="option"
              aria-selected="false"
              onClick={() => pick(place)}
            >
              <span className="ac-name">{place.name}</span>
              {place.address && <span className="ac-addr">{place.address}</span>}
            </button>
          ))}
          {/* Google's Places policy: data shown outside a Google map needs attribution;
              in tight spaces the text "Google Maps" (exactly, untranslated) is allowed. */}
          {results.some((r) => r.provider === 'google') && (
            <p className="ac-attrib" translate="no">
              Google Maps
            </p>
          )}
        </div>
      )}
    </div>
  )
}
