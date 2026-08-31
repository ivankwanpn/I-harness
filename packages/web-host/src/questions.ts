import type { PluginContext } from "@i-harness/core-plugin"
import { registerQuestionProvider } from "@i-harness/interaction"
import type { QuestionRequestWire, QuestionResponseWire } from "./types.ts"

interface PendingQuestion {
  resolve: (answer: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// §3.6 question waterfall (Task 3.3): bridges the plugin question seam
// (interaction's askUser → "questions/provider") to a web client, mirroring
// the ApprovalWaterfall shape. attach() registers the provider; each question
// is emitted as a QuestionRequestWire and parked until the client's
// QuestionResponseWire arrives via respond() — or the timeout elapses, which
// REJECTS the ask. Fail-closed, audit F05-5: unlike an approval (deny has a
// natural default), an unanswered question has NO safe default answer, so
// resolving with one would fabricate it — the asking code path must see an
// error instead.
export class QuestionWaterfall {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(
    private readonly ctx: PluginContext,
    private readonly emit: (request: QuestionRequestWire) => void,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /**
   * Registers the plugin question provider. Defaults to the constructor ctx;
   * web.ts passes each live agent's ctx — the pending map (and its fail-closed
   * timers) is shared, so one waterfall answers asks from ANY registered ctx.
   */
  attach(ctx: PluginContext = this.ctx): void {
    registerQuestionProvider(ctx, {
      ask: async (q) => {
        const wire: QuestionRequestWire = {
          questionId: crypto.randomUUID(),
          text: q.prompt,
          ...(q.id === "" ? {} : { kind: q.id }),
          ...(q.options !== undefined && q.options.length > 0 ? { options: q.options } : {}),
        }
        // Register the pending entry (and its fail-closed timer) BEFORE emit:
        // a synchronous respond() — e.g. a client answering inline inside the
        // emit callback — must find the entry, or the question would be lost.
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(wire.questionId)
            reject(new Error(`question unanswered (timeout): ${wire.questionId}`))
          }, this.defaultTimeoutMs)
          // A pending question must not keep the event loop alive: without
          // unref(), SIGINT would wait out the full timeout (30 s default).
          timer.unref()
          this.pending.set(wire.questionId, {
            resolve: (answer) => {
              clearTimeout(timer)
              resolve(answer)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
            timer,
          })
          // Surface the question to the client only after registration; the
          // answer completes via respond() or the fail-closed timeout above.
          this.emit(wire)
        })
      },
    })
  }

  /** Resolves the pending question for `response.questionId`; false when the id is unknown/stale (e.g. already timed out). */
  respond(response: QuestionResponseWire): boolean {
    const entry = this.pending.get(response.questionId)
    if (entry === undefined) return false
    this.pending.delete(response.questionId)
    // Runtime guard (fail-closed, never fabricate): a malformed answer is not
    // a client verdict — reject the ask instead of resolving with a coerced
    // string the caller would treat as the human's answer.
    if (typeof response.answer === "string") entry.resolve(response.answer)
    else entry.reject(new Error(`question response malformed: ${response.questionId}`))
    return true
  }
}

// Mux side of the question seam: owns the QuestionWaterfall (its `emit` feeds
// this bridge) and adapts it to the mux `question` stream. `open()` yields each
// emitted QuestionRequestWire and STAYS OPEN — a question stream carries every
// question of the session, not a single one; the client answers each with a
// `{ type: "answer", streamId, value }` mux message (approval ruling 1
// mirrored), which the mux routes back to respond() → the waterfall.
// Questions are broadcast to every open stream (multiple tabs each see the
// question; the waterfall's respond() is idempotent, so a second answer for
// the same questionId is a no-op). A question emitted while NO stream is open
// is dropped: the fail-closed waterfall timeout decides it (audit F05-5), and
// the SPA is expected to open its question stream at connect time, before any
// agent run.
//
// Note (task 3.3 review): the stream/broadcast machinery duplicates
// ApprovalMuxBridge node-for-node — kept separate on purpose so the shipped
// approval path stays untouched; a shared generic bridge would be a later
// refactor if a third interaction plane needs it.
export class QuestionMuxBridge {
  private readonly waterfall: QuestionWaterfall
  private readonly sinks = new Set<Sink>()
  private disposed = false

  constructor(ctx: PluginContext, defaultTimeoutMs?: number) {
    this.waterfall = new QuestionWaterfall(
      ctx,
      (request) => { this.enqueue(request) },
      defaultTimeoutMs,
    )
  }

  /** Registers the plugin question provider (delegates to the owned waterfall). Defaults to the constructor ctx; web.ts passes each per-session live agent's ctx so asks from every agent flow into this bridge's mux streams. */
  attach(ctx?: PluginContext): void {
    this.waterfall.attach(ctx)
  }

  /** Client answer (mux `{type:"answer"}` message) → the waterfall; false when unknown/stale. */
  respond(response: QuestionResponseWire): boolean {
    return this.waterfall.respond(response)
  }

  /**
   * The mux `question` opener: yields each emitted QuestionRequestWire and
   * never ends on its own (multiple questions per session). `signal` is the
   * mux stream's AbortSignal — cancel / socket close / mux close must unwind
   * the generator, or the parked generator would hang the pump (the same
   * abort-awareness the live stream generators provide).
   */
  async *open(signal?: AbortSignal): AsyncGenerator<QuestionRequestWire> {
    const queue: QuestionRequestWire[] = []
    let wake: (() => void) | undefined
    const sink: Sink = { queue, wake: () => wake?.() }
    const onAbort = (): void => { wake?.() }
    signal?.addEventListener("abort", onAbort, { once: true })
    this.sinks.add(sink)
    try {
      while (!this.disposed && !(signal?.aborted ?? false)) {
        const request = queue.shift()
        if (request !== undefined) {
          yield request
          continue
        }
        // No interleave between the empty-queue check above and registering
        // `wake` here (the executor runs synchronously), so an emit racing the
        // wait cannot be missed.
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.sinks.delete(sink)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  /** Ends every open question stream (generator teardown; pending waterfall entries keep their own fail-closed timers). */
  dispose(): void {
    this.disposed = true
    for (const sink of [...this.sinks]) sink.wake()
  }

  private enqueue(request: QuestionRequestWire): void {
    // Broadcast: every open stream sees the question. Multiple answers for the
    // same questionId are collapsed by QuestionWaterfall.respond's idempotency.
    for (const sink of [...this.sinks]) {
      sink.queue.push(request)
      sink.wake()
    }
  }
}

interface Sink {
  queue: QuestionRequestWire[]
  wake: () => void
}
