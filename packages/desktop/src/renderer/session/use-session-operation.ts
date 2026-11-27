import { useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { ImageInput } from "@i-harness/sdk"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"

export type CompactResult = import('@i-harness/sdk').SessionCompactResult
export interface SessionOperation { kind: "prompt" | "compact" | "model"; busy: boolean; operationId?: string; error?: string; result?: CompactResult }
type InputOperation =
  | { kind: "compact"; instructions?: string; operationId?: string }
  | { kind: "prompt"; text: string; context?: string; images?: ImageInput[]; token: string; delivery: "queue" | "steer"; onAdmitted?(inputId?: string): void }
export const operationKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId])

/** UI request ownership only: execution and compaction belong to the gateway. */
export function useSessionOperation(bridge: DesktopBridge, durableInputs = false) {
  const [states, setStates] = useState<Record<string, SessionOperation>>({})
  const locks = useRef(new Set<string>())
  async function run(workspaceId: string, sessionId: string, operation: InputOperation) {
    const { kind } = operation
    const key = operationKey(workspaceId, sessionId)
    if (locks.current.has(key)) throw new Error("Session is busy")
    locks.current.add(key)
    const operationId = kind === "compact" ? operation.operationId : undefined
    setStates((old) => ({ ...old, [key]: { kind, busy: true, ...(operationId ? { operationId } : {}) } }))
    let unsubscribe: (() => void) | undefined
    let acknowledged = false
    if (kind === "prompt" && operation.onAdmitted && !durableInputs) {
      unsubscribe = bridge.onEvent((message) => {
        if (acknowledged || message.kind !== "sdk/notification" || message.workspaceId !== workspaceId || message.method !== "session/event") return
        const params = message.params as { sessionId?: unknown; event?: { type?: unknown; intent?: unknown; delivery?: unknown; clientToken?: unknown; inputId?: unknown } } | undefined
        // The service can expand a slash command and append file context before
        // admission. This window owns one prompt request for the session; its
        // queue/user admission is the acknowledgement, not a text comparison.
        if (params?.sessionId !== sessionId || params.event?.type !== "agent/input/admitted"
          || params.event.intent !== "user" || (params.event.delivery !== "queue" && params.event.delivery !== "steer")
          || params.event.clientToken !== operation.token) return
        acknowledged = true
        unsubscribe?.()
        unsubscribe = undefined
        operation.onAdmitted?.(typeof params.event.inputId === "string" ? params.event.inputId : undefined)
      })
    }
    try {
      const value = await bridge.request(kind === "prompt"
        ? durableInputs
          ? { kind: "desktop/session/input/submit", workspaceId, sessionId, text: operation.text, delivery: operation.delivery, clientToken: operation.token, ...(operation.context ? { context: operation.context } : {}), ...(operation.images?.length ? { images: operation.images } : {}) }
          : { kind: "session/prompt", workspaceId, sessionId, prompt: operation.text, clientToken: operation.token, ...(operation.context ? { context: operation.context } : {}), ...(operation.images?.length ? { images: operation.images } : {}) }
        : { kind: "desktop/session/compact", workspaceId, sessionId, ...(operationId ? { operationId } : {}), ...(operation.instructions?.trim() ? { instructions: operation.instructions } : {}) })
      const result = kind === "compact" ? value as CompactResult : undefined
      if (kind === "prompt" && !acknowledged) {
        const receipt = value as { inputId?: string } | undefined
        operation.onAdmitted?.(receipt?.inputId)
      }
      setStates((old) => ({ ...old, [key]: { kind, busy: false, result } }))
      return result
    } catch (reason) {
      // Native diagnostics own model/transport failure content.
      setStates((old) => ({ ...old, [key]: { kind, busy: false } }))
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
