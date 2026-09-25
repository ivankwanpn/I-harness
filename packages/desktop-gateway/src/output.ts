import { createBoundedWriter, type RpcMessage } from "@i-harness/sdk"

export interface GatewayOutputSink {
  write(chunk: string): boolean
  end(): void
  onDrain(callback: () => void): () => void
}

/** Keep the SDK's bound while giving the host a terminal signal and a drainable close. */
export function createGatewayOutput(sink: GatewayOutputSink, boundBytes: number, onTerminal: () => void) {
  let ended = false
  let finishing: Promise<void> | undefined
  const end = () => {
    if (ended) return
    ended = true
    sink.end()
  }
  const writer = createBoundedWriter({
    ...sink,
    boundBytes,
    end: () => { end(); onTerminal() },
  })

  return {
    push(frame: RpcMessage) { if (!ended) writer.push(frame) },
    finish(): Promise<void> {
      return finishing ??= new Promise<void>((resolve) => {
        if (ended) { resolve(); return }
        const check = () => {
          if (ended) { resolve(); return }
          if (writer.pendingBytes() === 0) { end(); resolve(); return }
          sink.onDrain(check)
        }
        check()
      })
    },
  }
}
