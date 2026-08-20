export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: number
}

export type RetentionMode = "head" | "headTail"

export interface TextRetainerOptions {
  maxBytes: number
  mode?: RetentionMode
  headRatio?: number
}

export interface TextRetainer {
  push(chunk: string): void
  finish(): RetainedText
}

const DEFAULT_HEAD_RATIO = 0.5

function validate(opts: TextRetainerOptions): void {
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1) {
    throw new Error(`output-retention: maxBytes must be a positive integer (got ${opts.maxBytes})`)
  }
  const mode = opts.mode ?? "headTail"
  if (mode !== "head" && mode !== "headTail") {
    throw new Error(`output-retention: mode must be "head" or "headTail" (got ${String(mode)})`)
  }
  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO
  if (!(headRatio > 0 && headRatio <= 1)) {
    throw new Error(`output-retention: headRatio must be in (0, 1] (got ${headRatio})`)
  }
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}

// Trim a string to at most `limitBytes` bytes without splitting a UTF-8
// multi-byte character: binary search the largest whole-character prefix
// within the byte budget, then back off if the boundary would cut a UTF-16
// surrogate pair in half (slice() indexes code units, so an odd boundary can
// land between the two halves of a 4-byte code point).
function trimToBytes(text: string, limitBytes: number): string {
  if (text.length === 0 || Buffer.byteLength(text, "utf-8") <= limitBytes) return text
  let low = 0
  let high = text.length
  // binary search the largest whole-character prefix within the byte budget
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= limitBytes) low = mid
    else high = mid - 1
  }
  // If the budget cut between the two halves of a surrogate pair, drop the
  // dangling high half so the kept prefix stays well-formed.
  if (low > 0 && low < text.length && isHighSurrogate(text.charCodeAt(low - 1)) && isLowSurrogate(text.charCodeAt(low))) {
    low -= 1
  }
  return text.slice(0, low)
}

export function createTextRetainer(opts: TextRetainerOptions): TextRetainer {
  validate(opts)
  const mode = opts.mode ?? "headTail"
  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO
  const chunks: string[] = []

  return {
    push(chunk: string): void {
      chunks.push(chunk)
    },
    finish(): RetainedText {
      const full = chunks.join("")
      const fullBytes = Buffer.byteLength(full, "utf-8")
      if (fullBytes <= opts.maxBytes) {
        return { text: full, truncated: false, omittedBytes: 0 }
      }
      if (mode === "head") {
        const kept = trimToBytes(full, opts.maxBytes)
        return { text: kept, truncated: true, omittedBytes: fullBytes - Buffer.byteLength(kept, "utf-8") }
      }
      const headBytes = Math.floor(opts.maxBytes * headRatio)
      const tailBytes = opts.maxBytes - headBytes
      const head = trimToBytes(full, headBytes)
      // Start the tail on a whole character: if the computed start would begin
      // with the low half of a surrogate pair, include the high half too (the
      // byte trim below still keeps the result within the tail budget).
      let tailStart = Math.max(0, full.length - Math.floor(tailBytes))
      if (tailStart > 0 && isLowSurrogate(full.charCodeAt(tailStart)) && isHighSurrogate(full.charCodeAt(tailStart - 1))) {
        tailStart -= 1
      }
      const tail = trimToBytes(full.slice(tailStart), tailBytes)
      const keptBytes = Buffer.byteLength(head, "utf-8") + Buffer.byteLength(tail, "utf-8")
      return { text: head + tail, truncated: true, omittedBytes: fullBytes - keptBytes }
    },
  }
}
