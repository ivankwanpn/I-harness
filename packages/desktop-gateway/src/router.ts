import {
  decodeFrame,
  INTERNAL_ERROR,
  INVALID_REQUEST,
  isRpcRequest,
  isRpcSuccess,
  makeFailure,
  makeSuccess,
  METHOD_NOT_FOUND,
} from "@i-harness/sdk"
import type { SdkServer } from "@i-harness/sdk/server"
import type { DesktopHandlers, GatewayWrite } from "./types.ts"

/** Augment only an initialize reply, without modifying the SDK server's object. */
export function createGatewayWrite(send: GatewayWrite, handlers: DesktopHandlers): GatewayWrite {
  return (frame) => {
    if (!isRpcSuccess(frame) || !isInitializeResult(frame.result)) {
      send(frame)
      return
    }
    const capabilities = { ...frame.result.capabilities }
    if (handlers.sandboxState !== undefined) capabilities["desktop-sandbox"] = ["1"]
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

      send(makeFailure(message.id, METHOD_NOT_FOUND, `unknown method: ${message.method}`))
    },
    async close() {
      if (closed) return
      closed = true
      await base.close()
    },
  }
}
