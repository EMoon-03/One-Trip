// The trip at a glance, as a strip of days — the route line turned sideways.
// Each day is a column; each stop is a dot in its category color, in order.
// On the trip page it doubles as navigation: click a day to jump to it.

import type { CSSProperties } from 'react'
import type { ItineraryItem, Trip } from '../api/types'
import { categoryColor, dayParts, eachDate, label } from '../utils'

export default function DayStrip({
  trip,
  items,
  today,
  onSelect,
  compact = false,
}: {
  trip: Trip
  items: ItineraryItem[]
  today?: string
  onSelect?: (date: string) => void
  compact?: boolean
}) {
  const days = eachDate(trip.start_date, trip.end_date)
  const byDay = new Map<string, ItineraryItem[]>()
  for (const item of items) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item])

  return (
    <ol className={compact ? 'daystrip compact' : 'daystrip'} aria-label="Days of the trip">
      {days.map((date, i) => {
        const stops = byDay.get(date) ?? []
        const { weekday, day } = dayParts(date)
        const isToday = date === today
        const summary =
          stops.length === 0
            ? 'nothing planned'
            : `${stops.length} stop${stops.length === 1 ? '' : 's'}: ${stops.map((s) => s.title).join(', ')}`
        const content = (
          <>
            <span className="ds-label">
              {compact ? (
                <span className="ds-num">{i + 1}</span>
              ) : (
                <>
                  <span className="ds-weekday">{isToday ? 'Today' : weekday}</span>
                  <span className="ds-day">{day}</span>
                </>
              )}
            </span>
            <span className="ds-dots" aria-hidden="true">
              {stops.length === 0 ? (
                <span className="ds-dot is-hollow" />
              ) : (
                stops.slice(0, 6).map((s) => (
                  <span key={s.id} className="ds-dot" style={{ '--c': categoryColor(s.category) } as CSSProperties} title={`${s.title} (${label(s.category)})`} />
                ))
              )}
              {stops.length > 6 && <span className="ds-more">+{stops.length - 6}</span>}
            </span>
          </>
        )
        return (
          <li key={date} className={`ds-day-col${isToday ? ' is-today' : ''}${stops.length === 0 ? ' is-empty' : ''}`}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(date)} aria-label={`Day ${i + 1}, ${weekday} ${day}: ${summary}`}>
                {content}
              </button>
            ) : (
              <div aria-label={`Day ${i + 1}: ${summary}`}>{content}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
