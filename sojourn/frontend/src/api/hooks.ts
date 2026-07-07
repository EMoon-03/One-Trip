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
  ItineraryItem,
  ItineraryItemCreate,
  PlaceResult,
  Reminder,
  ReminderCreate,
  ReminderStatus,
  Trip,
  TripCreate,
  TripSummary,
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
}

// ---------------------------------------------------------------- meta ----

export const useConfig = () =>
  useQuery({
    queryKey: qk.config,
    queryFn: () => api.get<AppConfig>('/api/config'),
    staleTime: Infinity, // server config doesn't change mid-session
  })

/** Location search against /api/places/search (Google or OSM, server decides). */
export const usePlaceSearch = (query: string) =>
  useQuery({
    queryKey: qk.places(query),
    queryFn: () => api.get<PlaceResult[]>(`/api/places/search?q=${encodeURIComponent(query)}`),
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
