import { randomUUID } from "node:crypto"
import type { ModelActivityInfo } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "./index.ts"

export interface ModelWaitPolicy { firstResponseMs: number; progressMs: number }
export type StreamActivity = "response-start" | "tool-arguments"
/** Known-terminal HTTP status, before its optional error body is fully read. */
export interface TerminalResponseHint { code: "AUTH" | "QUOTA" | "INVALID_ARGUMENT"; httpStatus: number }

/** Adapters report only payload-free milestones. Host observers cannot break parsing. */
export function reportStreamActivity(request: LLMRequest, kind: StreamActivity): void {
  try { request.onStreamActivity?.(kind) } catch { /* diagnostic observer */ }
}

/** A physical-attempt boundary, inside capture and the single retry wrapper. */
function createWaitingExecution(client: ModelClient, policy: ModelWaitPolicy): ModelClient {
  const { firstResponseMs, progressMs } = policy
  for (const value of [firstResponseMs, progressMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Model wait deadlines must be non-negative finite milliseconds")
  }
  return { async *stream(request) {
    const controller = new AbortController(), requestId = randomUUID()
    let startedAt = Date.now(), issued = !request.generation
    let responseAt: number | undefined, lastProgressAt: number | undefined
    let closed = false, quiet = false, settled = false, terminal: Error | undefined
    let terminalResponse: TerminalResponseHint | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const queued: LLMStreamEvent[] = []
    let iterator: AsyncIterator<LLMStreamEvent> | undefined
    const waitingFor = () => responseAt === undefined ? "first-response" as const : "progress" as const
    const activity = (phase: ModelActivityInfo["phase"], outcome?: ModelActivityInfo["outcome"]) => {
      queued.push({ type: "activity", activity: { requestId, phase, startedAt, waitingFor: waitingFor(), ...(lastProgressAt === undefined ? {} : { lastProgressAt }), ...(outcome ? { outcome } : {}) } })
      wake?.()
    }
    const stop = (error: Error) => { if (closed || terminal) return; terminal = error; controller.abort(error); wake?.() }
    const cancellationError = () => Object.assign(new Error("Model request aborted"), { name: "AbortError", code: "ABORTED" })
    const abort = () => stop(cancellationError())
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (closed || terminal || !issued) return
      const since = lastProgressAt ?? responseAt ?? startedAt
      const limit = responseAt === undefined ? firstResponseMs : progressMs
      const deadline = limit === 0 ? Infinity : since + limit
      const quietAt = quiet ? Infinity : since + 15_000
      const next = Math.min(deadline, quietAt)
      if (!Number.isFinite(next)) return
      timer = setTimeout(() => {
        if (Date.now() >= deadline) {
          const phase = waitingFor()
          stop(terminalResponse
            ? Object.assign(new Error(`Model request failed: HTTP ${terminalResponse.httpStatus}`), terminalResponse)
            : Object.assign(new Error(phase === "first-response" ? "Model request timed out waiting for first response" : "Model request timed out waiting for progress"), { code: "TIMEOUT", phase }))
        } else { quiet = true; activity("quiet"); schedule() }
      }, Math.max(0, next - Date.now()))
    }
    const progress = () => {
      if (closed || terminal) return
      const first = lastProgressAt === undefined
      responseAt ??= Date.now(); lastProgressAt = Date.now()
      if (quiet || first) { quiet = false; activity("streaming") }
      schedule()
    }
    activity("connecting"); schedule()
    request.signal?.addEventListener("abort", abort, { once: true })
    if (request.signal?.aborted) abort()
    let outcome: ModelActivityInfo["outcome"] = "failed"
    const settle = () => {
      if (settled) return
      settled = true
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal?.removeEventListener("abort", abort)
      activity("settled", outcome)
    }
    try {
      if (terminal) throw terminal
      iterator = client.stream({ ...request, signal: controller.signal, onTransportIssue() {
        if (closed || terminal) return
        issued = true; startedAt = Date.now(); responseAt = undefined; lastProgressAt = undefined; quiet = false
        schedule()
      }, onTerminalResponse(hint) {
        if (closed || terminal) return
        if (!["AUTH", "QUOTA", "INVALID_ARGUMENT"].includes(hint.code) || !Number.isInteger(hint.httpStatus)
          || hint.httpStatus < 400 || hint.httpStatus >= 500 || hint.httpStatus === 408 || hint.httpStatus === 429) return
        terminalResponse = { code: hint.code, httpStatus: hint.httpStatus }
        try { request.onTerminalResponse?.(terminalResponse) } catch { /* diagnostic observer */ }
      }, onStreamActivity(kind) {
        if (closed || terminal) return
        if (kind === "response-start" && responseAt === undefined) {
          responseAt = Date.now(); quiet = false; activity("streaming"); schedule()
        } else if (kind === "tool-arguments") progress()
        reportStreamActivity(request, kind)
      } })[Symbol.asyncIterator]()
      // One observer per next, even if it stays parked across many quiet cycles.
      // Repeated Promise.race calls would retain a handler on the same promise
      // each time. Timer/abort/milestone and next completion share this wakeup.
      let pending = false
      let next: { result: IteratorResult<LLMStreamEvent> } | { error: unknown } | undefined
      while (true) {
        if (terminal) throw terminal
        while (queued.length) yield queued.shift()!
        if (terminal) throw terminal
        if (!pending) {
          pending = true
          void Promise.resolve().then(() => iterator!.next()).then(
            result => { if (!closed) { next = { result }; wake?.() } },
            error => { if (!closed) { next = { error }; wake?.() } },
          )
        }
        await new Promise<void>(resolve => {
          wake = resolve
          if (next !== undefined || queued.length > 0 || terminal) resolve()
        })
        wake = undefined
        if (terminal) throw terminal
        if (next === undefined) continue
        const result = next
        next = undefined
        pending = false
        if ("error" in result) throw result.error
        if (result.result.done) { outcome = "completed"; settle(); break }
        const event = result.result.value
        if (event.type === "tool_call" || (event.type === "text/chunk" || event.type === "reasoning") && event.text.length > 0) progress()
        if (event.type === "end" || event.type === "error") { outcome = event.type === "end" ? "completed" : "failed"; settle() }
        while (queued.length) yield queued.shift()!
        yield event
        if (event.type === "end" || event.type === "error") break
      }
    } catch (error) {
      outcome = request.signal?.aborted ? "cancelled" : "failed"
      settle()
      while (queued.length) yield queued.shift()!
      throw request.signal?.aborted ? cancellationError() : error
    } finally {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal?.removeEventListener("abort", abort)
      controller.abort()
      if (iterator?.return) void Promise.resolve().then(() => iterator!.return!()).catch(() => {})
    }
    while (queued.length) yield queued.shift()!
  } }
}

import { preparedModelClient } from "./prepared/wrappers.ts"
import { withOwnedPreparedRequests } from './prepared/owned-wrappers.ts'
import { rememberModelSource } from './prepared/client-source.ts'
export function createWaitingGuard(client: ModelClient, policy: ModelWaitPolicy): ModelClient {
  const capturedPolicy = { firstResponseMs: policy.firstResponseMs, progressMs: policy.progressMs }
  for (const value of [capturedPolicy.firstResponseMs, capturedPolicy.progressMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Model wait deadlines must be non-negative finite milliseconds")
  }
  const wrapped = withOwnedPreparedRequests(client, inner => createWaitingExecution(inner, capturedPolicy))
  const outer = preparedModelClient(async request => {
    try { return await wrapped.prepare!(request) }
    catch (error) {
      if (request.signal?.aborted) throw Object.assign(new Error("Model request aborted"), { name: "AbortError", code: "ABORTED" })
      throw error
    }
  })
  rememberModelSource(outer, () => wrapped)
  return outer
}
