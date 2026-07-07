import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useDueReminders, useSetReminderStatus } from './api/hooks'
import { useAuth } from './auth/AuthContext'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import TripDetailPage from './pages/TripDetailPage'
import TripsPage from './pages/TripsPage'
import { formatDateTime } from './utils'

/**
 * The reminder MVP, visible: a badge fed by GET /api/reminders/due,
 * refreshed by polling. Mounted only inside the authed layout, so the
 * polling stops the moment the session ends.
 */
function DueInbox() {
  const { data: due = [] } = useDueReminders()
  const setStatus = useSetReminderStatus()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="due-inbox" ref={boxRef}>
      <button
        type="button"
        className={due.length > 0 ? 'due-button has-due' : 'due-button'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Due <span className="due-count">{due.length}</span>
      </button>

      {open && (
        <div className="due-panel" role="dialog" aria-label="Due reminders">
          {due.length === 0 ? (
            <p className="empty small">Nothing due. Enjoy the quiet.</p>
          ) : (
            due.map((r) => (
              <div key={r.id} className="due-row">
                <div>
                  <div className="due-msg">{r.message}</div>
                  <div className="due-meta mono">
                    {r.trip_name} · {formatDateTime(r.remind_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setStatus.mutate({ id: r.id, status: 'done' })}
                >
                  Done
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** Route guard: no token -> bounce to /login, remembering where we were. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth()
  const location = useLocation()
  if (!token) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  return <>{children}</>
}

/** Top bar + container for signed-in pages. */
function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" aria-hidden="true" />
          <span className="brand-name">Sojourn</span>
        </Link>
        <span className="tagline">plan the days · mind the budget · never miss a departure</span>
        <div className="topbar-right">
          <DueInbox />
          <span className="user-chip mono">{user?.display_name || user?.email}</span>
          <button type="button" className="btn small ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout>
              <TripsPage />
            </Layout>
          </RequireAuth>
        }
      />
      <Route
        path="/trips/:tripId"
        element={
          <RequireAuth>
            <Layout>
              <TripDetailPage />
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
