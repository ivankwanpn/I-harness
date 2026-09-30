import { useCallback, useEffect, useRef, useState } from "react"
import type { DesktopWorkflowView, WorkflowCommand } from "@i-harness/desktop-gateway/src/workflow.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { createRefreshScheduler } from "./refresh-scheduler.ts"
import { useWorkflowText } from "./workflow-i18n.ts"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Own responses and subscriptions for one selected conversation. The caller
 * keys this hook's component by workspace/session, so drafts also stay scoped. */
export function useWorkflow(bridge: DesktopBridge, workspaceId: string, sessionId: string, onChanged?: () => void) {
  const t = useWorkflowText()
  const [view, setView] = useState<DesktopWorkflowView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [readbackRequired, setReadbackRequired] = useState(false)
  const active = useRef(false)
  const epoch = useRef(0)
  const readTicket = useRef(0)
  const lock = useRef(false)
  const dirty = useRef(false)
  const scheduler = useRef<ReturnType<typeof createRefreshScheduler> | undefined>(undefined)
  const changed = useRef(onChanged)
  changed.current = onChanged

  const read = useCallback(async (force = false) => {
    if (lock.current && !force) { dirty.current = true; return false }
    const scope = epoch.current
    const ticket = ++readTicket.current
    try {
      const next = await bridge.request({ kind: "desktop/session/workflow/read", workspaceId, sessionId }) as DesktopWorkflowView
      if (!active.current || scope !== epoch.current || ticket !== readTicket.current) return false
      setView(next); setReadbackRequired(false)
      return true
    } catch (reason) {
      if (!active.current || scope !== epoch.current || ticket !== readTicket.current) return false
      throw reason
    }
  }, [bridge, workspaceId, sessionId])

  useEffect(() => {
    active.current = true
    epoch.current++
    const refresh = createRefreshScheduler(async () => { try { await read() } catch (reason) { if (active.current) setError(message(reason)) } })
    scheduler.current = refresh
    const unsubscribe = bridge.onEvent((event) => {
      if (event.kind !== "sdk/notification" || event.workspaceId !== workspaceId) return
      const params = event.params as { sessionId?: unknown; event?: { type?: unknown } } | undefined
      if (params?.sessionId !== sessionId) return
      const type = params.event?.type
      if (event.method === "desktop/workflow/changed" || event.method === "session/status"
        || event.method === "session/event" && (type === "goal/change" || type === "plan/mode" || type === "job/status" || type === "tool/result" || typeof type === "string" && type.startsWith("team/"))) refresh.schedule()
    })
    void read().catch((reason) => { if (active.current) setError(message(reason)) })
    return () => { active.current = false; epoch.current++; readTicket.current++; refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceId, sessionId, read])

  async function retry() {
    if (lock.current) return
    setError(undefined)
    try { await read() } catch (reason) { if (active.current) setError(message(reason)) }
  }

  async function mutate(command: WorkflowCommand): Promise<boolean> {
    if (lock.current || readbackRequired || !active.current) return false
    const scope = epoch.current
    lock.current = true; readTicket.current++; setBusy(true); setError(undefined)
    try {
      const next = await bridge.request({ kind: "desktop/session/workflow/mutate", workspaceId, sessionId, command }) as DesktopWorkflowView
      if (!active.current || scope !== epoch.current) return false
      setView(next); setReadbackRequired(false); changed.current?.()
      return true
    } catch (reason) {
      if (!active.current || scope !== epoch.current) return false
      setReadbackRequired(true)
      const mutationError = message(reason)
      try { await read(true); if (active.current && scope === epoch.current) setError(mutationError) }
      catch (readError) { if (active.current && scope === epoch.current) setError(`${mutationError} · ${t("重新讀取失敗，請重試後再操作。")} ${message(readError)}`) }
      return false
    } finally {
      lock.current = false
      if (active.current && scope === epoch.current) {
        setBusy(false)
        if (dirty.current) { dirty.current = false; scheduler.current?.schedule() }
      }
    }
  }

  return { view, error, busy, disabled: busy || readbackRequired, retry, mutate }
}
