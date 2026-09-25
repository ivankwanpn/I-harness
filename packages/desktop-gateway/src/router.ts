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

/** Augment only an initialize reply, without modifying the SDK server's object. */
export function createGatewayWrite(send: GatewayWrite, handlers: DesktopHandlers): GatewayWrite {
  return (frame) => {
    if (!isRpcSuccess(frame) || !isInitializeResult(frame.result)) {
      send(frame)
      return
    }
    const capabilities = { ...frame.result.capabilities }
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

export function createDesktopRouter(base: SdkServer, send: GatewayWrite, handlers: DesktopHandlers): {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
} {
  let initialized = false
  let closed = false

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
        await base.handleLine(line)
        return
      }

      if (!initialized) {
        send(makeFailure(message.id, INVALID_REQUEST, "not initialized: send initialize first", {
          reason: "not_initialized",
        }))
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
      await base.close()
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
