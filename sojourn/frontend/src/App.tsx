import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useDueReminders, useSetReminderStatus } from './api/hooks'
import { useAuth } from './auth/AuthContext'
import NotificationSettings from './components/NotificationSettings'
import { BrandMark, Icon } from './components/ui'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import TripDetailPage from './pages/TripDetailPage'
import TripsPage from './pages/TripsPage'
import { disablePush } from './push'
import { useThemePref, type ThemePref } from './theme'
import { formatInZone } from './time'
import { usePageTitle } from './usePageTitle'

/**
 * The reminder MVP, visible: a bell fed by GET /api/reminders/due,
 * refreshed by polling. Mounted only inside the authed layout, so the
 * polling stops the moment the session ends.
 */
function DueInbox() {
  const { data: due = [] } = useDueReminders()
  const setStatus = useSetReminderStatus()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'due' | 'settings'>('due')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) setView('due')
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const count = due.length

  return (
    <div className="due-inbox" ref={boxRef}>
      <button
        type="button"
        className={count > 0 ? 'due-button has-due' : 'due-button'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={count > 0 ? `${count} reminder${count === 1 ? '' : 's'} due` : 'Reminders'}
      >
        <Icon name="bell" size={17} />
        {count > 0 && <span>{count}</span>}
      </button>

      {open && (
        <div className="due-panel" role="dialog" aria-label={view === 'due' ? 'Due reminders' : 'Notification settings'}>
          {view === 'settings' ? (
            <>
              <div className="due-panel-head">
                <p className="due-panel-title">Notifications</p>
                <button type="button" className="btn-text" onClick={() => setView('due')}>
                  Done
                </button>
              </div>
              <NotificationSettings />
            </>
          ) : (
            <>
              <p className="due-panel-title">Due now</p>
              {count === 0 ? (
                <p className="empty" style={{ padding: '6px 10px 10px' }}>
                  You're all caught up.
                </p>
              ) : (
                due.map((r) => (
                  <div key={r.id} className="due-row">
                    <div>
                      <div className="due-msg">{r.message}</div>
                      <div className="due-meta">
                        {r.trip_name}, {formatInZone(r.remind_at, r.effective_timezone)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="check-btn urgent"
                      aria-label={`Mark done: ${r.message}`}
                      title="Mark done"
                      onClick={() => setStatus.mutate({ id: r.id, status: 'done' })}
                    >
                      <Icon name="check" size={13} />
                    </button>
                  </div>
                ))
              )}
              <div className="due-panel-foot">
                <button type="button" className="btn-text" onClick={() => setView('settings')}>
                  Notification settings
                </button>
              </div>
            </>
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

/** Your initial; opens appearance (light / dark / system) and sign out. */
function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useThemePref()
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = user?.display_name || user?.email || ''
  const options: { value: ThemePref; label: string; icon: 'monitor' | 'sun' | 'moon' }[] = [
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ]

  return (
    <div className="user-menu" ref={boxRef}>
      <button
        type="button"
        className="avatar-btn"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-name">{name}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <div className="menu-who">
            <strong>{user?.display_name}</strong>
            <span>{user?.email}</span>
          </div>
          <div className="menu-section">
            <span className="menu-label" id="appearance-label">
              Appearance
            </span>
            <div className="segmented theme-seg" role="radiogroup" aria-labelledby="appearance-label">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === o.value}
                  className={theme === o.value ? 'active' : ''}
                  onClick={() => setTheme(o.value)}
                >
                  <Icon name={o.icon} size={14} />
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={async () => {
              // Stop this browser's notifications first, so the next person
              // to use it doesn't get your reminders. Best effort: never block sign-out.
              await disablePush().catch(() => {})
              logout()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function NotFound() {
  usePageTitle('Not found')
  return (
    <div className="empty-state">
      <h1 className="nf-title">This page isn't on the itinerary</h1>
      <p>The link may be old, or the address has a typo.</p>
      <Link to="/" className="btn primary">
        Go to your trips
      </Link>
    </div>
  )
}

/** Top bar + container for signed-in pages. */
function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <BrandMark />
          One Trip
        </Link>
        <div className="topbar-right">
          <DueInbox />
          <UserMenu />
        </div>
      </header>
      <main className="container" id="main">
        {children}
      </main>
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
      <Route
        path="*"
        element={
          <RequireAuth>
            <Layout>
              <NotFound />
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
