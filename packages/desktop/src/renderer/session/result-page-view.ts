import type { ResultPageQuery, ResultPageResult } from "@i-harness/sdk"

type Page = Exclude<ResultPageResult, { kind: "unavailable" }>
type Ref = ResultPageQuery["ref"]
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const cursor = (value: unknown): value is {recordOffset:number;sliceOffset:number} => record(value) && safe(value.recordOffset) && safe(value.sliceOffset)
const sameCursor = (a: {recordOffset:number;sliceOffset:number}, b: {recordOffset:number;sliceOffset:number}) => a.recordOffset === b.recordOffset && a.sliceOffset === b.sliceOffset
export const resultRefIdentity = (ref: Ref): string => JSON.stringify([ref.version,ref.id,ref.revision,ref.codec,ref.encodedBytes,ref.contentDigest,ref.completeness])
function bytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) } catch { return }
}

/** Presentation checks only. Original owner still authorizes every read. */
export function acceptedResultPage(value: unknown, query: ResultPageQuery): Page | undefined {
  if (!record(value) || !record(value.ref)) return
  const ref = value.ref as unknown as Ref
  if (resultRefIdentity(ref) !== resultRefIdentity(query.ref) || typeof value.eof !== "boolean") return
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) return } catch { return }
  if (ref.codec !== "exec-frames-v1") {
    if (!safe(value.offset) || value.offset !== (query.offset ?? 0) || value.offset > ref.encodedBytes || !record(value.data)) return
    if (value.eof !== (value.nextOffset === null) || value.nextOffset !== null && (!safe(value.nextOffset) || value.nextOffset <= value.offset || value.nextOffset > ref.encodedBytes)) return
    const length = value.data.kind === "text" && typeof value.data.text === "string" ? new TextEncoder().encode(value.data.text).length : value.data.kind === "bytes" ? bytes(value.data.base64)?.length : undefined
    if (length === undefined || value.offset + length > (value.nextOffset ?? ref.encodedBytes)) return
  } else {
    if (!cursor(value.cursor) || value.cursor.recordOffset < 9 || value.cursor.recordOffset > ref.encodedBytes || !Array.isArray(value.frames)) return
    // The owner consumes its nine-byte magic header on the initial request.
    if (!sameCursor(value.cursor, query.cursor ?? {recordOffset:9,sliceOffset:0})) return
    if (value.eof !== (value.nextCursor === null)) return
    if (value.nextCursor !== null && (!cursor(value.nextCursor) || value.nextCursor.recordOffset > ref.encodedBytes || value.nextCursor.recordOffset < value.cursor.recordOffset || value.nextCursor.recordOffset === value.cursor.recordOffset && value.nextCursor.sliceOffset <= value.cursor.sliceOffset)) return
    let previous: {channel:unknown;frame:number;offset:number;length:number;end:unknown} | undefined
    for (const frame of value.frames) {
      if (!record(frame) || !["stdout","stderr"].includes(String(frame.channel)) || !safe(frame.frame) || !safe(frame.offset) || typeof frame.end !== "boolean") return
      const raw = bytes(frame.data)
      if (!raw) return
      if (previous && (frame.frame < previous.frame || frame.frame === previous.frame && (frame.channel !== previous.channel || frame.offset !== previous.offset + previous.length || previous.end))) return
      if (frame.text !== undefined) {
        if (!record(frame.text) || frame.text.kind !== "utf8-view" || typeof frame.text.text !== "string") return
        try { if (new TextDecoder("utf-8",{fatal:true}).decode(raw) !== frame.text.text) return } catch { return }
      }
      previous = {channel:frame.channel,frame:frame.frame,offset:frame.offset,length:raw.length,end:frame.end}
    }
    if (!value.frames.length && !value.eof) return
  }
  return value as unknown as Page
}
