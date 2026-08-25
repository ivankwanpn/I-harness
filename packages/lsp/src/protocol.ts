// LSP base-protocol framing: Content-Length-delimited JSON-RPC over a byte
// stream (dsh framing pattern — parses only the Content-Length header).
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8")
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii")
  return Buffer.concat([header, body])
}

export class MessageDecoder {
  private buffer = Buffer.alloc(0)
  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: unknown[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break
      const headerText = this.buffer.subarray(0, headerEnd).toString("ascii")
      const lengthMatch = /^Content-Length:\s*(\d+)$/im.exec(headerText)
      if (!lengthMatch) throw new Error(`invalid Content-Length header: ${JSON.stringify(headerText)}`)
      const length = Number(lengthMatch[1])
      if (length > this.maxMessageBytes) throw new Error(`message of ${length} bytes exceeds the ${this.maxMessageBytes}-byte bound`)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break // incomplete body
      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      out.push(JSON.parse(body.toString("utf-8")))
    }
    return out
  }
}
