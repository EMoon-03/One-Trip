// Small shared UI pieces: a hand-drawn icon set (no icon library needed) and
// the "Add …" disclosure that keeps create-forms out of the way until asked for.

import { useState, type ReactNode } from 'react'
import type React from 'react'

const PATHS = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  back: 'M14.5 18l-6-6 6-6',
  edit: 'M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3M13.5 8.5l2 2',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9M10 20.5a2.2 2.2 0 0 0 4 0',
  // trip sections
  route: 'M4 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 18a2 2 0 1 0 4 0 2 2 0 1 0-4 0M8 6h7.5a3.5 3.5 0 0 1 0 7h-7a3.5 3.5 0 0 0 0 7H16',
  map: 'M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4zM9 4v13M15 7v13',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20V8H6.5A2.5 2.5 0 0 1 4 5.5M16 14h.01',
  // theme + menu
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  chevron: 'M6 9l6 6 6-6',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  pin: 'M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The One Trip mark: two stations joined by a line. */
export function BrandMark() {
  return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true" className="brand-mark">
      <line x1="5" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="2" />
      <circle cx="5" cy="6" r="4" fill="var(--page)" stroke="currentColor" strokeWidth="2" />
      <circle cx="21" cy="6" r="4" fill="currentColor" />
    </svg>
  )
}

/**
 * Shows an "Add …" button; clicking it reveals the form in a soft panel.
 * The form receives `close` so its own Close button can fold it back up.
 */
export function AddPanel({
  label,
  children,
}: {
  label: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" className="btn add-btn" onClick={() => setOpen(true)}>
        <Icon name="plus" size={15} />
        {label}
      </button>
    )
  }
  return (
    <section className="panel" aria-label={label}>
      {children(() => setOpen(false))}
    </section>
  )
}

/** Grey placeholder blocks while data loads (no spinner, no layout jump). */
export function Skeleton({ width = '100%', height = 14, radius = 4, style }: {
  width?: number | string
  height?: number | string
  radius?: number
  style?: React.CSSProperties
}) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="list-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="list-skeleton-row">
          <Skeleton width={38} height={14} />
          <div style={{ flex: 1 }}>
            <Skeleton width={`${70 - i * 9}%`} height={15} />
            <Skeleton width={`${40 - i * 4}%`} height={12} style={{ marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  )
}
