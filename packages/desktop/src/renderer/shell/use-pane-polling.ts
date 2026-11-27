import { useCallback, useEffect, useRef } from "react"

/** Retained panes keep their data and cursor while their reader is paused. */
export function usePanePolling(visible: boolean) {
  const shown = useRef(visible)
  const visibilityChanged = useRef<() => void>(undefined)
  useEffect(() => {
    shown.current = visible
    visibilityChanged.current?.()
  }, [visible])

  return useCallback((read: () => Promise<number | undefined>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = false
    let finished = false
    let visibleNow = false
    let refreshOnReturn = false
    const poll = async () => {
      timer = undefined
      if (finished || !visibleNow || reading) return
      reading = true
      const delay = await read()
      reading = false
      if (delay === undefined) finished = true
      if (!finished && visibleNow) timer = setTimeout(poll, refreshOnReturn ? 0 : delay)
      refreshOnReturn = false
    }
    const sync = () => {
      const next = shown.current && !document.hidden
      if (next === visibleNow) return
      visibleNow = next
      clearTimeout(timer)
      if (next && reading) refreshOnReturn = true
      else if (next) void poll()
    }
    visibilityChanged.current = sync
    document.addEventListener("visibilitychange", sync)
    sync()
    return () => {
      finished = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", sync)
      visibilityChanged.current = undefined
    }
  }, [])
}
