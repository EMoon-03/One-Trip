// Session state for the whole app. Components read { user, token } and call
// login/register/logout; token storage and header-attachment live in the
// axios interceptors (src/api/client.ts), so nothing else thinks about JWTs.
//
// Storage note: the token lives in localStorage — simple, survives refresh,
// but readable by any JS on the page (XSS risk). The hardened alternative is
// an httpOnly cookie + CSRF protection; see the README roadmap.

import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { api, TOKEN_KEY, USER_KEY } from '../api/client'
import type { RegisterPayload, TokenResponse, User } from '../api/types'

interface AuthContextValue {
  user: User | null
  token: string | null
  login: (email: string, password: string) => Promise<void>
  register: (payload: RegisterPayload) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY)
    try {
      return raw ? (JSON.parse(raw) as User) : null
    } catch {
      return null
    }
  })

  const persist = useCallback((session: TokenResponse) => {
    localStorage.setItem(TOKEN_KEY, session.access_token)
    localStorage.setItem(USER_KEY, JSON.stringify(session.user))
    setToken(session.access_token)
    setUser(session.user)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setToken(null)
    setUser(null)
    queryClient.clear() // one user's cached trips must never leak to the next
  }, [queryClient])

  const login = useCallback(
    async (email: string, password: string) => {
      // OAuth2 form fields: username = email
      const body = new URLSearchParams({ username: email, password })
      persist(await api.post<TokenResponse>('/api/auth/login', body))
    },
    [persist],
  )

  const register = useCallback(
    async (payload: RegisterPayload) => {
      persist(await api.post<TokenResponse>('/api/auth/register', payload))
    },
    [persist],
  )

  // On boot with a stored token, confirm it still works (and refresh the
  // user). A dead token gets cleaned up by the 401 interceptor + this catch.
  useEffect(() => {
    if (!token) return
    api
      .get<User>('/api/auth/me')
      .then((me) => {
        setUser(me)
        localStorage.setItem(USER_KEY, JSON.stringify(me))
      })
      .catch(() => logout())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
