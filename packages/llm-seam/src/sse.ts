import type { LLMRequest, LLMStreamEvent } from "./index.ts"

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
export function* forwardSseEvents(events: LLMStreamEvent[], request?: Pick<LLMRequest, "signal">): Generator<LLMStreamEvent> {
  for (const event of events) {
    if (event.type !== "usage") request?.signal?.throwIfAborted()
    if (event.type === "error") throw event.error
    yield event
  }
}

/** The protocol decides when a normal reply is complete. A classified
 * failure always ends the response, including a frame that also reports usage. */
export async function* decodeModelSse(
  body: ReadableStream<Uint8Array>,
  request: Pick<LLMRequest, "signal">,
  decode: (block: string) => LLMStreamEvent[],
  finish: () => Iterable<LLMStreamEvent>,
  complete?: () => boolean,
): AsyncGenerator<LLMStreamEvent> {
  try {
    let finalEvents: LLMStreamEvent[] = []
    for await (const block of readSseBlocks(body)) {
      const events = decode(block)
      if (complete?.() || events.some(event => event.type === "error")) {
        finalEvents = events
        break
      }
      for (const event of events) yield event
    }
    // The body is now released even if the consumer pauses on the usage
    // preceding an error or on text recovered from a terminal snapshot.
    for (const event of forwardSseEvents(finalEvents, request)) yield event
    request.signal?.throwIfAborted()
    for (const event of finish()) {
      if (event.type !== "usage") request.signal?.throwIfAborted()
      yield event
      if (event.type === "error") return
    }
  } catch (error) {
    if (request.signal?.aborted) throw error
    yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) }
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

/** Decode a single LF-normalized block supplied by readSseBlocks. */
export function parseSseBlock(block: string): SseFrame | undefined {
  let data: string | undefined
  let event: string | undefined
  for (let start = 0; start < block.length;) {
    const end = block.indexOf("\n", start)
    const line = end < 0 ? block.slice(start) : block.slice(start, end)
    start = end < 0 ? block.length : end + 1
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== "data" && field !== "event") continue
    const value = colon < 0 ? "" : line.slice(colon + (line.charCodeAt(colon + 1) === 32 ? 2 : 1))
    if (field === "event") event = value
    else data = data === undefined ? value : data + "\n" + value
  }
  if (data !== undefined) return event === undefined ? { data } : { data, event }
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of text.replace(/\r\n|\r/g, "\n").split("\n\n")) {
    const frame = parseSseBlock(block)
    if (frame) frames.push(frame)
  }
  return frames
}
