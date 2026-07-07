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
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
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
    hour: '2-digit',
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
