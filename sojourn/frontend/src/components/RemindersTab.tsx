import { useState } from 'react'
import {
  useCreateReminder,
  useDeleteReminder,
  useItinerary,
  useReminders,
  useSetReminderStatus,
} from '../api/hooks'
import type { Reminder, ReminderCreate, ReminderType, Trip } from '../api/types'
import { formatDateTime } from '../utils'

const TYPES: ReminderType[] = ['task', 'departure', 'budget']

function AddReminderForm({ trip }: { trip: Trip }) {
  const createReminder = useCreateReminder(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)

  const blank = () => ({
    message: '',
    remind_at: '',
    type: 'task' as ReminderType,
    activity_id: '',
  })
  const [form, setForm] = useState(blank())
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof ReturnType<typeof blank>>(key: K, value: ReturnType<typeof blank>[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = () => {
    setError(null)
    const body: ReminderCreate = {
      message: form.message,
      remind_at: form.remind_at,
      type: form.type,
      activity_id: form.activity_id ? Number(form.activity_id) : null,
    }
    createReminder.mutate(body, {
      onSuccess: () => setForm(blank()),
      onError: (e) => setError(e.message),
    })
  }

  return (
    <div className="card form-card">
      <h3 className="card-title">Set reminder</h3>
      <div className="form-grid">
        <label>
          Message
          <input
            value={form.message}
            onChange={(e) => set('message', e.target.value)}
            placeholder="Online check-in opens"
          />
        </label>
        <label>
          When
          <input
            type="datetime-local"
            value={form.remind_at}
            onChange={(e) => set('remind_at', e.target.value)}
          />
        </label>
        <label>
          Type
          <select value={form.type} onChange={(e) => set('type', e.target.value as ReminderType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tied to a stop (optional)
          <select value={form.activity_id} onChange={(e) => set('activity_id', e.target.value)}>
            <option value="">— none —</option>
            {itinerary.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!form.message || !form.remind_at || createReminder.isPending}
          onClick={submit}
        >
          Set reminder
        </button>
      </div>
    </div>
  )
}

export default function RemindersTab({ trip }: { trip: Trip }) {
  const { data: reminders = [], isLoading } = useReminders(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)
  const setStatus = useSetReminderStatus(trip.id)
  const deleteReminder = useDeleteReminder(trip.id)

  const stopById = new Map(itinerary.map((item) => [item.id, item]))
  const now = Date.now()

  const pending = reminders.filter((r) => r.status === 'pending')
  const dueNow = pending.filter((r) => new Date(r.remind_at).getTime() <= now)
  const upcoming = pending.filter((r) => new Date(r.remind_at).getTime() > now)
  const finished = reminders.filter((r) => r.status !== 'pending')

  const row = (reminder: Reminder, urgent = false) => {
    const stop = reminder.activity_id ? stopById.get(reminder.activity_id) : undefined
    return (
      <div key={reminder.id} className={urgent ? 'rem-row urgent' : 'rem-row'}>
        <div className="rem-main">
          <div className={reminder.status === 'pending' ? 'rem-msg' : 'rem-msg muted-line'}>
            {reminder.message}
          </div>
          <div className="rem-meta mono">
            {formatDateTime(reminder.remind_at)} · {reminder.type}
            {stop && <> · ↳ {stop.title}</>}
            {reminder.status === 'dismissed' && <> · dismissed</>}
          </div>
        </div>
        <div className="rem-actions">
          {reminder.status === 'pending' && (
            <>
              <button
                type="button"
                className="btn small"
                onClick={() => setStatus.mutate({ id: reminder.id, status: 'done' })}
              >
                Done
              </button>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setStatus.mutate({ id: reminder.id, status: 'dismissed' })}
              >
                Dismiss
              </button>
            </>
          )}
          <button
            type="button"
            className="btn icon"
            aria-label={`Delete reminder: ${reminder.message}`}
            onClick={() => deleteReminder.mutate(reminder.id)}
          >
            ✕
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-body">
      {isLoading && <p className="empty">Loading reminders…</p>}

      {!isLoading && reminders.length === 0 && (
        <div className="card empty-card">
          <h3>No reminders</h3>
          <p>Set one below so departures don't sneak up on you.</p>
        </div>
      )}

      {dueNow.length > 0 && (
        <div className="card">
          <h3 className="card-title">Due now</h3>
          {dueNow.map((r) => row(r, true))}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="card">
          <h3 className="card-title">Upcoming</h3>
          {upcoming.map((r) => row(r))}
        </div>
      )}

      {finished.length > 0 && (
        <div className="card">
          <h3 className="card-title">Done</h3>
          {finished.map((r) => row(r))}
        </div>
      )}

      <AddReminderForm trip={trip} />
    </div>
  )
}
