// Axios instance + the two interceptors that make auth invisible to the
// rest of the app:
//
//   request  -> attach "Authorization: Bearer <token>" if we have one
//   response -> normalize FastAPI errors to Error(message); on a 401 from a
//               protected route, drop the session and send the user to /login
//
// Components and hooks never touch tokens — they just call api.get/post/...

import axios, { AxiosError } from 'axios'

export const TOKEN_KEY = 'sojourn.token'
export const USER_KEY = 'sojourn.user'

const client = axios.create({
  headers: { 'Content-Type': 'application/json' },
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY) // read fresh — never a stale closure
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

client.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ detail?: unknown }>) => {
    const status = error.response?.status
    const url = error.config?.url ?? ''

    // Session expired / revoked on a protected route -> clean logout.
    // (401s from /api/auth/* are normal "wrong password" responses — those
    // must reach the login form, not trigger a redirect loop.)
    if (status === 401 && !url.includes('/api/auth/') && localStorage.getItem(TOKEN_KEY)) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login')
      }
    }

    // FastAPI errors: {"detail": "message"} or {"detail": [{msg: ...}, ...]}
    const detail = error.response?.data?.detail
    let message = error.message
    if (typeof detail === 'string') message = detail
    else if (Array.isArray(detail) && detail[0]?.msg) message = String(detail[0].msg)

    return Promise.reject(new Error(message))
  },
)

export const api = {
  get: <T>(path: string) => client.get<T>(path).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => client.post<T>(path, body).then((r) => r.data),
  patch: <T>(path: string, body?: unknown) => client.patch<T>(path, body).then((r) => r.data),
  del: (path: string) => client.delete<void>(path).then(() => undefined),
}
