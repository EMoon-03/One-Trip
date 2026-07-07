// Shapes mirror the backend's *Read / *Create models (app/models.py).
// Dates arrive as ISO strings over JSON.

export interface User {
  id: number
  email: string
  display_name: string
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

export interface PlaceResult {
  name: string
  address: string | null
  place_id: string
  lat: number
  lng: number
  provider: 'google' | 'nominatim'
}

export interface AppConfig {
  google_maps_browser_key: string | null
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
}

export interface TripCreate {
  name: string
  destination: string
  start_date: string
  end_date: string
  base_currency: string
  total_budget: number
  notes?: string | null
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

export interface Reminder {
  id: number
  trip_id: number
  activity_id: number | null
  message: string
  remind_at: string
  type: ReminderType
  status: ReminderStatus
}

export interface ReminderCreate {
  message: string
  remind_at: string
  type: ReminderType
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
