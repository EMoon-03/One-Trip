import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/ui'
import { usePageTitle } from '../usePageTitle'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  usePageTitle('Sign in')
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-inner">
        <Link to="/login" className="brand">
          <BrandMark />
          One Trip
        </Link>

        <h1 className="auth-title">Sign in</h1>
        <p className="auth-lede">Your itineraries, budgets and reminders are waiting.</p>

        <form onSubmit={submit} noValidate>
          <div className="auth-fields">
            <label className="field">
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </div>

          <button type="submit" className="btn primary wide" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>

        <p className="auth-alt">
          New to One Trip? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  )
}
