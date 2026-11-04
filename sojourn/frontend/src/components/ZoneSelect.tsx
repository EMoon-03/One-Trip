// A <select> of IANA time zones with the useful choices on top
// ("Trip time — Tokyo", "Your time — New York"), then every zone.

import { useMemo } from 'react'
import { allZones, zoneAbbr } from '../time'

export interface ZoneShortcut {
  value: string // '' is allowed: e.g. "follow the trip"
  label: string
}

export default function ZoneSelect({
  value,
  onChange,
  shortcuts = [],
  id,
}: {
  value: string
  onChange: (zone: string) => void
  shortcuts?: ZoneShortcut[]
  id?: string
}) {
  const zones = useMemo(allZones, [])
  const shortcutValues = new Set(shortcuts.map((s) => s.value))
  // Keep an unusual saved value selectable even if the browser's list lacks it.
  const list = value && !zones.includes(value) && !shortcutValues.has(value) ? [value, ...zones] : zones

  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {shortcuts.length > 0 && (
        <optgroup label="Suggested">
          {shortcuts.map((s) => (
            <option key={`s-${s.value}`} value={s.value}>
              {s.label}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="All time zones">
        {list
          .filter((z) => !shortcutValues.has(z))
          .map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')} ({zoneAbbr(z)})
            </option>
          ))}
      </optgroup>
    </select>
  )
}
