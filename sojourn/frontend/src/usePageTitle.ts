import { useEffect } from 'react'

/** "Tokyo, Off the Clock · One Trip" in the browser tab and history. */
export function usePageTitle(title?: string | null) {
  useEffect(() => {
    document.title = title ? `${title} · One Trip` : 'One Trip'
  }, [title])
}
