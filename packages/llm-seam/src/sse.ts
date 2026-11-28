import type { LLMStreamEvent } from "./index.ts"

/**
 * One SSE framer for every adapter.
 *
 * Two defects came from each adapter hand-rolling this: splitting on "\n\n"
 * alone never frames a CRLF stream (the whole response collapses into the
 * final buffer), and taking only the first `data:` line drops every
 * continuation line. The openai-compatible adapter had already fixed both in
 * its own copy; this is that behaviour, shared.
 */
export interface SseFrame {
  data: string
  event?: string
}

/** Unwind the body reader before the decoder yields a terminal failure.
 * A consumer can keep the iterator suspended on that event indefinitely. */
export function* forwardSseEvents(events: LLMStreamEvent[]): Generator<LLMStreamEvent> {
  for (const event of events) {
    if (event.type === "error") throw event.error
    yield event
  }
}

/** A body acquired here is cancelled on early exit. Callers supplying an
 * existing reader retain ownership of its lock and cancellation policy. */
export async function* readSseBlocks(source: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const owned = "getReader" in source
  const reader = owned ? source.getReader() : source
  let eof = false
  try {
    const decoder = new TextDecoder()
    let buffer = ""
    let previousCR = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) eof = true
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (text.length) {
        if (previousCR && text.startsWith("\n")) text = text.slice(1)
        previousCR = text.endsWith("\r")
        const scan = Math.max(0, buffer.length - 1)
        buffer += text.replace(/\r\n?/g, "\n")
        let start = 0
        for (let end = buffer.indexOf("\n\n", scan); end >= 0; end = buffer.indexOf("\n\n", start)) {
          yield buffer.slice(start, end)
          start = end + 2
        }
        buffer = buffer.slice(start)
      }
      if (done) break
    }
    if (buffer.trim()) yield buffer
  } finally {
    if (owned) {
      if (!eof) void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const chunk of text.replace(/\r\n|\r/g, "\n").split("\n\n")) {
    const data: string[] = []
    let event: string | undefined
    for (const line of chunk.split("\n")) {
      if (line === "" || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? "" : line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "data") data.push(value)
      else if (field === "event") event = value
    }
    if (data.length === 0) continue
    frames.push(event === undefined ? { data: data.join("\n") } : { data: data.join("\n"), event })
  }
  return frames
}
