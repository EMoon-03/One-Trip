// Formatting helpers + the category "line colors" — every category keeps one
// color across the whole app (itinerary dots, chips, chart bars), like lines
// on a transit map.

export const CATEGORY_COLORS: Record<string, string> = {
  // itinerary categories
  flight: '#1c4fd8',
  lodging: '#7048e8',
  food: '#e8590c',
  activity: '#0f8a4c',
  transport: '#0e7c86',
  other: '#64707d',
  // expense categories that differ in name
  flights: '#1c4fd8',
  activities: '#0f8a4c',
  shopping: '#d6336c',
}

export const categoryColor = (category: string): string =>
  CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other

export function formatMoney(amount: number, currency: string): string {
  try {
    // Whole amounts drop the ".00" — "$3,000" reads cleaner than "$3,000.00".
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}` // unknown currency code
  }
}

/** '2026-10-01' -> 'Thu 1 Oct' (parsed as local, not UTC) */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

/** '2026-10-01T09:30:00' -> 'Thu 1 Oct, 09:30' */
export function formatDateTime(iso: string): string {
  const dt = new Date(iso)
  return dt.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** '09:30:00' -> '09:30' */
export const formatTime = (t: string | null): string => (t ? t.slice(0, 5) : '')

/** Day number within the trip, 1-based. */
export function dayNumber(tripStart: string, date: string): number {
  const [sy, sm, sd] = tripStart.split('-').map(Number)
  const [y, m, d] = date.split('-').map(Number)
  const ms = new Date(y, m - 1, d).getTime() - new Date(sy, sm - 1, sd).getTime()
  return Math.round(ms / 86_400_000) + 1
}

export const todayISO = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const parseISODate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 'flight' -> 'Flight' */
export const label = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** ('2026-11-10', '2026-11-15') -> 'Nov 10 – 15';  across months -> 'Nov 28 – Dec 3' */
export function formatRange(start: string, end: string): string {
  const s = parseISODate(start)
  const e = parseISODate(end)
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  const sameMonth = s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()
  return sameMonth
    ? `${month(s)} ${s.getDate()} – ${e.getDate()}`
    : `${month(s)} ${s.getDate()} – ${month(e)} ${e.getDate()}`
}

/** Days from today until an ISO date (negative once it has passed). */
export function daysUntil(iso: string): number {
  const ms = parseISODate(iso).getTime() - parseISODate(todayISO()).getTime()
  return Math.round(ms / 86_400_000)
}

/** 'In 21 days' · 'Tomorrow' · 'Happening now' · 'Finished' */
export function tripStatus(start: string, end: string): string {
  const until = daysUntil(start)
  if (until > 1) return `In ${until} days`
  if (until === 1) return 'Tomorrow'
  if (daysUntil(end) >= 0) return 'Happening now'
  return 'Finished'
}

/** Today's date ('YYYY-MM-DD') on the clock of a given zone — a trip's "today". */
export function todayInZone(zone: string): string {
  try {
    // en-CA formats dates as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return todayISO()
  }
}

/** Every date from start to end, inclusive. */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = []
  const d = parseISODate(start)
  const last = parseISODate(end)
  const pad = (n: number) => String(n).padStart(2, '0')
  while (d <= last && out.length < 366) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export type TripPhase = { kind: 'upcoming' | 'now' | 'past'; label: string; today: string }

/** Where a trip stands, judged on the trip's own calendar. */
export function tripPhase(trip: { start_date: string; end_date: string; timezone: string }): TripPhase {
  const today = todayInZone(trip.timezone)
  if (today < trip.start_date) {
    const days = dayNumber(today, trip.start_date) - 1
    return { kind: 'upcoming', label: days === 1 ? 'Tomorrow' : `In ${days} days`, today }
  }
  if (today > trip.end_date) return { kind: 'past', label: 'Finished', today }
  const n = dayNumber(trip.start_date, today)
  const total = dayNumber(trip.start_date, trip.end_date)
  return { kind: 'now', label: `Day ${n} of ${total}`, today }
}

/** 'Good morning' / 'Good afternoon' / 'Good evening' */
export function greeting(now = new Date()): string {
  const h = now.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** 'Tue' + '10' for the day strip. */
export function dayParts(iso: string): { weekday: string; day: number; month: string } {
  const d = parseISODate(iso)
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    day: d.getDate(),
    month: d.toLocaleDateString(undefined, { month: 'short' }),
  }
}
