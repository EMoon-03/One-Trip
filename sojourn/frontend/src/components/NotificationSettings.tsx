// "How should reminders reach me?" — lives inside the bell panel.
//
// The bell itself only works while One Trip is open. Email and browser
// notifications are delivered by the backend worker, so they reach you with
// the app closed.

import { useEffect, useState } from 'react'
import { useNotificationConfig, useSendTestNotification, useUpdateMe } from '../api/hooks'
import { disablePush, enablePush, pushState, type PushState } from '../push'
import { useQueryClient } from '@tanstack/react-query'
import { qk } from '../api/hooks'
import { Icon } from './ui'

export default function NotificationSettings() {
  const { data: config, isLoading } = useNotificationConfig()
  const updateMe = useUpdateMe()
  const sendTest = useSendTestNotification()
  const qc = useQueryClient()

  // The switch's new position, held locally from the click until the save
  // settles. (Query state updates a tick later; without this the controlled
  // checkbox snaps back for a frame.)
  const [emailDraft, setEmailDraft] = useState<boolean | null>(null)
  const [push, setPush] = useState<PushState | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  useEffect(() => {
    pushState().then(setPush).catch(() => setPush('unsupported'))
  }, [])

  const togglePush = async () => {
    if (!config?.push.public_key) return
    setPushBusy(true)
    setPushError(null)
    try {
      if (push === 'on') await disablePush()
      else await enablePush(config.push.public_key)
      setPush(await pushState())
      qc.invalidateQueries({ queryKey: qk.notifications })
    } catch (err) {
      setPushError((err as Error).message)
      setPush(await pushState().catch(() => 'unsupported' as PushState))
    } finally {
      setPushBusy(false)
    }
  }

  if (isLoading || !config) return <p className="empty notif">Loading…</p>

  const pushHint = !config.push.available
    ? "Browser notifications aren't set up on this server yet."
    : push === 'unsupported'
      ? "This browser can't show notifications from websites."
      : push === 'denied'
        ? 'Blocked for this site. Allow notifications in your browser settings to turn this on.'
        : push === 'on'
          ? 'This browser will notify you, even with One Trip closed.'
          : 'Get a notification on this device, even with One Trip closed.'

  return (
    <div className="notif">
      <div className="notif-row">
        <div>
          <strong>Email</strong>
          <p>
            {config.email.available
              ? `Send reminders to ${config.email.address}.`
              : "Email isn't set up on this server yet."}
          </p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            aria-label="Email reminders"
            checked={config.email.available && (emailDraft ?? config.email.enabled)}
            disabled={!config.email.available}
            onChange={(e) => {
              const on = e.target.checked
              setEmailDraft(on)
              updateMe.mutate({ email_notifications: on }, { onSettled: () => setEmailDraft(null) })
            }}
          />
          <span />
        </label>
      </div>

      <div className="notif-row">
        <div>
          <strong>This browser</strong>
          <p>{pushHint}</p>
          {pushError && <p className="tone-bad">{pushError}</p>}
        </div>
        {config.push.available && (push === 'on' || push === 'off') && (
          <button type="button" className="btn" onClick={togglePush} disabled={pushBusy}>
            {pushBusy ? '…' : push === 'on' ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      <div className="notif-row">
        <div>
          <strong>Check it works</strong>
          <p>Sends a test right now through everything that's switched on.</p>
          {sendTest.data && (
            <ul className="notif-results">
              {sendTest.data.length === 0 && <li className="tone-muted">Nothing is switched on yet.</li>}
              {sendTest.data.map((r) => (
                <li key={r.channel} className={r.ok ? 'tone-ok' : 'tone-bad'}>
                  <Icon name={r.ok ? 'check' : 'x'} size={14} />
                  <span>
                    {r.channel === 'push' ? 'Browser' : r.channel === 'console' ? 'Server log' : 'Email'}: {r.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {sendTest.error && <p className="tone-bad">{sendTest.error.message}</p>}
        </div>
        <button type="button" className="btn" onClick={() => sendTest.mutate()} disabled={sendTest.isPending}>
          {sendTest.isPending ? 'Sending…' : 'Send test'}
        </button>
      </div>
    </div>
  )
}
