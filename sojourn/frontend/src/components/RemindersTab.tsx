import { useState, type FormEvent } from 'react'
import {
  useCreateReminder,
  useDeleteReminder,
  useItinerary,
  useReminders,
  useSetReminderStatus,
  useUpdateReminder,
} from '../api/hooks'
import type { Delivery, ItineraryItem, Reminder, ReminderCreate, ReminderType, Trip } from '../api/types'
import {
  browserZone,
  differsFromBrowser,
  formatClockInZone,
  formatInZone,
  OFFSET_PRESETS,
  offsetLabel,
  zoneCity,
} from '../time'
import { label } from '../utils'
import { pendingKey, usePendingDeletes } from '../pendingDeletes'
import { useToast } from './Toast'
import { AddPanel, Icon, ListSkeleton } from './ui'
import ZoneSelect from './ZoneSelect'

const TYPES: ReminderType[] = ['task', 'departure', 'budget']

type Mode = 'time' | 'before'

const formFrom = (reminder?: Reminder) => ({
  message: reminder?.message ?? '',
  type: reminder?.type ?? ('task' as ReminderType),
  mode: (reminder?.offset_minutes != null ? 'before' : 'time') as Mode,
  // <input type="datetime-local"> wants 'YYYY-MM-DDTHH:mm' — the wall clock, not UTC
  local_time: reminder ? reminder.local_time.slice(0, 16) : '',
  timezone: reminder?.timezone ?? '', // '' = follow the trip's zone
  activity_id: reminder?.activity_id ? String(reminder.activity_id) : '',
  offset: String(reminder?.offset_minutes ?? 120),
})

/** Add a reminder (no `reminder`) or edit one. */
function ReminderForm({ trip, reminder, onClose }: { trip: Trip; reminder?: Reminder; onClose: () => void }) {
  const editing = reminder !== undefined
  const createReminder = useCreateReminder(trip.id)
  const updateReminder = useUpdateReminder(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)
  const timedStops = itinerary.filter((s) => s.start_time)

  const [form, setForm] = useState(() => formFrom(reminder))
  const [error, setError] = useState<string | null>(null)

  type Form = ReturnType<typeof formFrom>
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  const valid =
    form.message.trim() && (form.mode === 'time' ? form.local_time !== '' : form.activity_id !== '')
  const pending = createReminder.isPending || updateReminder.isPending

  const offsets = OFFSET_PRESETS.includes(Number(form.offset))
    ? OFFSET_PRESETS
    : [...OFFSET_PRESETS, Number(form.offset)].sort((a, b) => a - b)

  const switchMode = (mode: Mode) =>
    setForm((f) => ({
      ...f,
      mode,
      // "Before a stop" needs a stop with a time; pick the first one to start with.
      activity_id:
        mode === 'before' && !timedStops.some((s) => String(s.id) === f.activity_id)
          ? String(timedStops[0]?.id ?? '')
          : f.activity_id,
    }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    const body: ReminderCreate =
      form.mode === 'before'
        ? {
            message: form.message,
            type: form.type,
            activity_id: Number(form.activity_id),
            offset_minutes: Number(form.offset),
          }
        : {
            message: form.message,
            type: form.type,
            remind_at: form.local_time, // wall clock; the server reads it in `timezone`
            timezone: form.timezone || null,
            activity_id: form.activity_id ? Number(form.activity_id) : null,
          }
    const onError = (err: Error) => setError(err.message)
    if (editing) updateReminder.mutate({ id: reminder.id, body }, { onSuccess: onClose, onError })
    else createReminder.mutate(body, { onSuccess: () => setForm(formFrom()), onError })
  }

  const zoneShortcuts = [
    { value: '', label: `Trip time (${zoneCity(trip.timezone)})` },
    ...(browserZone() !== trip.timezone ? [{ value: browserZone(), label: `Your time (${zoneCity(browserZone())})` }] : []),
  ]

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h2 className="panel-title">{editing ? 'Edit reminder' : 'Add a reminder'}</h2>
      <div className="form-grid">
        <label className="field span-all">
          Remind me to
          <input
            value={form.message}
            onChange={(e) => set('message', e.target.value)}
            placeholder="Check in online for the flight"
            autoFocus
          />
        </label>

        <div className="field span-all">
          <span id="when-label">When</span>
          <div className="segmented" role="radiogroup" aria-labelledby="when-label">
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === 'time'}
              className={form.mode === 'time' ? 'active' : ''}
              onClick={() => switchMode('time')}
            >
              At a set time
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={form.mode === 'before'}
              className={form.mode === 'before' ? 'active' : ''}
              onClick={() => switchMode('before')}
              disabled={timedStops.length === 0}
              title={timedStops.length === 0 ? 'Add a stop with a start time first' : undefined}
            >
              Before a stop
            </button>
          </div>
        </div>

        {form.mode === 'time' ? (
          <>
            <label className="field">
              Date and time
              <input
                type="datetime-local"
                value={form.local_time}
                onChange={(e) => set('local_time', e.target.value)}
              />
            </label>
            <label className="field">
              Time zone
              <ZoneSelect
                value={form.timezone}
                onChange={(zone) => set('timezone', zone === trip.timezone ? '' : zone)}
                shortcuts={zoneShortcuts}
              />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              How long before
              <select value={form.offset} onChange={(e) => set('offset', e.target.value)}>
                {offsets.map((m) => (
                  <option key={m} value={m}>
                    {offsetLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Which stop
              <select value={form.activity_id} onChange={(e) => set('activity_id', e.target.value)}>
                {timedStops.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <label className="field">
          Type
          <select value={form.type} onChange={(e) => set('type', e.target.value as ReminderType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </select>
        </label>

        {form.mode === 'time' && (
          <label className="field">
            <span>
              For a stop <span className="hint">optional</span>
            </span>
            <select value={form.activity_id} onChange={(e) => set('activity_id', e.target.value)}>
              <option value="">None</option>
              {itinerary.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {form.mode === 'before' && (
        <p className="form-note">If the stop's time changes, this reminder moves with it.</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {editing ? 'Save changes' : 'Add reminder'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {editing ? 'Cancel' : 'Close'}
        </button>
      </div>
    </form>
  )
}

const CHANNEL_NAMES: Record<string, string> = { email: 'email', push: 'browser notification', console: 'server log' }

const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/**
 * One line about what the worker did with this reminder, or nothing if it
 * hasn't come due yet. The server log only counts when it's all there is.
 */
function deliverySummary(deliveries: Delivery[]): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } | null {
  const real = deliveries.filter((d) => d.channel !== 'console')
  const list = real.length > 0 ? real : deliveries
  if (list.length === 0) return null

  const failed = list.filter((d) => d.status === 'failed')
  const retrying = list.filter((d) => d.status === 'pending' && d.attempts > 0)
  const sent = list.filter((d) => d.status === 'sent')
  const skipped = list.filter((d) => d.status === 'skipped')

  if (failed.length > 0)
    return { text: `Couldn't send by ${joinNames(failed.map((d) => CHANNEL_NAMES[d.channel] ?? d.channel))}: ${failed[0].last_error}`, tone: 'bad' }
  if (retrying.length > 0)
    return { text: `Retrying ${joinNames(retrying.map((d) => CHANNEL_NAMES[d.channel] ?? d.channel))} (${retrying[0].last_error})`, tone: 'warn' }
  if (sent.length > 0) return { text: `Sent by ${joinNames(sent.map((d) => CHANNEL_NAMES[d.channel] ?? d.channel))}`, tone: 'ok' }
  if (skipped.length > 0) return { text: `Not sent: ${skipped[0].last_error}`, tone: 'muted' }
  return { text: 'Sending…', tone: 'muted' }
}

function WhenText({ reminder, stop }: { reminder: Reminder; stop?: ItineraryItem }) {
  const zone = reminder.effective_timezone
  const showZone = differsFromBrowser(zone, new Date(reminder.remind_at))
  return (
    <>
      <span className="rem-when">
        {formatInZone(reminder.remind_at, zone)}
        {showZone && ` ${zoneCity(zone)}`}
      </span>
      {showZone && <span className="rem-yours">{formatClockInZone(reminder.remind_at, browserZone())} your time</span>}
      {reminder.offset_minutes != null && stop && (
        <span>
          {offsetLabel(reminder.offset_minutes)} {stop.title}
        </span>
      )}
    </>
  )
}

export default function RemindersTab({ trip }: { trip: Trip }) {
  const { data: allReminders = [], isLoading } = useReminders(trip.id)
  const { undoableDelete } = useToast()
  const pendingDeletes = usePendingDeletes()
  const reminders = allReminders.filter((r) => !pendingDeletes.has(pendingKey('reminder', r.id)))
  const { data: itinerary = [] } = useItinerary(trip.id)
  const setStatus = useSetReminderStatus(trip.id)
  const deleteReminder = useDeleteReminder(trip.id)
  const [editingId, setEditingId] = useState<number | null>(null)

  const stopById = new Map(itinerary.map((item) => [item.id, item]))
  const now = Date.now()

  const pending = reminders.filter((r) => r.status === 'pending')
  const dueNow = pending.filter((r) => new Date(r.remind_at).getTime() <= now)
  const upcoming = pending.filter((r) => new Date(r.remind_at).getTime() > now)
  const finished = reminders.filter((r) => r.status !== 'pending')

  const row = (reminder: Reminder, urgent = false) => {
    if (editingId === reminder.id) {
      return (
        <li key={reminder.id} className="list-row is-editing">
          <div className="panel">
            <ReminderForm trip={trip} reminder={reminder} onClose={() => setEditingId(null)} />
          </div>
        </li>
      )
    }
    const stop = reminder.activity_id ? stopById.get(reminder.activity_id) : undefined
    const isPending = reminder.status === 'pending'
    const delivery = deliverySummary(reminder.deliveries)
    const classes = ['list-row', 'rem-row', urgent && 'is-urgent', !isPending && 'is-finished']
      .filter(Boolean)
      .join(' ')

    return (
      <li key={reminder.id} className={classes}>
        {isPending ? (
          <button
            type="button"
            className={urgent ? 'check-btn urgent' : 'check-btn'}
            aria-label={`Mark done: ${reminder.message}`}
            title="Mark done"
            onClick={() => setStatus.mutate({ id: reminder.id, status: 'done' })}
          >
            <Icon name="check" size={13} />
          </button>
        ) : (
          // Clicking a finished reminder's check puts it back to pending (undo).
          <button
            type="button"
            className={reminder.status === 'done' ? 'check-btn is-done' : 'check-btn is-dismissed'}
            aria-label={`Reopen: ${reminder.message}`}
            title="Reopen"
            onClick={() => setStatus.mutate({ id: reminder.id, status: 'pending' })}
          >
            {reminder.status === 'done' && <Icon name="check" size={13} />}
          </button>
        )}

        <div className="row-main">
          <p className="row-title">{reminder.message}</p>
          <p className="row-sub">
            <WhenText reminder={reminder} stop={stop} />
            <span>{label(reminder.type)}</span>
            {stop && reminder.offset_minutes == null && <span>For {stop.title}</span>}
            {reminder.status === 'dismissed' && <span>Dismissed</span>}
          </p>
          {delivery && <p className={`rem-delivery tone-${delivery.tone}`}>{delivery.text}</p>}
        </div>

        <div className="row-actions">
          {isPending && (
            <button
              type="button"
              className="btn-text"
              onClick={() => setStatus.mutate({ id: reminder.id, status: 'dismissed' })}
            >
              Dismiss
            </button>
          )}
          <button
            type="button"
            className="icon-btn edit"
            aria-label={`Edit reminder: ${reminder.message}`}
            title="Edit reminder"
            onClick={() => setEditingId(reminder.id)}
          >
            <Icon name="edit" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete reminder: ${reminder.message}`}
            title="Delete reminder"
            onClick={() =>
              undoableDelete({
                key: pendingKey('reminder', reminder.id),
                label: reminder.message,
                commit: () => deleteReminder.mutate(reminder.id),
              })
            }
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </li>
    )
  }

  const group = (title: string, list: Reminder[], urgent = false) =>
    list.length > 0 && (
      <section>
        <h2 className="section-title">
          {title}
          <span className="count">{list.length}</span>
        </h2>
        <ul className="list">{list.map((r) => row(r, urgent))}</ul>
      </section>
    )

  return (
    <div className="tab-body">
      {isLoading && <ListSkeleton rows={4} />}

      {!isLoading && reminders.length === 0 && (
        <div className="empty-state" style={{ paddingBottom: 0 }}>
          <h3>No reminders yet</h3>
          <p>Add one for anything time-sensitive, like online check-in or a reservation to confirm.</p>
        </div>
      )}

      {group('Due now', dueNow, true)}
      {group('Upcoming', upcoming)}
      {group('Done', finished)}

      <AddPanel label="Add reminder">{(close) => <ReminderForm trip={trip} onClose={close} />}</AddPanel>
    </div>
  )
}
