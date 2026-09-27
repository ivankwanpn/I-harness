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
import { createProviderProbes } from "./provider-probes.ts"

/** Augment only an initialize reply, without modifying the SDK server's object. */
export function createGatewayWrite(send: GatewayWrite, handlers: DesktopHandlers, internalIds: Set<string> = new Set()): GatewayWrite {
  return (frame) => {
    if ("id" in frame && internalIds.has(String(frame.id))) return
    if (!isRpcSuccess(frame) || !isInitializeResult(frame.result)) {
      send(frame)
      return
    }
    const capabilities = { ...frame.result.capabilities }
    if (handlers.agentSettings) capabilities["desktop-agent-settings"] = ["1"]
    if (handlers.terminal) capabilities["desktop-terminal"] = ["1"]
    if (handlers.plugins) capabilities["desktop-plugins"] = ["1"]
    if (handlers.rewind) capabilities["desktop-rewind"] = ["1"]
    if (handlers.sessions) capabilities["desktop-sessions"] = ["1"]
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
  const probes = handlers.provider ? createProviderProbes(handlers.provider) : undefined
  const modelSwitches = new Map<string, Promise<unknown>>()

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
        if (typeof scopedSessionId === "string" && modelSwitches.has(scopedSessionId)
          && ["session/prompt", "session/model/set", "session/rewind/execute"].includes(message.method)) {
          send(makeFailure(message.id, INVALID_REQUEST, "session model change is running", { reason: "session_busy" })); return
        }
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
        if (message.method === "session/model/set" && typeof scopedSessionId === "string") {
          if (activePrompts.has(scopedSessionId)) { send(makeFailure(message.id, INVALID_REQUEST, "session is busy", { reason: "session_busy" })); return }
          const job = Promise.resolve().then(() => base.handleLine(line))
          modelSwitches.set(scopedSessionId, job)
          try { await job } finally { modelSwitches.delete(scopedSessionId) }
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

      if ((message.method === "desktop/agent-settings/state" || message.method === "desktop/agent-settings/configure") && handlers.agentSettings) {
        try { send(makeSuccess(message.id, message.method.endsWith("/state") ? await handlers.agentSettings.state() : await handlers.agentSettings.configure(message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method.startsWith("desktop/rewind/") && handlers.rewind) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        const operation = message.method.slice("desktop/rewind/".length)
        if (typeof sessionId !== "string" || !sessionId || !["points", "plan", "execute"].includes(operation)
          || (operation !== "points" && (typeof params?.target !== "number" || !Number.isInteger(params.target) || params.target < 0 || !["all", "files", "conversation"].includes(String(params.mode))))
          || (operation === "execute" && (typeof params?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(params.fingerprint)))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid rewind request")); return
        }
        if (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return
        }
        const target = params?.target as number
        const mode = params?.mode as "all" | "files" | "conversation"
        const job = operation === "points" ? handlers.rewind.points(sessionId) : operation === "plan" ? handlers.rewind.plan(sessionId, target, mode) : handlers.rewind.execute(sessionId, target, mode, params!.fingerprint as string)
        modelSwitches.set(sessionId, job)
        try { send(makeSuccess(message.id, await job)) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        finally { modelSwitches.delete(sessionId) }
        return
      }
      if (message.method.startsWith("desktop/terminal/") && handlers.terminal) {
        try { send(makeSuccess(message.id, handlers.terminal.request(message.method, message.params))) }
        catch (error) { send(makeFailure(message.id, INVALID_PARAMS, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (["desktop/plugins/state", "desktop/plugins/mutate", "desktop/plugins/commands", "desktop/plugins/refresh"].includes(message.method) && handlers.plugins) {
        try {
          const result = message.method.endsWith("/state") ? await handlers.plugins.state() : message.method.endsWith("/commands") ? await handlers.plugins.commands() : message.method.endsWith("/refresh") ? (await handlers.plugins.refresh(), { ok: true }) : await handlers.plugins.mutate(message.params)
          send(makeSuccess(message.id, result))
        }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        return
      }
      if (message.method === "desktop/session/archived" && handlers.sessions) {
        try { send(makeSuccess(message.id, await handlers.sessions.archived())) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "Archived sessions unavailable")) }
        return
      }
      if (message.method === "desktop/session/manage" && handlers.sessions) {
        const params = asRecord(message.params)
        const sessionId = params?.sessionId
        const action = params?.action
        if (typeof sessionId !== "string" || !sessionId || !["rename", "archive", "restore", "fork"].includes(String(action))
          || (action === "rename" && (typeof params?.title !== "string" || !params.title.trim() || params.title.length > 256))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid session management request")); return
        }
        if (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId)) {
          send(makeFailure(message.id, INVALID_REQUEST, "Session is busy")); return
        }
        const job = handlers.sessions.mutate(sessionId, action as "rename" | "archive" | "restore" | "fork", params?.title as string | undefined)
        modelSwitches.set(sessionId, job)
        try { send(makeSuccess(message.id, await job)) }
        catch (error) { send(makeFailure(message.id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))) }
        finally { modelSwitches.delete(sessionId) }
        return
      }
      if ((message.method === "desktop/provider/probe" || message.method === "desktop/provider/probe/cancel") && probes) {
        const params = asRecord(message.params)
        if (typeof params?.token !== "string" || !params.token || params.token.length > 128
          || (message.method === "desktop/provider/probe" && (typeof params.id !== "string" || !params.id || params.id.length > 128))) {
          send(makeFailure(message.id, INVALID_PARAMS, "Invalid provider probe parameters")); return
        }
        try { send(makeSuccess(message.id, message.method.endsWith("/cancel") ? probes.cancel(params.token) : await probes.start(params.id as string, params.token))) }
        catch { send(makeFailure(message.id, INTERNAL_ERROR, "Provider probe failed or was cancelled. Check endpoint, protocol and credentials.")) }
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
        if (activePrompts.has(sessionId) || compacting.has(sessionId) || modelSwitches.has(sessionId)) {
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
      await probes?.close()
      await Promise.allSettled(modelSwitches.values())
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
