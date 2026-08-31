import type { PluginContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import type { ApprovalRequestWire, ApprovalResponseWire } from "./types.ts"

interface PendingApproval {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

// §3.6 approval waterfall: bridges the plugin approval seam (core-tools asks
// "may I run this?") to a web client. attach() registers the answerer; each
// request is emitted as an ApprovalRequestWire and parked until the client's
// ApprovalResponseWire arrives via respond() — or the timeout elapses, which
// decides `{ approved: false }` (fail-closed, audit F05-5: an unanswered
// approval can never approve).
export class ApprovalWaterfall {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly ctx: PluginContext,
    private readonly emit: (request: ApprovalRequestWire) => void,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /**
   * Registers the plugin approval answerer. Defaults to the constructor ctx;
   * B3-H3 passes each live agent's ctx — the pending map (and its fail-closed
   * timers) is shared, so one waterfall answers asks from ANY registered ctx.
   */
  attach(ctx: PluginContext = this.ctx): void {
    registerApprovalAnswerer(ctx, async (req) => {
      const wire: ApprovalRequestWire = {
        approvalId: crypto.randomUUID(),
        name: req.name,
        reason: req.reason,
        ...(req.command === undefined ? {} : { command: req.command }),
        ...(req.argv === undefined ? {} : { argv: req.argv }),
        ...(req.dangerClass === undefined ? {} : { dangerClass: req.dangerClass }),
        ...(req.pathSummary === undefined ? {} : { pathSummary: req.pathSummary }),
      }
      // Register the pending entry (and its fail-closed timer) BEFORE emit:
      // a synchronous respond() — e.g. a client answering inline inside the
      // emit callback — must find the entry, or the request would be lost.
      const approved = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(wire.approvalId)
          resolve(false) // fail-closed
        }, this.defaultTimeoutMs)
        // A pending approval must not keep the event loop alive: without
        // unref(), SIGINT would wait out the full timeout (30 s default).
        timer.unref()
        this.pending.set(wire.approvalId, {
          resolve: (decision) => {
            clearTimeout(timer)
            resolve(decision)
          },
          timer,
        })
        // Surface the request to the client only after registration; the
        // decision completes via respond() or the fail-closed timeout above.
        this.emit(wire)
      })
      return { approved }
    })
  }

  /** Resolves the pending approval for `response.approvalId`; false when the id is unknown/stale (e.g. already timed out). */
  respond(response: ApprovalResponseWire): boolean {
    const entry = this.pending.get(response.approvalId)
    if (entry === undefined) return false
    this.pending.delete(response.approvalId)
    entry.resolve(response.approved)
    return true
  }
}

// Mux side of the approval seam: owns the ApprovalWaterfall (its `emit` feeds
// this bridge) and adapts it to the mux `approval` stream. `open()` yields each
// emitted ApprovalRequestWire and STAYS OPEN — an approval stream carries every
// request of the session, not a single one; the client answers each with a
// `{ type: "approval", streamId, value }` mux message (controller ruling 1),
// which the mux routes back to respond() → the waterfall. Requests are
// broadcast to every open stream (multiple tabs each see the request; the
// waterfall's respond() is idempotent, so a second answer for the same
// approvalId is a no-op). A request emitted while NO stream is open is dropped:
// the fail-closed waterfall timeout decides it (audit F05-5), and the SPA is
// expected to open its approval stream at connect time, before any agent run.
export class ApprovalMuxBridge {
  private readonly waterfall: ApprovalWaterfall
  private readonly sinks = new Set<Sink>()
  private disposed = false

  constructor(ctx: PluginContext, defaultTimeoutMs?: number) {
    this.waterfall = new ApprovalWaterfall(
      ctx,
      (request) => { this.enqueue(request) },
      defaultTimeoutMs,
    )
  }

  /** Registers the plugin approval answerer (delegates to the owned waterfall). Defaults to the constructor ctx; B3-H3 passes each per-session live agent's ctx so asks from every agent flow into this bridge's mux streams. */
  attach(ctx?: PluginContext): void {
    this.waterfall.attach(ctx)
  }

  /** Client decision (mux `{type:"approval"}` message) → the waterfall; false when unknown/stale. */
  respond(response: ApprovalResponseWire): boolean {
    return this.waterfall.respond(response)
  }

  /**
   * The mux `approval` opener: yields each emitted ApprovalRequestWire and
   * never ends on its own (multiple approvals per session). `signal` is the
   * mux stream's AbortSignal — cancel / socket close / mux close must unwind
   * the generator, or the parked generator would hang the pump (the same
   * abort-awareness the live stream generators provide).
   */
  async *open(signal?: AbortSignal): AsyncGenerator<ApprovalRequestWire> {
    const queue: ApprovalRequestWire[] = []
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

  /** Ends every open approval stream (generator teardown; pending waterfall entries keep their own fail-closed timers). */
  dispose(): void {
    this.disposed = true
    for (const sink of [...this.sinks]) sink.wake()
  }

  private enqueue(request: ApprovalRequestWire): void {
    // Broadcast: every open stream sees the request. Multiple answers for the
    // same approvalId are collapsed by ApprovalWaterfall.respond's idempotency.
    for (const sink of [...this.sinks]) {
      sink.queue.push(request)
      sink.wake()
    }
  }
}

interface Sink {
  queue: ApprovalRequestWire[]
  wake: () => void
}
