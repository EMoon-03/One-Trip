// Deletes that are waiting out their "Undo" window.
//
// Deleting something hides it at once and shows an Undo toast; the real
// DELETE request goes out only when the window closes. Lists filter these ids
// out, so a background refetch during the window can't make the item pop back.
// (If the tab is closed inside the window, nothing is deleted: the safe side.)

import { useSyncExternalStore } from 'react'

const pending = new Set<string>()
const listeners = new Set<() => void>()
let snapshot: ReadonlySet<string> = new Set()

const emit = () => {
  snapshot = new Set(pending)
  listeners.forEach((l) => l())
}

export const pendingKey = (kind: 'stop' | 'expense' | 'reminder', id: number) => `${kind}:${id}`

export function markPending(key: string) {
  pending.add(key)
  emit()
}

export function clearPending(key: string) {
  pending.delete(key)
  emit()
}

export function usePendingDeletes(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot,
  )
}
