import { useCallback, useEffect, useRef, useState } from "react"
import { useWindowVisibility } from "../window-visibility.tsx"
import { createRefreshScheduler } from "./refresh-scheduler.ts"

type PollPolicy<T> = {
  interval(state: T | undefined, error: string | undefined): number
  subscribe(invalidate: () => void): () => void
}

/** Every request belongs to a mount/scope generation, including mutations. */
export function useExecutionSurface<T>(read: () => Promise<unknown>, scope: string, poll: boolean | PollPolicy<T> = false, active = true) {
  const windowVisible = useWindowVisibility()
  const [state, setState] = useState<T>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const ticket = useRef(0)
  const pending = useRef(false)
  const reads = useRef({ generation: 0, count: 0 })
  const automatic = useRef<{ settle(): void; invalidate(delay?: number): void } | undefined>(undefined)
  const foreground = useRef<{ scope: string; visible: boolean } | undefined>(undefined)
  const interval = typeof poll === "object" ? poll.interval(state, error) : poll ? 1500 : undefined
  const subscribe = typeof poll === "object" ? poll.subscribe : undefined
  const readRef = useRef(read); readRef.current = read
  const canRefreshAutomatically = useCallback(() => {
    const inFlight = reads.current
    return !document.hidden && !pending.current && (inFlight.generation !== generation.current || inFlight.count === 0)
  }, [])
  const refresh = useCallback(async () => {
    const current = generation.current; const request = ++ticket.current
    if (reads.current.generation !== current) reads.current = { generation: current, count: 0 }
    const inFlight = reads.current
    inFlight.count++
    try { const value = await readRef.current(); if (current === generation.current && request === ticket.current) { setState(value as T); setError(undefined) } }
    catch (reason) { if (current === generation.current && request === ticket.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      inFlight.count--
      if (current === generation.current) automatic.current?.settle()
    }
  }, [])
  useEffect(() => {
    generation.current++; ticket.current++; pending.current = false
    setState(undefined); setError(undefined); setBusy(false)
    return () => { generation.current++; ticket.current++ }
  }, [scope])
  useEffect(() => {
    const resumed = foreground.current?.scope === scope && !foreground.current.visible && windowVisible
    foreground.current = { scope, visible: windowVisible }
    if (!subscribe || !active || !windowVisible) return
    let dirty = false
    const scheduler = createRefreshScheduler(async () => {
      if (!dirty || !canRefreshAutomatically()) return
      dirty = false
      await refresh()
    })
    const refreshControl = {
      settle() { if (dirty && canRefreshAutomatically()) scheduler.schedule() },
      invalidate(delay?: number) {
        dirty = true
        if (canRefreshAutomatically()) scheduler.schedule(delay)
      },
    }
    automatic.current = refreshControl
    const unsubscribe = subscribe(() => refreshControl.invalidate())
    const onVisibilityChange = () => { if (!document.hidden) refreshControl.invalidate(0) }
    document.addEventListener("visibilitychange", onVisibilityChange)
    if (resumed) onVisibilityChange()
    return () => {
      automatic.current = undefined
      document.removeEventListener("visibilitychange", onVisibilityChange)
      unsubscribe()
      scheduler.dispose()
    }
  }, [scope, subscribe, active, windowVisible, canRefreshAutomatically, refresh])
  // Bind foreground invalidation before starting the first snapshot.
  useEffect(() => { void refresh() }, [scope, refresh])
  useEffect(() => {
    if (interval === undefined || !active || !windowVisible) return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => { clearInterval(timer); timer = undefined }
    const updateVisibility = () => {
      stop()
      if (document.hidden) return
      timer = setInterval(() => {
        if (!canRefreshAutomatically()) return
        if (automatic.current) automatic.current.invalidate(0)
        else void refresh()
      }, interval)
    }
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => { document.removeEventListener('visibilitychange', updateVisibility); stop() }
  }, [scope, interval, active, windowVisible, canRefreshAutomatically, refresh])
  async function act(run: () => Promise<unknown>, after?: (value: unknown) => void, refreshAfter = true) {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError(undefined)
    // Reads begun before this operation cannot replace its newer result.
    ticket.current++
    const current = generation.current
    try {
      const value = await run()
      if (current !== generation.current) return false
      after?.(value); if (refreshAfter) await refresh(); return true
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)); return false }
    finally {
      if (current === generation.current) {
        pending.current = false
        setBusy(false)
        automatic.current?.settle()
      }
    }
  }
  return { state, error, busy, refresh, act, generation, replace: (value: T) => setState(value) }
}
