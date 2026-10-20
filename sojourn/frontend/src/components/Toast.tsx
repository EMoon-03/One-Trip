// Small, temporary messages at the bottom of the screen. The one that
// matters most: "Deleted 'Hotel, 5 nights' · Undo".

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { clearPending, markPending } from '../pendingDeletes'
import { Icon } from './ui'

interface ToastInput {
  message: string
  action?: { label: string; onClick: () => void }
  tone?: 'neutral' | 'error'
  duration?: number
}

interface ToastItem extends ToastInput {
  id: number
}

interface ToastApi {
  toast: (t: ToastInput) => void
  /** Hide now, delete after the undo window unless Undo is pressed. */
  undoableDelete: (opts: { key: string; label: string; commit: () => void; seconds?: number }) => void
}

const ToastContext = createContext<ToastApi | null>(null)

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
  }, [])

  const toast = useCallback(
    (t: ToastInput) => {
      const id = nextId++
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]) // at most 3 on screen
      timers.current.set(id, setTimeout(() => dismiss(id), t.duration ?? 4000))
    },
    [dismiss],
  )

  const undoableDelete = useCallback<ToastApi['undoableDelete']>(
    ({ key, label, commit, seconds = 5 }) => {
      markPending(key)
      let undone = false
      const timer = setTimeout(() => {
        if (!undone) commit()
        // keep it hidden until the list refetches without it
        setTimeout(() => clearPending(key), 1500)
      }, seconds * 1000)
      toast({
        message: `Deleted “${label}”`,
        duration: seconds * 1000,
        action: {
          label: 'Undo',
          onClick: () => {
            undone = true
            clearTimeout(timer)
            clearPending(key)
          },
        },
      })
    },
    [toast],
  )

  return (
    <ToastContext.Provider value={{ toast, undoableDelete }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  return (
    <div className={`toast${item.tone === 'error' ? ' error' : ''}`}>
      <span>{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action!.onClick()
            onDismiss()
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
