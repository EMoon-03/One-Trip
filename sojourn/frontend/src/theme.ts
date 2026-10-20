// Light / dark / follow-the-system. The choice is a per-browser convenience,
// so it lives in localStorage (guarded: storage can be unavailable). The
// inline script in index.html applies it before first paint.

import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'onetrip.theme'
const EVENT = 'onetrip-theme'

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function setThemePref(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    /* private mode etc.: the choice just won't persist */
  }
  window.dispatchEvent(new Event(EVENT))
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/** The theme actually showing: 'light' or 'dark'. Re-renders on any change. */
export function useResolvedTheme(): 'light' | 'dark' {
  const resolve = () => {
    const pref = getThemePref()
    return pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref
  }
  const [theme, setTheme] = useState(resolve)
  useEffect(() => {
    const update = () => setTheme(resolve())
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener('change', update)
    window.addEventListener(EVENT, update)
    return () => {
      mq?.removeEventListener('change', update)
      window.removeEventListener(EVENT, update)
    }
  }, [])
  return theme
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState(getThemePref)
  useEffect(() => {
    const update = () => setPref(getThemePref())
    window.addEventListener(EVENT, update)
    return () => window.removeEventListener(EVENT, update)
  }, [])
  return [pref, setThemePref]
}

/** CSS token values for code that can't use CSS (chart libraries). */
export function useThemeColors() {
  const theme = useResolvedTheme()
  const [colors, setColors] = useState(() => readColors())
  useEffect(() => setColors(readColors()), [theme])
  return colors
}

function readColors() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    ink: v('--ink'),
    muted: v('--muted'),
    faint: v('--faint'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    raised: v('--raised'),
  }
}
