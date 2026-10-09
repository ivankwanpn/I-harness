import { useEffect, useRef, useState } from "react"
import { listenForegroundEscape } from "../design/foreground-escape.ts"
export function useNarrowSidebar() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 759px)").matches ?? false)
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 759px)")
    if (!media) return
    const change = () => { setNarrow(media.matches); setOpen(false) }
    media.addEventListener("change", change)
    return () => media.removeEventListener("change", change)
  }, [])
  useEffect(() => {
    if (!narrow || !open) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])
    focusables()[0]?.focus()
    const removeKeys = listenForegroundEscape(container.current, () => setOpen(false), undefined, event => {
      const controls = focusables(); const first = controls[0]; const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    })
    return () => { removeKeys(); if (previous?.isConnected) previous.focus() }
  }, [narrow, open])
  return { narrow, open, setOpen, container }
}
