// Time-zone helpers for the UI. The server sends two things per reminder:
// `remind_at` (the UTC moment) and `effective_timezone` (the zone a person
// meant it in). We always format the moment IN that zone, so "10:30 AM
// Tokyo" reads the same on a laptop in New Jersey and a phone in Shibuya.

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const FALLBACK_ZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
]

/** Every IANA zone the browser knows, UTC first. */
export function allZones(): string[] {
  const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_ZONES
  return ['UTC', ...list.filter((z) => z !== 'UTC')]
}

/** 'America/New_York' -> 'New York';  'UTC' -> 'UTC' */
export const zoneCity = (zone: string): string =>
  zone.includes('/') ? zone.slice(zone.lastIndexOf('/') + 1).replace(/_/g, ' ') : zone

/** Short zone name at a moment: 'EST', 'GMT+9', 'UTC'. */
export function zoneAbbr(zone: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')
  return part?.value ?? zone
}

/** A UTC moment shown in a zone: 'Mon, Nov 9, 10:30 AM'. */
export function formatInZone(iso: string, zone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Just the clock: '8:30 PM'. */
export const formatClockInZone = (iso: string, zone: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' })

/** Is this zone's clock different from the viewer's right now? */
export function differsFromBrowser(zone: string, at: Date = new Date()): boolean {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', day: 'numeric' }).format(at)
  return fmt(zone) !== fmt(browserZone())
}

/** 180 -> '3 hours before';  1440 -> '1 day before';  45 -> '45 min before' */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'When it starts'
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min before`
  return `${minutes} min before`
}

export const OFFSET_PRESETS = [0, 15, 30, 60, 120, 180, 360, 720, 1440, 2880]
