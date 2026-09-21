// M68 (M6 breadth, batch A): the bounded writer — the outbound queue between
// the server's onWrite and the host's stream.
//
// Three things are pinned here:
//   1. the in-bound path is byte-identical (the spec's §1.3 row 1: no new frame
//      on the normal write path — the sink sees exactly the frames it saw
//      before, in order);
//   2. the bound's ONE named outcome: a synthetic slow sink (a PassThrough with
//      a tiny highWaterMark and NO reader — there is no real consumer here and
//      this test says so) receives exactly ONE overload error frame and then
//      the stream ends, with every later push dropped;
//   3. the bound's DERIVATION: DEFAULT_WRITE_BOUND_BYTES is 2 × the serialized
//      size of one full session/history page (1000 events), and that page size
//      is recomputed here against the MEASURED literal.
import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import { append, createSession, type SessionEvent } from "@i-harness/core-session"
import { createBoundedWriter, DEFAULT_WRITE_BOUND_BYTES } from "../src/bounded-writer.ts"
import {
  INVALID_PARAMS,
  SERVER_OVERLOAD,
  decodeFrame,
  encodeFrame,
  makeFailure,
  makeNotification,
  makeSuccess,
  isRpcFailure,
  type RpcMessage,
  type RpcFailure,
} from "../src/protocol.ts"

/** The writing half of the writer's sink contract, over a real PassThrough
 * (the transport precedent is protocol.test.ts's "send() writes exactly one
 * frame"): every chunk handed to write() is recorded, so a test can enumerate
 * exactly what was written without depending on stream internals. */
interface RecordingSink {
  write(chunk: string): boolean
  end(): void
  onDrain(cb: () => void): () => void
  written: string[]
  endCalls: number
}

function recordingSink(stream: PassThrough): RecordingSink {
  const sink: RecordingSink = {
    written: [],
    endCalls: 0,
    write(chunk) {
      sink.written.push(chunk)
      return stream.write(chunk)
    },
    end() {
      sink.endCalls += 1
      stream.end()
    },
    onDrain(cb) {
      stream.once("drain", cb)
      return () => { stream.off("drain", cb) }
    },
  }
  return sink
}

/** Every line the sink DELIVERED (framing decoded) — read after the sink ended. */
async function readFrames(stream: PassThrough): Promise<RpcMessage[]> {
  let out = ""
  for await (const chunk of stream) out += String(chunk)
  return out.split("\n").filter((line) => line !== "").map((line) => {
    const message = decodeFrame(line)
    expect(message).toBeDefined() // every delivered line is a well-formed frame
    return message!
  })
}

describe("createBoundedWriter", () => {
  it("writes frames in order, byte-identical in-bound (the normal path gains nothing)", async () => {
    const stream = new PassThrough()
    const sink = recordingSink(stream)
    const writer = createBoundedWriter({ ...sink, boundBytes: DEFAULT_WRITE_BOUND_BYTES })

    const frames: RpcMessage[] = [
      makeSuccess(1, { ok: true }),
      makeNotification("session/event", { sessionId: "s1", event: { type: "turn/start", seq: 0 } }),
      makeFailure(2, INVALID_PARAMS, "bad params"),
    ]
    for (const frame of frames) writer.push(frame)

    expect(writer.pendingBytes()).toBe(0)
    expect(sink.written).toEqual(frames.map(encodeFrame))
    expect(sink.endCalls).toBe(0) // in-bound: the stream is never ended by us

    stream.end()
    expect(await readFrames(stream)).toEqual(frames)
  })

  it("overflow: exactly ONE overload frame (id null, -32000) then end; later pushes are dropped", async () => {
    // A synthetic slow sink: a PassThrough with a tiny highWaterMark, left
    // UNREAD. The first write is buffered by the stream and returns false;
    // with no reader nothing drains, so every later push queues in the writer.
    const stream = new PassThrough({ highWaterMark: 16 })
    const sink = recordingSink(stream)
    const writer = createBoundedWriter({ ...sink, boundBytes: 256 })

    const first = makeSuccess(0, { payload: "x".repeat(64) })
    writer.push(first)
    for (let i = 1; i < 20; i++) writer.push(makeSuccess(i, { payload: "x".repeat(64) }))

    // The queue was cleared for the overload frame, not written out.
    expect(writer.pendingBytes()).toBe(0)
    expect(sink.endCalls).toBe(1)

    // Enumerate EVERY frame written: the one in-bound frame (the write that
    // found the stream full) and the single overload frame. Nothing else — the
    // frames that queued behind the block were dropped, not written.
    expect(sink.written).toHaveLength(2)
    expect(decodeFrame(sink.written[0]!)).toEqual(first)
    const overload = decodeFrame(sink.written[1]!)
    expect(isRpcFailure(overload)).toBe(true)
    expect(overload).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: SERVER_OVERLOAD },
    })

    // The writer ended the stream — and the frames it says it wrote are the
    // frames the sink actually delivers.
    expect(stream.writableEnded).toBe(true)
    expect(await readFrames(stream)).toEqual([first, overload])

    // The stream is over: further pushes are dropped silently (no frame, no
    // second end, no error).
    for (let i = 100; i < 105; i++) writer.push(makeSuccess(i, { payload: "after" }))
    expect(sink.written).toHaveLength(2)
    expect(sink.endCalls).toBe(1)
    expect(writer.pendingBytes()).toBe(0)
  })

  it("pendingBytes counts BYTES (a multi-byte frame is not a String.length count)", () => {
    // highWaterMark 1: the first write lands in the stream and returns false,
    // so the SECOND frame stays queued and is what pendingBytes must measure.
    const stream = new PassThrough({ highWaterMark: 1 })
    const sink = recordingSink(stream)
    const writer = createBoundedWriter({ ...sink, boundBytes: 1_000_000 })

    const text = "日本語テキスト" // 7 chars, 21 UTF-8 bytes
    writer.push(makeSuccess(1, { text: "first" }))
    writer.push(makeSuccess(2, { text }))
    const queued = encodeFrame(makeSuccess(2, { text }))
    expect(writer.pendingBytes()).toBe(Buffer.byteLength(queued))
    expect(writer.pendingBytes()).toBeGreaterThan(queued.length)
  })
})

// ── the bound's derivation (spec §1.2 rule 1: derived, not chosen) ──────────
//
// MEASURED_HISTORY_PAGE_BYTES is the measurement recorded in
// packages/sdk/src/bounded-writer.ts (same mix, same numbers). The builder
// below is the measuring script verbatim; B is recomputed here so a change to
// the wire shape or to the mix cannot silently drift away from the constant.
const MEASURED_HISTORY_PAGE_BYTES = 947_820

const PROMPT_CHARS = 240
const REPLY_CHARS = 480
/** The repo's own prune threshold — packages/compaction/src/config.ts:100,
 * "stringified tool/result output length beyond which it becomes a prune
 * candidate" — taken as the tool/result content size (a conservative reading). */
const TOOL_RESULT_CHARS = 8192

function filler(n: number, seed: string): string {
  return seed.repeat(Math.ceil(n / seed.length)).slice(0, n)
}

/** A synthetic session log: 10 events per turn, 100 turns = 1000 events (the
 * session/history cap), built through the production createSession/append so
 * the seq stamping is the real one. */
function syntheticEvents(count: number): SessionEvent[] {
  const session = createSession()
  let turn = 0
  while (session.events.length < count) {
    turn += 1
    const callId = `call-${turn}`
    const block: SessionEvent[] = [
      { type: "turn/start" },
      { type: "user/message", text: filler(PROMPT_CHARS, `turn ${turn} prompt. `) },
      { type: "step/start" },
      { type: "assistant/chunk", text: filler(40, "thinking about ") },
      { type: "assistant/message", text: filler(REPLY_CHARS, `answer ${turn}. `) },
      { type: "tool/call", callId, name: "read_file", args: { path: `packages/sample/file-${turn}.ts` } },
      { type: "tool/dispatch", callId },
      { type: "tool/result", callId, name: "read_file", output: { content: filler(TOOL_RESULT_CHARS, `line ${turn} `) } },
      { type: "step/end" },
      { type: "turn/end" },
    ]
    for (const event of block) {
      if (session.events.length >= count) break
      append(session, event)
    }
  }
  return session.events
}

/** The bytes of ONE full session/history response frame (server.ts's shape:
 * makeSuccess(id, { events, nextSeq })). */
function historyPageBytes(count: number): number {
  const events = syntheticEvents(count)
  return Buffer.byteLength(encodeFrame(makeSuccess(1, { events, nextSeq: events.length })))
}

describe("DEFAULT_WRITE_BOUND_BYTES (derived from a real history page)", () => {
  it("is 2 × the serialized size of one full 1000-event session/history page", () => {
    const B = historyPageBytes(1000)
    // The recomputation matches the measured literal: a wire-shape or mix drift
    // fails HERE rather than silently moving the constant.
    expect(B).toBe(MEASURED_HISTORY_PAGE_BYTES)
    // The derived rule (spec §1.2 rule 1): the page a lagging client is
    // receiving plus the next one both fit inside the bound, so a client that is
    // one full page behind is not killed while it catches up.
    expect(DEFAULT_WRITE_BOUND_BYTES).toBeGreaterThanOrEqual(B)
    expect(DEFAULT_WRITE_BOUND_BYTES).toBe(2 * MEASURED_HISTORY_PAGE_BYTES)
  })
})

describe("SERVER_OVERLOAD", () => {
  it("lives in the reserved server-error range and frames with a null id", () => {
    expect(SERVER_OVERLOAD).toBe(-32_000)
    const frame: RpcFailure = makeFailure(null, SERVER_OVERLOAD, "overloaded")
    expect(frame).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32_000, message: "overloaded" } })
  })
})
