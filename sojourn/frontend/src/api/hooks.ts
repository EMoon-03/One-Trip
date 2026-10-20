// TanStack Query hooks. The invalidation lists are the interesting part:
// they encode which views a mutation can affect. Example: creating an
// expense must refresh the expense list AND the summary (charts, budget bar).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type {
  AppConfig,
  DueReminder,
  Expense,
  ExpenseCreate,
  ExpenseUpdate,
  ItineraryItem,
  ItineraryItemCreate,
  ItineraryItemUpdate,
  NotificationConfig,
  NotificationTestResult,
  PlaceDetails,
  PlaceResult,
  Reminder,
  ReminderCreate,
  ReminderStatus,
  ReminderUpdate,
  Trip,
  TripCreate,
  TripSummary,
  TripUpdate,
  User,
} from './types'

export const qk = {
  trips: ['trips'] as const,
  trip: (id: number) => ['trips', id] as const,
  itinerary: (id: number) => ['trips', id, 'itinerary'] as const,
  expenses: (id: number) => ['trips', id, 'expenses'] as const,
  summary: (id: number) => ['trips', id, 'summary'] as const,
  reminders: (id: number) => ['trips', id, 'reminders'] as const,
  due: ['reminders', 'due'] as const,
  config: ['config'] as const,
  places: (q: string) => ['places', q] as const,
  notifications: ['notifications', 'config'] as const,
}

// ---------------------------------------------------------------- meta ----

export const useConfig = () =>
  useQuery({
    queryKey: qk.config,
    queryFn: () => api.get<AppConfig>('/api/config'),
    staleTime: Infinity, // server config doesn't change mid-session
  })

/** Location search against /api/places/search (Google or OSM, server decides). */
/**
 * Location search against /api/places/search (Google or OSM, server decides).
 * `session` groups a burst of typing into one Google billing session; it's
 * not part of the cache key, so a repeated query is still served from cache.
 */
export const usePlaceSearch = (query: string, session: string) =>
  useQuery({
    queryKey: qk.places(query),
    queryFn: () =>
      api.get<PlaceResult[]>(
        `/api/places/search?q=${encodeURIComponent(query)}&session=${encodeURIComponent(session)}`,
      ),
    enabled: query.trim().length >= 3,
    staleTime: 60_000,
    retry: false, // a geocoder hiccup shouldn't hammer the free OSM endpoint
  })

// ---------------------------------------------------------------- trips ---

export const useTrips = () =>
  useQuery({ queryKey: qk.trips, queryFn: () => api.get<Trip[]>('/api/trips') })

export const useTrip = (id: number) =>
  useQuery({ queryKey: qk.trip(id), queryFn: () => api.get<Trip>(`/api/trips/${id}`) })

export const useSummary = (id: number) =>
  useQuery({
    queryKey: qk.summary(id),
    queryFn: () => api.get<TripSummary>(`/api/trips/${id}/summary`),
  })

export function useCreateTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TripCreate) => api.post<Trip>('/api/trips', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.trips }),
  })
}

export function useUpdateTrip(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TripUpdate) => api.patch<Trip>(`/api/trips/${id}`, body),
    onSuccess: () => {
      // ['trips'] is a prefix of every per-trip key, so this refreshes the
      // list, the trip itself and its summary (the budget may have changed).
      qc.invalidateQueries({ queryKey: qk.trips })
      qc.invalidateQueries({ queryKey: qk.due }) // due rows show the trip name
    },
  })
}

export function useDeleteTrip() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/trips/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.trips })
      qc.invalidateQueries({ queryKey: qk.due })
    },
  })
}

// ------------------------------------------------------------ itinerary ---

export const useItinerary = (tripId: number) =>
  useQuery({
    queryKey: qk.itinerary(tripId),
    queryFn: () => api.get<ItineraryItem[]>(`/api/trips/${tripId}/itinerary`),
  })

export function useCreateItem(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ItineraryItemCreate) =>
      api.post<ItineraryItem>(`/api/trips/${tripId}/itinerary`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.itinerary(tripId) }),
  })
}

export function useUpdateItem(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ItineraryItemUpdate }) =>
      api.patch<ItineraryItem>(`/api/itinerary/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.itinerary(tripId) })
      // moving a stop moves the reminders that count back from it
      qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
      qc.invalidateQueries({ queryKey: qk.due })
    },
  })
}

export function useDeleteItem(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (itemId: number) => api.del(`/api/itinerary/${itemId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.itinerary(tripId) })
      // deleting a stop clears activity links on expenses & reminders:
      qc.invalidateQueries({ queryKey: qk.expenses(tripId) })
      qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
    },
  })
}

// ------------------------------------------------------------- expenses ---

export const useExpenses = (tripId: number) =>
  useQuery({
    queryKey: qk.expenses(tripId),
    queryFn: () => api.get<Expense[]>(`/api/trips/${tripId}/expenses`),
  })

export function useCreateExpense(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ExpenseCreate) =>
      api.post<Expense>(`/api/trips/${tripId}/expenses`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.expenses(tripId) })
      qc.invalidateQueries({ queryKey: qk.summary(tripId) })
    },
  })
}

export function useUpdateExpense(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ExpenseUpdate }) =>
      api.patch<Expense>(`/api/expenses/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.expenses(tripId) })
      qc.invalidateQueries({ queryKey: qk.summary(tripId) })
    },
  })
}

export function useDeleteExpense(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (expenseId: number) => api.del(`/api/expenses/${expenseId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.expenses(tripId) })
      qc.invalidateQueries({ queryKey: qk.summary(tripId) })
    },
  })
}

// ------------------------------------------------------------ reminders ---

export const useReminders = (tripId: number) =>
  useQuery({
    queryKey: qk.reminders(tripId),
    queryFn: () => api.get<Reminder[]>(`/api/trips/${tripId}/reminders`),
  })

// The in-app "inbox": poll once a minute so due reminders surface while
// the app is open. (The push-notification upgrade replaces this poll.)
export const useDueReminders = () =>
  useQuery({
    queryKey: qk.due,
    queryFn: () => api.get<DueReminder[]>('/api/reminders/due'),
    refetchInterval: 60_000,
  })

export function useCreateReminder(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ReminderCreate) =>
      api.post<Reminder>(`/api/trips/${tripId}/reminders`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
      qc.invalidateQueries({ queryKey: qk.due })
    },
  })
}

export function useUpdateReminder(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ReminderUpdate }) =>
      api.patch<Reminder>(`/api/reminders/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
      qc.invalidateQueries({ queryKey: qk.due }) // a new time may make it due (or not)
    },
  })
}

export function useSetReminderStatus(tripId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: ReminderStatus }) =>
      api.patch<Reminder>(`/api/reminders/${id}`, { status }),
    onSuccess: () => {
      if (tripId !== undefined) qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
      else qc.invalidateQueries({ queryKey: qk.trips }) // badge used outside a trip
      qc.invalidateQueries({ queryKey: qk.due })
    },
  })
}

export function useDeleteReminder(tripId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reminderId: number) => api.del(`/api/reminders/${reminderId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reminders(tripId) })
      qc.invalidateQueries({ queryKey: qk.due })
    },
  })
}

// -------------------------------------------------------- notifications ---

export const useNotificationConfig = () =>
  useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.get<NotificationConfig>('/api/notifications/config'),
  })

/** Profile + preferences (email reminders on/off). */
export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<Pick<User, 'display_name' | 'email_notifications'>>) =>
      api.patch<User>('/api/auth/me', body),
    // Return the promise so the mutation stays "pending" until the config has
    // reloaded — no flicker back to the old value in between.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  })
}

export function useSendTestNotification() {
  return useMutation({
    mutationFn: () => api.post<NotificationTestResult[]>('/api/notifications/test'),
  })
}

// ---------------------------------------------------------------- places ---
// Plain functions (not hooks): they're called once, in response to a pick.

/** Coordinates for a picked Google result; ends the autocomplete session. */
export const fetchPlaceDetails = (placeId: string, session: string) =>
  api.get<PlaceDetails>(
    `/api/places/details?place_id=${encodeURIComponent(placeId)}&session=${encodeURIComponent(session)}`,
  )

/** IANA zone for a point (Google Time Zone API, or offline on the server). */
export const fetchTimezone = (lat: number, lng: number) =>
  api.get<{ timezone: string; source: 'google' | 'offline' }>(`/api/places/timezone?lat=${lat}&lng=${lng}`)
