import { useCallback, useEffect, useRef, useState } from "react"

/** Every request belongs to a mount/scope generation, including mutations. */
export function useExecutionSurface<T>(read: () => Promise<unknown>, scope: string, poll = false, active = true) {
  const [state, setState] = useState<T>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const ticket = useRef(0)
  const pending = useRef(false)
  const reads = useRef({ generation: 0, count: 0 })
  const readRef = useRef(read); readRef.current = read
  const refresh = useCallback(async () => {
    const current = generation.current; const request = ++ticket.current
    if (reads.current.generation !== current) reads.current = { generation: current, count: 0 }
    const inFlight = reads.current
    inFlight.count++
    try { const value = await readRef.current(); if (current === generation.current && request === ticket.current) { setState(value as T); setError(undefined) } }
    catch (reason) { if (current === generation.current && request === ticket.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { inFlight.count-- }
  }, [])
  useEffect(() => {
    generation.current++; ticket.current++; pending.current = false
    setState(undefined); setError(undefined); setBusy(false)
    void refresh()
    return () => { generation.current++; ticket.current++ }
  }, [scope, refresh])
  useEffect(() => {
    if (!poll || !active) return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => { clearInterval(timer); timer = undefined }
    const updateVisibility = () => {
      stop()
      if (document.hidden) return
      timer = setInterval(() => {
        const inFlight = reads.current
        if (!document.hidden && !pending.current && (inFlight.generation !== generation.current || inFlight.count === 0)) void refresh()
      }, 1500)
    }
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => { document.removeEventListener('visibilitychange', updateVisibility); stop() }
  }, [scope, poll, active, refresh])
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
    finally { if (current === generation.current) { pending.current = false; setBusy(false) } }
  }
  return { state, error, busy, refresh, act, generation, replace: (value: T) => setState(value) }
}
