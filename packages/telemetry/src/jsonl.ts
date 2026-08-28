// packages/telemetry/src/jsonl.ts — stdout JSONL sink（每事件一行 JSON {ts, type, data}）
import type { TelemetrySink } from "./types.ts"

export function createJsonlSink(stream: NodeJS.WritableStream = process.stdout): TelemetrySink {
  return {
    onEvent: (ev) => {
      stream.write(JSON.stringify({ ts: ev.ts, type: ev.type, data: ev.data }) + "\n")
    },
  }
}
