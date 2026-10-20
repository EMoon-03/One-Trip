import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/ui'
import { usePageTitle } from '../usePageTitle'

export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  usePageTitle('Create your account')

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const valid = displayName.trim().length > 0 && email.includes('@') && password.length >= 8

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    setBusy(true)
    try {
      await register({ display_name: displayName.trim(), email, password })
      navigate('/', { replace: true }) // register returns a token — already signed in
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

        <h1 className="auth-title">Create your account</h1>
        <p className="auth-lede">Plan each day, track what you spend, and get reminded before you need to leave.</p>

        <form onSubmit={submit} noValidate>
          <div className="auth-fields">
            <label className="field">
              Name
              <input
                value={displayName}
                autoComplete="name"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label className="field">
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="field">
              <span>
                Password <span className="hint">at least 8 characters</span>
              </span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>

          <button type="submit" className="btn primary wide" disabled={!valid || busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>

        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
