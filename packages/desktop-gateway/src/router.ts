import {
  decodeFrame,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isRpcRequest,
  isRpcSuccess,
  makeFailure,
  makeSuccess,
  METHOD_NOT_FOUND,
} from "@i-harness/sdk"
import type { SdkServer } from "@i-harness/sdk/server"
import type { DesktopHandlers, GatewayWrite } from "./types.ts"
import { ReviewPathError } from "./review.ts"
import { randomUUID } from "node:crypto"
import { memoryRequest } from "./memory-wire.ts"
import { boundSearchHits } from "./search-bounds.ts"
import { providerCommand } from "./provider-wire.ts"

/** Augment only an initialize reply, without modifying the SDK server's object. */
export function createGatewayWrite(send: GatewayWrite, handlers: DesktopHandlers, internalIds: Set<string> = new Set()): GatewayWrite {
  return (frame) => {
    if ("id" in frame && internalIds.has(String(frame.id))) return
    if (!isRpcSuccess(frame) || !isInitializeResult(frame.result)) {
      send(frame)
      return
    }
    const capabilities = { ...frame.result.capabilities }
    if (handlers.provider !== undefined) capabilities["desktop-provider"] = ["1"]
    if (handlers.memory !== undefined) capabilities["desktop-memory"] = ["1"]
    if (handlers.compact !== undefined) capabilities["desktop-compaction"] = ["1"]
    if (handlers.sessionQuery !== undefined) capabilities["desktop-session-search"] = ["1"]
    if (handlers.sandboxState !== undefined) capabilities["desktop-sandbox"] = ["1"]
    if (handlers.interaction !== undefined) capabilities["desktop-interaction"] = ["1"]
    if (handlers.review !== undefined) capabilities["desktop-review"] = ["1"]
    send({ ...frame, result: { ...frame.result, capabilities } })
  }
}

function isInitializeResult(value: unknown): value is {
  name: string
  version: string
  protocolVersion: number
  capabilities: Record<string, string[]>
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.name === "string"
    && typeof record.version === "string"
    && typeof record.protocolVersion === "number"
    && record.capabilities !== null
    && typeof record.capabilities === "object"
    && !Array.isArray(record.capabilities)
}

export function createDesktopRouter(base: SdkServer, send: GatewayWrite, handlers: DesktopHandlers, internalIds: Set<string> = new Set()): {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
} {
  let initialized = false
  let closed = false
  const activePrompts = new Map<string, number>()
  const compacting = new Map<string, AbortController>()
  const compactJobs = new Set<Promise<unknown>>()

  return {
    async handleLine(line) {
      if (closed) return
      const message = decodeFrame(line)
      if (!message || !isRpcRequest(message)) return

      if (message.method === "initialize") {
        const replyLine = await base.handleLine(line)
        const reply = replyLine === null ? undefined : decodeFrame(replyLine)
        if (isRpcSuccess(reply)) initialized = true
        return
      }

      if (!message.method.startsWith("desktop/")) {
        if (message.method === "shutdown") for (const controller of compacting.values()) controller.abort()
        const scopedSessionId = asRecord(message.params)?.sessionId
        if (message.method === "session/cancel" && typeof scopedSessionId === "string" && compacting.has(scopedSessionId)) {
          compacting.get(scopedSessionId)!.abort()
          send(makeSuccess(message.id, { cancelled: true }))
          return
        }
        if ((message.method === "session/model/set" || message.method === "session/rewind/execute")
          && typeof scopedSessionId === "string" && compacting.has(scopedSessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session compaction is running", { reason: "session_busy" }))
          return
        }
        if (message.method === "session/prompt") {
          const sessionId = asRecord(message.params)?.sessionId
          if (typeof sessionId === "string" && compacting.has(sessionId)) {
            send(makeFailure(message.id, INVALID_REQUEST, "session compaction is running", { reason: "session_busy" }))
            return
          }
          if (typeof sessionId === "string" && sessionId !== "") activePrompts.set(sessionId, (activePrompts.get(sessionId) ?? 0) + 1)
          try { await base.handleLine(line) }
          finally {
            if (typeof sessionId === "string") {
              const remaining = (activePrompts.get(sessionId) ?? 1) - 1
              if (remaining > 0) activePrompts.set(sessionId, remaining)
              else activePrompts.delete(sessionId)
            }
          }
          return
        }
        await base.handleLine(line)
        if (message.method === "session/cancel") {
          const sessionId = asRecord(message.params)?.sessionId
          if (typeof sessionId === "string" && sessionId !== "") handlers.interaction?.cancelSession?.(sessionId)
        }
        return
      }

      if (!initialized) {
        send(makeFailure(message.id, INVALID_REQUEST, "not initialized: send initialize first", {
          reason: "not_initialized",
        }))
        return
      }

      if (message.method === "desktop/provider/directory" && handlers.provider !== undefined) {
        try { send(makeSuccess(message.id, await handlers.provider.directory())) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "provider directory unavailable")) }
        return
      }
      if (message.method === "desktop/provider/mutate" && handlers.provider !== undefined) {
        try { send(makeSuccess(message.id, await providerCommand(handlers.provider, message.params))) }
        catch { send(makeFailure(message.id, INVALID_PARAMS, "Provider change failed. Check the fields, credential source and configuration file permissions.")) }
        return
      }
      if (message.method.startsWith("desktop/memory/") && handlers.memory !== undefined) {
        try { send(makeSuccess(message.id, memoryRequest(handlers.memory, message.method, message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/compact" && handlers.compact !== undefined) {
        const params = asRecord(message.params)
        if (typeof params?.sessionId !== "string" || !params.sessionId
          || (params.instructions !== undefined && (typeof params.instructions !== "string" || params.instructions.length > 4096))) {
          send(makeFailure(message.id, INVALID_PARAMS, "sessionId is required and instructions must be at most 4096 characters"))
          return
        }
        const sessionId = params.sessionId
        if (activePrompts.has(sessionId) || compacting.has(sessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session is busy", { reason: "session_busy" }))
          return
        }
        const controller = new AbortController()
        compacting.set(sessionId, controller)
        const compact = handlers.compact
        const job = Promise.resolve().then(() => compact(sessionId, params.instructions as string | undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])))
        compactJobs.add(job)
        try {
          send(makeSuccess(message.id, await job))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        } finally {
          compacting.delete(sessionId)
          compactJobs.delete(job)
        }
        return
      }

      if (message.method === "desktop/session/search" && handlers.sessionQuery !== undefined) {
        const params = asRecord(message.params)
        if (typeof params?.query !== "string" || !params.query.trim() || params.query.length > 4096
          || (params.sessionId !== undefined && (typeof params.sessionId !== "string" || !params.sessionId))
          || (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) {
          send(makeFailure(message.id, INVALID_PARAMS, "query must contain 1-4096 characters and limit must be 1-100"))
          return
        }
        try {
          const hits = await handlers.sessionQuery.search(params.query, {
            ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
          })
          send(makeSuccess(message.id, boundSearchHits(hits)))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (message.method === "desktop/sandbox/state" && handlers.sandboxState !== undefined) {
        try {
          send(makeSuccess(message.id, await handlers.sandboxState()))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (message.method === "desktop/interaction/pending" && handlers.interaction !== undefined) {
        const params = asRecord(message.params)
        if (params === undefined || (params.sessionId !== undefined && (typeof params.sessionId !== "string" || params.sessionId === ""))) {
          send(makeFailure(message.id, INVALID_PARAMS, "sessionId must be a non-empty string when provided"))
          return
        }
        send(makeSuccess(message.id, handlers.interaction.pending(params.sessionId as string | undefined)))
        return
      }

      if (message.method === "desktop/interaction/reply" && handlers.interaction !== undefined) {
        const params = asRecord(message.params)
        const decision = asRecord(params?.decision)
        if (typeof params?.requestId !== "string" || params.requestId === ""
          || typeof params.sessionId !== "string" || params.sessionId === ""
          || decision === undefined
          || !(decision.kind === "approval" && typeof decision.approved === "boolean"
            || decision.kind === "question" && typeof decision.answer === "string")) {
          send(makeFailure(message.id, INVALID_PARAMS, "invalid interaction reply"))
          return
        }
        try {
          const reply = handlers.interaction.reply({
            requestId: params.requestId,
            sessionId: params.sessionId,
            decision: decision.kind === "approval"
              ? { kind: "approval", approved: decision.approved as boolean }
              : { kind: "question", answer: decision.answer as string },
          })
          send(makeSuccess(message.id, reply))
        } catch (error) {
          send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if (message.method === "desktop/review/changes" && handlers.review !== undefined) {
        try {
          send(makeSuccess(message.id, await handlers.review.changes()))
        } catch (error) {
          send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
        }
        return
      }

      if ((message.method === "desktop/review/diff" || message.method === "desktop/review/file") && handlers.review !== undefined) {
        const params = asRecord(message.params)
        const maxBytes = params?.maxBytes
        if (typeof params?.path !== "string" || params.path === ""
          || (maxBytes !== undefined && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1))) {
          send(makeFailure(message.id, INVALID_PARAMS, "path must be text and maxBytes a positive integer"))
          return
        }
        try {
          const result = message.method === "desktop/review/diff"
            ? await handlers.review.diff(params.path, maxBytes as number | undefined)
            : await handlers.review.file(params.path, maxBytes as number | undefined)
          send(makeSuccess(message.id, result))
        } catch (error) {
          send(makeFailure(message.id, error instanceof ReviewPathError ? INVALID_PARAMS : INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error)))
        }
        return
      }

      send(makeFailure(message.id, METHOD_NOT_FOUND, `unknown method: ${message.method}`))
    },
    async close() {
      if (closed) return
      closed = true
      for (const controller of compacting.values()) controller.abort()
      for (const sessionId of activePrompts.keys()) {
        const id = `desktop-internal-${randomUUID()}`
        internalIds.add(id)
        try { await base.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId } })) }
        finally { internalIds.delete(id) }
      }
      await Promise.allSettled([...compactJobs])
      await base.close()
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
