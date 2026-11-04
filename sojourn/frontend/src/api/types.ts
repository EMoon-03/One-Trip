// Shapes mirror the backend's *Read / *Create models (app/models.py).
// Dates arrive as ISO strings over JSON.

export interface User {
  id: number
  email: string
  display_name: string
  email_notifications: boolean
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user: User
}

export interface RegisterPayload {
  email: string
  display_name: string
  password: string
}

/**
 * A search result. Google results arrive WITHOUT coordinates (lat/lng null):
 * they're fetched with /api/places/details when the person picks one, which
 * also closes the Google billing session. OpenStreetMap results include them.
 */
export interface PlaceResult {
  name: string
  address: string | null
  label: string // short form for a destination field: "Tokyo, Japan"
  place_id: string
  lat: number | null
  lng: number | null
  provider: 'google' | 'nominatim'
}

export interface PlaceDetails {
  place_id: string
  lat: number
  lng: number
  address: string | null
  provider: 'google'
}

export interface AppConfig {
  google_maps_browser_key: string | null
  place_search: 'google' | 'nominatim' | 'unavailable'
}

export type ItineraryCategory =
  | 'flight'
  | 'lodging'
  | 'food'
  | 'activity'
  | 'transport'
  | 'other'

export type ExpenseCategory =
  | 'flights'
  | 'lodging'
  | 'food'
  | 'activities'
  | 'transport'
  | 'shopping'
  | 'other'

export type ReminderType = 'task' | 'departure' | 'budget'
export type ReminderStatus = 'pending' | 'done' | 'dismissed'

export interface Trip {
  id: number
  name: string
  destination: string
  start_date: string
  end_date: string
  base_currency: string
  total_budget: number
  notes: string | null
  timezone: string // IANA zone of the destination, e.g. "Asia/Tokyo"
}

export interface TripCreate {
  name: string
  destination: string
  start_date: string
  end_date: string
  base_currency: string
  total_budget: number
  notes?: string | null
  timezone: string
}

export interface ItineraryItem {
  id: number
  trip_id: number
  date: string
  start_time: string | null
  end_time: string | null
  title: string
  category: ItineraryCategory
  location_name: string | null
  place_id: string | null
  lat: number | null
  lng: number | null
  notes: string | null
  timezone: string | null // null = the trip's zone
  coords_source: 'google' | 'nominatim' | 'manual' | null // set by the server
  coords_fetched_at: string | null
}

export interface ItineraryItemCreate {
  date: string
  start_time?: string | null
  end_time?: string | null
  title: string
  category: ItineraryCategory
  location_name?: string | null
  place_id?: string | null
  lat?: number | null
  lng?: number | null
  notes?: string | null
  timezone?: string | null
}

export interface Expense {
  id: number
  trip_id: number
  activity_id: number | null
  description: string
  amount: number
  currency: string
  category: ExpenseCategory
  spend_date: string
  is_planned: boolean
}

export interface ExpenseCreate {
  description: string
  amount: number
  category: ExpenseCategory
  spend_date: string
  is_planned: boolean
  activity_id?: number | null
  currency?: string | null
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface Delivery {
  channel: 'email' | 'push' | 'console' | string
  status: DeliveryStatus
  attempts: number
  sent_at: string | null
  last_error: string | null
}

export interface Reminder {
  id: number
  trip_id: number
  activity_id: number | null
  message: string
  type: ReminderType
  status: ReminderStatus
  remind_at: string            // the UTC moment, e.g. "2026-11-09T01:30:00Z"
  local_time: string           // wall clock in effective_timezone, "2026-11-09T10:30:00"
  timezone: string | null      // chosen zone; null = follow the trip
  effective_timezone: string
  offset_minutes: number | null // set = "N minutes before the linked stop"
  dispatched_at: string | null
  deliveries: Delivery[]
}

/** Either { remind_at (+ timezone) } or { offset_minutes + activity_id }. */
export interface ReminderCreate {
  message: string
  type: ReminderType
  remind_at?: string | null
  timezone?: string | null
  offset_minutes?: number | null
  activity_id?: number | null
}

export interface DueReminder extends Reminder {
  trip_name: string
}

export interface CategoryBreakdown {
  category: ExpenseCategory
  spent: number
  planned: number
}

export interface DailySpend {
  date: string
  amount: number
  cumulative: number
}

export interface TripSummary {
  trip_id: number
  total_budget: number
  total_spent: number
  total_planned: number
  remaining: number
  pct_used: number
  by_category: CategoryBreakdown[]
  daily_spend: DailySpend[]
}

// PATCH bodies: every field optional; sending null clears a nullable field.
export type TripUpdate = Partial<TripCreate>
export type ItineraryItemUpdate = Partial<ItineraryItemCreate>
export type ExpenseUpdate = Partial<ExpenseCreate>
export type ReminderUpdate = Partial<ReminderCreate> & { status?: ReminderStatus }

export interface NotificationConfig {
  email: { available: boolean; enabled: boolean; address: string }
  push: { available: boolean; public_key: string | null; devices: number }
  console: boolean
}

export interface NotificationTestResult {
  channel: string
  ok: boolean
  detail: string
}
