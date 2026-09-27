import { useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ImageInput } from "@i-harness/sdk"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"

export interface CompactResult { compacted: boolean; summary?: string; reason?: "summarizer-failed"; reset?: boolean; pruned?: boolean }
export interface SessionOperation { kind: "prompt" | "compact" | "model"; busy: boolean; error?: string; result?: CompactResult }
export const operationKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId])

/** UI request ownership only: execution and compaction belong to the gateway. */
export function useSessionOperation(bridge: DesktopBridge) {
  const [states, setStates] = useState<Record<string, SessionOperation>>({})
  const locks = useRef(new Set<string>())
  async function run(workspaceId: string, sessionId: string, kind: "prompt" | "compact", text?: string, context?: string, images?: ImageInput[], onAdmitted?: () => void) {
    const key = operationKey(workspaceId, sessionId)
    if (locks.current.has(key)) throw new Error("Session is busy")
    locks.current.add(key)
    setStates((old) => ({ ...old, [key]: { kind, busy: true } }))
    const clientToken = kind === "prompt"
      ? (globalThis.crypto?.randomUUID?.() ?? `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      : undefined
    let unsubscribe: (() => void) | undefined
    if (kind === "prompt" && onAdmitted) {
      let acknowledged = false
      unsubscribe = bridge.onEvent((message) => {
        if (acknowledged || message.kind !== "sdk/notification" || message.workspaceId !== workspaceId || message.method !== "session/event") return
        const params = message.params as { sessionId?: unknown; event?: { type?: unknown; intent?: unknown; delivery?: unknown; clientToken?: unknown } } | undefined
        // The service can expand a slash command and append file context before
        // admission. This window owns one prompt request for the session; its
        // queue/user admission is the acknowledgement, not a text comparison.
        if (params?.sessionId !== sessionId || params.event?.type !== "agent/input/admitted"
          || params.event.intent !== "user" || params.event.delivery !== "queue"
          || params.event.clientToken !== clientToken) return
        acknowledged = true
        unsubscribe?.()
        unsubscribe = undefined
        onAdmitted()
      })
    }
    try {
      const value = await bridge.request(kind === "prompt"
        ? { kind: "session/prompt", workspaceId, sessionId, prompt: text ?? "", clientToken: clientToken!, ...(context ? { context } : {}), ...(images?.length ? { images } : {}) }
        : { kind: "desktop/session/compact", workspaceId, sessionId, ...(text?.trim() ? { instructions: text } : {}) })
      const result = kind === "compact" ? value as CompactResult : undefined
      setStates((old) => ({ ...old, [key]: { kind, busy: false, result } }))
      return result
    } catch (reason) {
      setStates((old) => ({ ...old, [key]: { kind, busy: false, error: reason instanceof Error ? reason.message : String(reason) } }))
      throw reason
    } finally { unsubscribe?.(); locks.current.delete(key) }
  }
  async function changeModel(workspaceId: string, sessionId: string, selection: SessionModelSelection) {
    const key = operationKey(workspaceId, sessionId)
    if (locks.current.has(key)) throw new Error("Session is busy")
    locks.current.add(key)
    setStates((old) => ({ ...old, [key]: { kind: "model", busy: true } }))
    try {
      const result = await bridge.request({ kind: "session/model/set", workspaceId, sessionId, selection }) as SessionModelState
      setStates((old) => ({ ...old, [key]: { kind: "model", busy: false } }))
      return result
    } catch (reason) {
      setStates((old) => ({ ...old, [key]: { kind: "model", busy: false, error: reason instanceof Error ? reason.message : String(reason) } }))
      throw reason
    } finally { locks.current.delete(key) }
  }
  return { states, run, changeModel }
}
