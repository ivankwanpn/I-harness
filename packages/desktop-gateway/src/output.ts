import { createBoundedFrameWriter, createBoundedWriter, type RpcMessage } from "@i-harness/sdk"
import type { DesktopHostEvent } from "./host-protocol.ts"

export interface GatewayOutputSink {
  write(chunk: string): boolean
  end(): void
  onDrain(callback: () => void): () => void
}

/** Keep the SDK's bound while giving the host a terminal signal and a drainable close. */
export function createGatewayOutput(sink: GatewayOutputSink, boundBytes: number, onTerminal: () => void) {
  return drainableOutput<RpcMessage>(sink, onTerminal, end => createBoundedWriter({ ...sink, boundBytes, end }))
}

export function createDesktopHostOutput(sink: GatewayOutputSink, boundBytes: number, onTerminal: () => void) {
  return drainableOutput<DesktopHostEvent>(sink, onTerminal, end => createBoundedFrameWriter(
    { ...sink, boundBytes, end }, frame => JSON.stringify(frame) + "\n",
    () => JSON.stringify({ type: "error", message: "Desktop host output overloaded" } satisfies DesktopHostEvent) + "\n",
  ))
}

function drainableOutput<T>(sink: GatewayOutputSink, onTerminal: () => void, create: (end: () => void) => { push(frame: T): void; pendingBytes(): number }) {
  let ended = false
  let finishing: Promise<void> | undefined
  let finishDrain: (() => void) | undefined
  let finishDone: (() => void) | undefined
  const end = () => {
    if (ended) return
    ended = true
    finishDrain?.()
    try { sink.end() } finally { finishDone?.() }
  }
  const writer = create(() => { try { end() } finally { onTerminal() } })

  return {
    abort: end,
    push(frame: T) { if (!ended) writer.push(frame) },
    finish(): Promise<void> {
      return finishing ??= new Promise<void>((resolve) => {
        finishDone = resolve
        if (ended) { resolve(); return }
        const check = () => {
          if (ended) { resolve(); return }
          if (writer.pendingBytes() === 0) { end(); resolve(); return }
          finishDrain = sink.onDrain(check)
        }
        check()
      })
    },
  }
}
