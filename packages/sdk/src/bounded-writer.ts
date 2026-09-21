// M68 batch A (M6 breadth): the outbound queue between the server's onWrite
// and the host's stream — the wire's write path gets a bound.
//
// The measured fact this file answers (M6 synthesis #15): `send()` and the
// CLI's onWrite discard `write()`'s boolean, so a client that stops reading
// makes the SERVER's heap grow without limit — and nothing in the tree read
// highWaterMark or waited for a drain. The server side stays untouched here
// (its responses and notifications must keep interleaving synchronously —
// linkClient in server.test.ts depends on it); the bound lives in this writer,
// which the HOST owns:
//
//   createSdkServer({ onWrite: (m) => writer.push(m) })
//
// Semantics (spec §1.2):
//   - `push` enqueues encodeFrame(message) — the normal path is byte-identical
//     (nothing is added to what the sink receives, in-bound).
//   - a flush loop writes while the sink accepts (`write()` → true) and the
//     queue is non-empty; the first `false` STOPS the loop and the writer waits
//     for a drain. Queued bytes = what is waiting BEHIND that backpressure
//     barrier; the frame that returned false already sits in the sink's own
//     buffer (so it is not double-counted).
//   - the ONE named outcome of a broken bound: drop the queue, write exactly
//     one SERVER_OVERLOAD failure frame (id: null), then end the output stream.
//     Every later push is dropped silently — the stream is over.
//   - recovery is the EXISTING pull surface (session/history after a
//     reconnect); this writer adds no in-band resync command.
import { encodeFrame, makeFailure, SERVER_OVERLOAD, type RpcMessage } from "./protocol.ts"

/** MEASURED 2026-09-22 (m68 batch A; the unit test recomputes this literal):
 * the bytes of ONE full session/history response frame — i.e.
 * `Buffer.byteLength(encodeFrame(makeSuccess(1, { events, nextSeq })))` for a
 * 1000-event log (HISTORY_LIMIT_CAP, server.ts) — built through the production
 * createSession/append with 10 events per turn × 100 turns:
 *   turn/start · user/message (240 chars) · step/start ·
 *   assistant/chunk (40) · assistant/message (480) · tool/call · tool/dispatch
 *   · tool/result (8192 chars — the repo's own prune threshold,
 *   packages/compaction/src/config.ts:100: "beyond which it becomes a prune
 *   candidate") · step/end · turn/end
 *
 * Command: a throwaway vitest file (deleted after the run):
 *   pnpm --filter @i-harness/sdk test
 * Numbers: 1000 events → frame = 947820 B (avg 947.8 B/event);
 *          500 events  → frame = 473865 B.
 * The throwing-away is why the unit test re-derives the same number: the mix
 * above is the measuring script's, kept verbatim beside the constant's pin. */
const MEASURED_HISTORY_PAGE_BYTES = 947_820

/** The default bound: 2 × one full history page. Derived, not chosen (spec
 * §1.2 rule 1): the lower bound comes from the existing session/history cap,
 * because a client that is one page behind must not be killed while catching
 * up — the page it is receiving AND the next one must both fit in the queue.
 * Hosts may pass their own bound; apps/cli wires this default to stdout. */
export const DEFAULT_WRITE_BOUND_BYTES = 2 * MEASURED_HISTORY_PAGE_BYTES

/** The writing half a bounded writer needs. `write` is the stream's own
 * (its boolean is the backpressure signal); `onDrain` registers the one-shot
 * resume and returns its unregister. */
export interface BoundedWriterSink {
  write(chunk: string): boolean
  end(): void
  onDrain(cb: () => void): () => void
}

export interface BoundedWriterOptions extends BoundedWriterSink {
  /** Unwritten queued BYTES beyond which the connection is cut. Bytes, not
   * frames: frame size is unbounded, bytes are the memory. */
  boundBytes: number
}

export interface BoundedWriter {
  /** Enqueue one message (encoded here). Dropped silently once overloaded. */
  push(message: RpcMessage): void
  /** Bytes currently queued behind backpressure (0 once the bound broke). */
  pendingBytes(): number
}

export function createBoundedWriter(opts: BoundedWriterOptions): BoundedWriter {
  if (!Number.isInteger(opts.boundBytes) || opts.boundBytes <= 0) {
    throw new Error(`createBoundedWriter: boundBytes must be a positive integer (got ${opts.boundBytes})`)
  }

  const queue: string[] = []
  let pending = 0
  /** The sink returned false: write nothing until its drain fires. Without
   * this, every later push would land in the stream's own buffer and the bound
   * would never see the memory it exists to bound. */
  let blocked = false
  let cancelDrain: (() => void) | undefined
  let flushing = false
  let over = false

  const flush = (): void => {
    if (over || flushing || blocked || queue.length === 0) return
    flushing = true
    while (queue.length > 0) {
      const chunk = queue.shift()!
      pending -= Buffer.byteLength(chunk)
      if (!opts.write(chunk)) {
        blocked = true
        break
      }
    }
    flushing = false
    if (blocked) {
      cancelDrain = opts.onDrain(() => {
        cancelDrain = undefined
        blocked = false
        flush()
      })
    }
  }

  /** The bound broke: one named outcome, no second path. */
  const overload = (): void => {
    over = true
    const at = pending
    const dropped = queue.length
    queue.length = 0
    pending = 0
    // Stop waiting for a drain that can no longer mean anything, then get the
    // ONE terminal frame out. Best effort: the sink may already be destroyed,
    // and the stream ends either way.
    cancelDrain?.()
    cancelDrain = undefined
    try {
      opts.write(encodeFrame(makeFailure(
        null,
        SERVER_OVERLOAD,
        `output bound exceeded: ${at} bytes queued over ${opts.boundBytes} (${dropped} frame(s) dropped); closing — reconnect and resume via session/history`,
      )))
    } catch { /* the terminal frame is best effort */ }
    try {
      opts.end()
    } catch { /* the stream is over either way */ }
  }

  return {
    push(message) {
      if (over) return // the stream is over: after the overload frame, silence
      const chunk = encodeFrame(message)
      queue.push(chunk)
      pending += Buffer.byteLength(chunk)
      // Flush BEFORE the bound check: a frame the sink accepts is delivered,
      // not queued — including one larger than the bound (its bytes then live
      // in the sink's buffer, not in this queue). What the bound measures is
      // the queue that backpressure strands.
      flush()
      if (pending > opts.boundBytes) overload()
    },
    pendingBytes() {
      return pending
    },
  }
}
