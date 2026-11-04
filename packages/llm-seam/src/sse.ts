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
