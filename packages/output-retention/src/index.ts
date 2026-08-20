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

interface ResolvedTextRetainerOptions {
  maxBytes: number
  mode: RetentionMode
  headRatio: number
}

// Validate fail-loud and resolve defaults. Defaults apply ONLY when a field is
// `undefined`; any other non-conforming runtime value (null, string, boolean,
// NaN, Infinity, ...) throws instead of being coerced or silently defaulted.
function resolveOptions(opts: TextRetainerOptions): ResolvedTextRetainerOptions {
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1) {
    throw new Error(`output-retention: maxBytes must be a positive integer (got ${opts.maxBytes})`)
  }
  const mode = opts.mode === undefined ? "headTail" : opts.mode
  if (typeof mode !== "string" || (mode !== "head" && mode !== "headTail")) {
    throw new Error(`output-retention: mode must be "head" or "headTail" (got ${String(mode)})`)
  }
  const headRatio = opts.headRatio === undefined ? DEFAULT_HEAD_RATIO : opts.headRatio
  if (typeof headRatio !== "number" || !Number.isFinite(headRatio) || !(headRatio > 0 && headRatio <= 1)) {
    throw new Error(`output-retention: headRatio must be in (0, 1] (got ${String(headRatio)})`)
  }
  return { maxBytes: opts.maxBytes, mode, headRatio }
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}

// Trim a string to at most `limitBytes` bytes without splitting a UTF-8
// multi-byte character: binary search the largest code-unit prefix within the
// byte budget, then back off so the kept prefix never ends by splitting a
// UTF-16 surrogate pair and never carries an unpaired surrogate from malformed
// input (slice() indexes code units, so an odd boundary can land between the
// two halves of a 4-byte code point).
function trimToBytes(text: string, limitBytes: number): string {
  if (text.length === 0 || Buffer.byteLength(text, "utf-8") <= limitBytes) return text
  let low = 0
  let high = text.length
  // binary search the largest code-unit prefix within the byte budget
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= limitBytes) low = mid
    else high = mid - 1
  }
  // Back off while the last kept unit is a high surrogate (a split pair, or an
  // unpaired high from malformed input) or an unpaired low surrogate. A low
  // surrogate is only paired when the preceding unit is its high half.
  while (low > 0) {
    const last = text.charCodeAt(low - 1)
    if (isHighSurrogate(last)) {
      low -= 1
    } else if (isLowSurrogate(last)) {
      if (low - 2 >= 0 && isHighSurrogate(text.charCodeAt(low - 2))) break
      low -= 1
    } else {
      break
    }
  }
  // A prefix always starts at index 0: if the text begins with an unpaired low
  // surrogate, any non-empty prefix would contain it, so keep nothing.
  if (low > 0 && isLowSurrogate(text.charCodeAt(0))) low = 0
  return text.slice(0, low)
}

// Keep the LAST whole characters of `text` within `limitBytes` bytes, walking
// from the end so the result ends with the original final characters whenever
// they fit in the budget. UTF-16 surrogate pairs are treated atomically (never
// split); an unpaired surrogate (high or low, i.e. malformed input) stops the
// walk so a lone surrogate is never emitted. Whole characters are appended to
// `parts` in reverse order and the array is reversed before joining so the
// walk stays O(1) per character.
function trimToBytesSuffix(text: string, limitBytes: number): string {
  if (text.length === 0 || Buffer.byteLength(text, "utf-8") <= limitBytes) return text
  const parts: string[] = []
  let used = 0
  let i = text.length
  while (i > 0) {
    const unit = text.charCodeAt(i - 1)
    if (isLowSurrogate(unit)) {
      // surrogate pair: include both halves atomically
      if (i - 1 === 0 || !isHighSurrogate(text.charCodeAt(i - 2))) break // unpaired low — skip it
      if (used + 4 > limitBytes) break
      parts.push(text.slice(i - 2, i))
      used += 4
      i -= 2
    } else {
      // UTF-8 byte length of a non-surrogate code unit: 1 (ASCII), 2 (<= U+07FF), else 3
      if (isHighSurrogate(unit)) break // unpaired high — stop the suffix here
      const charBytes = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3
      if (used + charBytes > limitBytes) break
      parts.push(text[i - 1])
      used += charBytes
      i -= 1
    }
  }
  parts.reverse()
  return parts.join("")
}

export function createTextRetainer(opts: TextRetainerOptions): TextRetainer {
  // Capture the validated values now so mutating `opts` later cannot bypass
  // validation or the byte budget.
  const { maxBytes, mode, headRatio } = resolveOptions(opts)
  const chunks: string[] = []

  return {
    push(chunk: string): void {
      chunks.push(chunk)
    },
    finish(): RetainedText {
      const full = chunks.join("")
      const fullBytes = Buffer.byteLength(full, "utf-8")
      if (fullBytes <= maxBytes) {
        return { text: full, truncated: false, omittedBytes: 0 }
      }
      if (mode === "head") {
        const kept = trimToBytes(full, maxBytes)
        return { text: kept, truncated: true, omittedBytes: fullBytes - Buffer.byteLength(kept, "utf-8") }
      }
      const headBytes = Math.floor(maxBytes * headRatio)
      const tailBytes = maxBytes - headBytes
      // The head prefix and tail suffix are byte-disjoint here because
      // headBytes + tailBytes === maxBytes < fullBytes, so the kept pieces
      // can never overlap or repeat characters.
      const head = trimToBytes(full, headBytes)
      const tail = trimToBytesSuffix(full, tailBytes)
      const keptBytes = Buffer.byteLength(head, "utf-8") + Buffer.byteLength(tail, "utf-8")
      return { text: head + tail, truncated: true, omittedBytes: fullBytes - keptBytes }
    },
  }
}
