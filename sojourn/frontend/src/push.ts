// Browser side of Web Push.
//
//   enablePush(publicKey)  ask permission -> register /sw.js -> subscribe with
//                          the server's VAPID public key -> send the
//                          subscription to the API so the worker can use it
//   disablePush()          tell the API to forget this browser, then unsubscribe
//   pushState()            what the settings panel should show
//
// Push needs a secure context: https in production, or http://localhost in dev.

import { api } from './api/client'

export type PushState = 'unsupported' | 'denied' | 'off' | 'on'

export const pushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

async function existingSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/')
  return reg ? reg.pushManager.getSubscription() : null
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return (await existingSubscription()) ? 'on' : 'off'
}

/** The VAPID public key arrives base64url-encoded; the browser wants raw bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.byteLength) return false
  const view = new Uint8Array(a)
  return view.every((v, i) => v === b[i])
}

export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("This browser can't show notifications from websites.")
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
        : 'Notifications were not allowed.',
    )
  }

  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const key = keyBytes(publicKey)

  let sub = await reg.pushManager.getSubscription()
  // The server's keys changed since this browser subscribed: the old
  // subscription can never be used again, so replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    } catch (err) {
      // e.g. the browser's push service is unreachable, or (Brave) push is off in its settings
      throw new Error(`This browser couldn't sign up for notifications (${(err as Error).message}).`)
    }
  }

  await api.post('/api/notifications/push-subscriptions', sub.toJSON())
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return
  const sub = await existingSubscription()
  if (!sub) return
  try {
    await api.del(`/api/notifications/push-subscriptions?endpoint=${encodeURIComponent(sub.endpoint)}`)
  } finally {
    await sub.unsubscribe() // stop locally even if the server call failed
  }
}
