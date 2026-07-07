import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const valid = displayName.trim().length > 0 && email.includes('@') && password.length >= 8

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      await register({ display_name: displayName.trim(), email, password })
      navigate('/', { replace: true }) // register returns a token — already signed in
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <span className="brand-dot" aria-hidden="true" />
        <span className="brand-name">Sojourn</span>
      </div>

      <div className="card auth-card">
        <p className="eyebrow mono">New traveler</p>
        <h1 className="auth-title">Create an account</h1>

        <div className="auth-fields">
          <label>
            Name
            <input
              value={displayName}
              autoComplete="name"
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Eddie"
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && valid && submit()}
              placeholder="8+ characters"
            />
          </label>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="button" className="btn primary wide" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </div>

        <p className="auth-alt">
          Already have one? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}
