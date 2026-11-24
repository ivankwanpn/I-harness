import { createHash, randomUUID } from "node:crypto"
import { appendFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

const MAX_MARKS = 4096
const MAX_PENDING = 128

type Phase = "gateway-received" | "gateway-admitted" | "gateway-rejected" | "turn-start" | "request-projected" | "request-assessed" | "tool-start"
type ProviderPhase = "provider-issued" | "provider-first-event" | "provider-first-text" | "provider-finished"

function digest(value: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function timingScope(workspace: string, sessionId: string): string {
  const path = resolve(workspace)
  return digest([process.platform === "win32" ? path.toLowerCase() : path, sessionId])
}

/** Private developer probe. No prompt, output, tool arguments, route or path is
 * written. The stream of small records is independent of the session store. */
export function createDesktopTimingTrace(workspace: string, file = process.env.IH_DESKTOP_TIMING_TRACE) {
  if (!file || !isAbsolute(file)) return undefined
  const target = file
  let tail = Promise.resolve()
  let pending = 0
  let marks = 0
  let closed = false
  let failed = false
  function write(scope: string, phase: Phase | ProviderPhase, identity: { input?: string; turn?: string; attempt?: string }, result?: "completed" | "failed" | "cancelled") {
    if (closed || failed || marks >= MAX_MARKS || pending >= MAX_PENDING) return
    marks++
    pending++
    const line = JSON.stringify({ scope, phase, at: performance.timeOrigin + performance.now(), ...identity, ...(result ? { result } : {}) }) + "\n"
    tail = tail.then(() => failed ? undefined : appendFile(target, line, { encoding: "utf8", mode: 0o600 })).catch(() => { failed = true }).finally(() => { pending-- })
  }
  return {
    mark(phase: Phase, sessionId: string, token?: string) {
      const scope = timingScope(workspace, sessionId)
      write(scope, phase, token ? { input: digest([scope, token]) } : {})
    },
    provider(request: Pick<LLMRequest, "requestScope" | "sessionId">) {
      const id = request.requestScope?.sessionId ?? request.sessionId
      if (!id) return undefined
      const scope = timingScope(workspace, id)
      const turn = request.requestScope?.turnId
      const identity = { attempt: randomUUID(), ...(turn ? { turn: digest([scope, turn]) } : {}) }
      let issued = false
      let eventSeen = false
      let textSeen = false
      return {
        issue() { if (!issued) { issued = true; write(scope, "provider-issued", identity) } },
        event(event: LLMStreamEvent) {
          if (!issued) return
          if (!eventSeen) { eventSeen = true; write(scope, "provider-first-event", identity) }
          if (!textSeen && event.type === "text/chunk" && event.text.trim()) {
            textSeen = true
            write(scope, "provider-first-text", identity)
          }
        },
        finish(result: "completed" | "failed" | "cancelled") { if (issued) write(scope, "provider-finished", identity, result) },
      }
    },
    close() { closed = true; return tail },
  }
}
