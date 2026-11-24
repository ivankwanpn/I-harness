import type { Writable } from "node:stream"
import { decodeFrame, DEFAULT_WRITE_BOUND_BYTES, encodeFrame, isRpcRequest, makeFailure, SERVER_OVERLOAD } from "@i-harness/sdk"
import type { DesktopHostCommand } from "@i-harness/desktop-gateway/src/host-protocol.ts"

/** Node's writable owns the FIFO and EOF. Bound additional data behind a
 * blocked write, independently of the size of the frame already in flight. */
export function createHostCommandWriter(
  sink: Writable,
  reply: (workspaceId: string, line: string) => void,
  boundBytes = DEFAULT_WRITE_BOUND_BYTES,
) {
  let queuedBytes = 0
  return {
    send(command: DesktopHostCommand) {
      if (!sink.writable) throw new Error("Desktop host input is closed")
      const line = JSON.stringify(command) + "\n"
      if (command.type !== "data" || !sink.writableNeedDrain) {
        sink.write(line)
        return
      }
      const bytes = Buffer.byteLength(line)
      if (queuedBytes + bytes > boundBytes) {
        const request = decodeFrame(command.line)
        const message = "Desktop host input queue is full. Retry after the pending requests settle."
        if (!isRpcRequest(request)) throw new Error(message)
        reply(command.workspaceId, encodeFrame(makeFailure(request.id, SERVER_OVERLOAD, message, { retryable: true })))
        return
      }
      queuedBytes += bytes
      try { sink.write(line, () => { queuedBytes -= bytes }) }
      catch (error) { queuedBytes -= bytes; throw error }
    },
    end() { sink.end() },
  }
}
