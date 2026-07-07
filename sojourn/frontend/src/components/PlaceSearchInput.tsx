// Debounced autocomplete against /api/places/search. The component neither
// knows nor cares which geocoder answered — Google or OSM — it just shows
// normalized results and hands the chosen one (with coordinates) upward.

import { useEffect, useRef, useState } from 'react'
import { usePlaceSearch } from '../api/hooks'
import type { PlaceResult } from '../api/types'

interface Props {
  value: string
  placeholder?: string
  onChange: (text: string) => void // user typed — coordinates no longer valid
  onSelect: (place: PlaceResult) => void // user picked a result
}

export default function PlaceSearchInput({ value, placeholder, onChange, onSelect }: Props) {
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 350ms debounce keeps us friendly to rate-limited geocoders (Nominatim
  // asks for ~1 req/sec) and avoids a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 350)
    return () => clearTimeout(timer)
  }, [value])

  const { data: results = [], isFetching, error } = usePlaceSearch(open ? debounced : '')

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const showPanel = open && value.trim().length >= 3

  return (
    <div className="autocomplete" ref={wrapRef}>
      <input
        value={value}
        placeholder={placeholder ?? 'Search a place…'}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        role="combobox"
        aria-expanded={showPanel}
        aria-autocomplete="list"
      />

      {showPanel && (
        <div className="ac-panel" role="listbox">
          {isFetching && <p className="ac-hint mono">searching…</p>}
          {error && <p className="ac-hint">Location search unavailable — you can still type a name.</p>}
          {!isFetching && !error && results.length === 0 && (
            <p className="ac-hint">No matches. Keep typing or use the name as-is.</p>
          )}
          {results.map((place) => (
            <button
              key={place.place_id}
              type="button"
              className="ac-item"
              role="option"
              aria-selected="false"
              onClick={() => {
                onSelect(place)
                setOpen(false)
              }}
            >
              <span className="ac-name">{place.name}</span>
              {place.address && <span className="ac-addr">{place.address}</span>}
              <span className="ac-provider mono">{place.provider === 'google' ? 'google' : 'osm'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
