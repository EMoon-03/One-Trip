// A real confirmation dialog instead of window.confirm(). Built on <dialog>
// with showModal(), so focus is trapped and Escape cancels for free.

import { useEffect, useRef, type ReactNode } from 'react'

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children?: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault() // Escape: let React state close it
        onCancel()
      }}
      onClick={(e) => e.target === ref.current && onCancel()} // click on the backdrop
    >
      <h2 id="dialog-title" className="dialog-title">
        {title}
      </h2>
      {children && <div className="dialog-body">{children}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
