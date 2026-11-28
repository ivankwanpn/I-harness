import { useEffect, useRef, useState } from "react"
import { readSessionContextState, type SessionContextState } from "@i-harness/sdk/context"
import type { DesktopBridge } from "../../shared/bridge.ts"

const refreshDelay = 250
const refreshInterval = 1000
const contextEvents = new Set(["user/message", "assistant/message", "tool/call", "tool/result", "turn/end", "step/end", "compaction/start", "compaction/end", "context/budget", "context/usage", "context/recovery"])
const historyRewrites = new Set(["compaction/summary", "compaction/replacement", "compaction/reset", "compaction/prune", "rewind/point"])
type Estimate = { bridge: DesktopBridge; workspaceId: string; sessionId: string; refreshKey?: string; state?: SessionContextState; error?: string; loading: boolean }
type RefreshControl = { key?: string; invalidate(key: string | undefined, immediate?: boolean): void }

export function useSessionContext(bridge: DesktopBridge, workspaceId: string, sessionId: string, refreshKey?: string) {
  const refresh = useRef<RefreshControl | undefined>(undefined)
  const latestKey = useRef(refreshKey)
  latestKey.current = refreshKey
  const [estimate, setEstimate] = useState<Estimate>()
  useEffect(() => {
    let active = true
    let running = false
    let dirty = false
    let immediate = false
    let revision = 0
    let lastStarted = 0
    let disconnected: { message: string } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const control: RefreshControl = {
      key: latestKey.current,
      invalidate(key, urgent = false) {
        if (!active) return
        control.key = key
        revision++
        // Keep model changes scoped without restarting an offline gateway.
        if (disconnected && !urgent) {
          setEstimate({ bridge, workspaceId, sessionId, refreshKey: key, error: disconnected.message, loading: false })
          return
        }
        if (urgent) disconnected = undefined
        setEstimate({ bridge, workspaceId, sessionId, refreshKey: key, loading: true })
        schedule(urgent)
      },
    }
    const read = async () => {
      if (!active || disconnected || running) return
      clearTimeout(timer); timer = undefined
      running = true; dirty = false; immediate = false; lastStarted = Date.now()
      const ticket = revision
      const key = control.key
      const scope = { bridge, workspaceId, sessionId, refreshKey: key }
      setEstimate(previous => previous?.bridge === bridge && previous.workspaceId === workspaceId && previous.sessionId === sessionId && previous.refreshKey === key
        ? { ...previous, error: undefined, loading: true } : { ...scope, loading: true })
      try {
        const value = await bridge.request({ kind: "session/context", workspaceId, sessionId })
        if (active && ticket === revision) setEstimate({ ...scope, state: readSessionContextState(value, sessionId), loading: false })
      } catch (reason) {
        if (active && ticket === revision) setEstimate({ ...scope, error: reason instanceof Error ? reason.message : String(reason), loading: false })
      } finally {
        running = false
        if (active && dirty) schedule()
      }
    }
    function schedule(urgent = false) {
      if (!active || disconnected) return
      dirty = true; immediate ||= urgent
      if (running) return
      if (immediate) { clearTimeout(timer); timer = undefined; void read(); return }
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void read() }, Math.max(refreshDelay, refreshInterval - (Date.now() - lastStarted)))
    }
    refresh.current = control
    const mountRevision = revision
    const unsubscribe = bridge.onEvent(message => {
      if (!active || message.kind === "window/state" || message.kind === "runtime/diagnostic" || message.kind === "runtime/activity" || message.workspaceId !== workspaceId) return
      if (message.kind === "sdk/disconnected") {
        disconnected = { message: message.message }
        revision++; dirty = false; immediate = false
        clearTimeout(timer); timer = undefined
        setEstimate({ bridge, workspaceId, sessionId, refreshKey: control.key, error: message.message, loading: false })
        return
      }
      if (disconnected) return
      const params = message.params as { sessionId?: unknown; status?: unknown; event?: { type?: unknown } } | undefined
      if (params?.sessionId !== sessionId) return
      if (message.method === "session/status" && params.status !== "queued" && params.status !== "running") schedule()
      if (message.method === "session/event" && typeof params.event?.type === "string") {
        if (historyRewrites.has(params.event.type)) control.invalidate(control.key)
        else if (contextEvents.has(params.event.type)) schedule()
      }
    })
    // StrictMode tears down its first effect before this read; a disconnect or
    // model change can also invalidate the mount request before it starts.
    void Promise.resolve().then(() => { if (revision === mountRevision) return read() })
    return () => { active = false; clearTimeout(timer); unsubscribe(); if (refresh.current === control) refresh.current = undefined }
  }, [bridge, workspaceId, sessionId])
  useEffect(() => {
    if (refresh.current && refresh.current.key !== refreshKey) refresh.current.invalidate(refreshKey)
  }, [bridge, workspaceId, sessionId, refreshKey])
  const current = estimate?.bridge === bridge && estimate.workspaceId === workspaceId && estimate.sessionId === sessionId && estimate.refreshKey === refreshKey ? estimate : undefined
  return { current, retry: () => refresh.current?.invalidate(refreshKey, true) }
}
