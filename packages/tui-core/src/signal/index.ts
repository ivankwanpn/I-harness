// G2 signal handling — first signal graceful, second (within 1000ms) force.
//
// POSIX SIGINT/SIGTERM as well as Windows SIGBREAK go through the same
// SignalGate. The graceful window is 1000ms: graceful() then starts the
// teardown; a second signal inside the window escalates to force(). After the
// window expires the gate re-arms (a later signal gets a fresh graceful).
// An "exit" hook guarantees a final minimal cleanup even when the process
// exits without a signal (best-effort; process.on("exit") cannot be async —
// it only runs graceful if it has not already run).
//
// Windows note: in raw mode a console Ctrl+C is delivered as DATA (\x03) and
// handled by the input layer (see input/parser.ts), NOT as SIGINT. This module
// covers non-raw launches and driver/terminal-originated signals.

export interface SignalHandlersContext {
  /** Run the teardown sequence + exit(0). */
  graceful(): void
  /** exit(130) immediately. */
  force(): void
}

/** Structural subset of process used by the wiring (injectable for tests). */
export interface SignalEmitter {
  on(signal: string, handler: () => void): unknown
  once(signal: string, handler: () => void): unknown
  off(signal: string, handler: () => void): unknown
}

const GRACE_WINDOW_MS = 1000

/** Pure first/second decision: first() → "graceful" + arm; while armed, first() → "force". */
export class SignalGate {
  private armed = false

  first(): "graceful" | "force" {
    if (this.armed) return "force"
    this.armed = true
    return "graceful"
  }

  /** Disarm — the grace window elapsed or graceful() completed. */
  reset(): void {
    this.armed = false
  }

  get isArmed(): boolean {
    return this.armed
  }
}

export function installSignalHandlers(ctx: SignalHandlersContext, emitter: SignalEmitter = process, graceMs: number = GRACE_WINDOW_MS): () => void {
  const gate = new SignalGate()
  let timer: ReturnType<typeof setTimeout> | undefined

  const handle = (): void => {
    if (gate.first() === "graceful") {
      ctx.graceful()
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        gate.reset()
      }, graceMs)
    } else {
      ctx.force()
    }
  }

  emitter.on("SIGINT", handle)
  emitter.on("SIGTERM", handle)
  try {
    emitter.on("SIGBREAK", handle) // Windows-only; throws on POSIX
  } catch {
    /* POSIX has no SIGBREAK */
  }
  const onExit = (): void => {
    if (!gate.isArmed) {
      gate.first()
      ctx.graceful() // final cleanup — best effort, sync
    }
  }
  emitter.once("exit", onExit)

  return (): void => {
    if (timer !== undefined) clearTimeout(timer)
    emitter.off("SIGINT", handle)
    emitter.off("SIGTERM", handle)
    try {
      emitter.off("SIGBREAK", handle)
    } catch {
      /* never registered on POSIX */
    }
    emitter.off("exit", onExit)
  }
}
