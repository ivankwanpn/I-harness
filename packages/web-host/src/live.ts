import { subscribe, type Session, type SessionEvent } from "@i-harness/core-session"

export interface AgentState {
  status: "running" | "idle" | "tool"
  tool?: string
}

/**
 * Parks the generator until `wake()` fires or the signal aborts, whichever
 * comes first. Resolves immediately when the signal is already aborted so the
 * generator unwinds promptly — mux close() aborts every open stream and then
 * awaits its pump, so a generator parked on a never-settling promise would
 * hang `close()` forever (Task 4 review note).
 */
function park(signal: AbortSignal | undefined, setWake: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const onAbort = (): void => resolve()
    signal?.addEventListener("abort", onAbort, { once: true })
    setWake((): void => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    })
  })
}

/**
 * Live views over one in-memory session. Every stream subscribes at open time
 * (core-session delivers only appends AFTER subscribe — no history replay;
 * paged history comes from the HTTP events route instead). All three
 * generators take an optional AbortSignal so the mux opener can pass its
 * per-stream signal through: abort → return, keeping `WebSocketMuxServer
 * .close()` resolvable. Drain-then-park structure: the listener only mutates
 * the buffer/accumulator/queue, so bursts that land while the generator is
 * suspended at a `yield` are still emitted on the next resume.
 */
export class LiveSessionStreams {
  private currentSession: Session
  // C1 (gen-forward rebind): active generators register a rebind hook here;
  // reattach() moves each open stream's subscribe() to the new Session
  // instance without ending the stream. Single-threaded JS makes the
  // unsubscribe/resubscribe swap atomic — no event can slip between.
  private readonly rebinds = new Set<(session: Session) => void>()

  constructor(session: Session) {
    this.currentSession = session
  }

  // C1 (persistence ↔ live seam, gen-forward): swap the backing Session.
  // Streams opened over a SNAPSHOT bundle — i.e. before attachLiveSession
  // ran, as the SPA does at session-select time — keep running but
  // re-subscribe to the attached instance, so appends made to it flow over
  // the already-open streams instead of being lost until reload. subscribe()
  // delivers only appends AFTER it (no history replay), so the swap
  // duplicates nothing; appends the live instance received BEFORE the swap
  // are not replayed (the embedder attaches before running the agent).
  reattach(session: Session): void {
    if (session === this.currentSession) return
    this.currentSession = session
    for (const rebind of [...this.rebinds]) rebind(session)
  }

  events(signal?: AbortSignal): AsyncIterable<SessionEvent> {
    const stream = this
    return (async function* () {
      const buffer: SessionEvent[] = []
      let wake: (() => void) | undefined
      const onEvent = (ev: SessionEvent): void => {
        buffer.push(ev)
        wake?.()
      }
      // Subscribe to the CURRENT session at first pull; a later reattach()
      // moves the subscription (same listener, same buffer) to the new one.
      let unsubscribe = subscribe(stream.currentSession, onEvent)
      const rebind = (session: Session): void => {
        unsubscribe()
        unsubscribe = subscribe(session, onEvent)
      }
      stream.rebinds.add(rebind)
      try {
        for (;;) {
          while (buffer.length > 0) {
            yield buffer.shift()!
          }
          await park(signal, (w) => { wake = w })
          if (signal?.aborted) return
        }
      } finally {
        stream.rebinds.delete(rebind)
        unsubscribe()
      }
    })()
  }

  /**
   * Chunk batching (spec §3.5): appended `assistant/chunk` text is COALESCED —
   * one frame per ~25 ms flush window (spec allows 16–33 ms) instead of one
   * frame per append. The stream terminates when `assistant/message` arrives
   * (the authoritative end of the assistant turn): any remaining buffered text
   * is flushed, then the generator returns. The flush timer is unref'd and
   * cleared in `finally`, so an ended/aborted stream never leaves a dangling
   * timer behind. Drain-then-park structure as in `events()`: the listener
   * only mutates the accumulator / flags, so bursts landing while suspended at
   * a yield are still flushed on the next resume.
   */
  chunks(signal?: AbortSignal): AsyncIterable<string> {
    const stream = this
    return (async function* () {
      const FLUSH_MS = 25
      let acc = ""
      let wake: (() => void) | undefined
      let timer: NodeJS.Timeout | undefined
      let ended = false
      const armTimer = (): void => {
        if (timer !== undefined) return // window already running — keep coalescing
        timer = setTimeout(() => {
          timer = undefined
          wake?.()
        }, FLUSH_MS)
        timer.unref() // a pending flush must not hold the process open
      }
      const onEvent = (ev: SessionEvent): void => {
        if (ev.type === "assistant/chunk") {
          acc += (ev as { text: string }).text
          armTimer()
        } else if (ev.type === "assistant/message") {
          ended = true // authoritative end → final flush, then terminate
          wake?.()
        }
      }
      // Rebindable subscription (see events()): a reattach() moves this
      // stream to the attached session; the accumulator/state carries over.
      let unsubscribe = subscribe(stream.currentSession, onEvent)
      const rebind = (session: Session): void => {
        unsubscribe()
        unsubscribe = subscribe(session, onEvent)
      }
      stream.rebinds.add(rebind)
      try {
        for (;;) {
          // Flush coalesced text only when the window elapsed (timer fired) or
          // the stream is terminating (assistant/message) — never per append.
          // Abort drops any un-flushed tail: the consumer is already gone.
          if (acc.length > 0 && (ended || (timer === undefined && !signal?.aborted))) {
            const text = acc
            acc = ""
            yield text
          }
          if (ended || signal?.aborted) return
          await park(signal, (w) => { wake = w })
          if (signal?.aborted) return
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        stream.rebinds.delete(rebind)
        unsubscribe()
      }
    })()
  }

  /**
   * Reasoning (thinking trace) stream: yielded as coalesced text like chunks
   * (one frame per ~25ms flush window), terminated by assistant/message (the
   * authoritative end of the assistant turn).
   */
  reasonings(signal?: AbortSignal): AsyncIterable<string> {
    const stream = this
    return (async function* () {
      const FLUSH_MS = 25
      let acc = ""
      let wake: (() => void) | undefined
      let timer: NodeJS.Timeout | undefined
      let ended = false
      const armTimer = (): void => {
        if (timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          wake?.()
        }, FLUSH_MS)
        timer.unref()
      }
      const onEvent = (ev: SessionEvent): void => {
        if (ev.type === "reasoning") {
          acc += (ev as { text: string }).text
          armTimer()
        } else if (ev.type === "assistant/message") {
          ended = true
          wake?.()
        }
      }
      let unsubscribe = subscribe(stream.currentSession, onEvent)
      const rebind = (session: Session): void => {
        unsubscribe()
        unsubscribe = subscribe(session, onEvent)
      }
      stream.rebinds.add(rebind)
      try {
        for (;;) {
          if (acc.length > 0 && (ended || (timer === undefined && !signal?.aborted))) {
            const text = acc
            acc = ""
            yield text
          }
          if (ended || signal?.aborted) return
          await park(signal, (w) => { wake = w })
          if (signal?.aborted) return
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        stream.rebinds.delete(rebind)
        unsubscribe()
      }
    })()
  }

  agentState(signal?: AbortSignal): AsyncIterable<AgentState> {
    const stream = this
    return (async function* () {
      // Queue every distinct transition instead of snapshotting a single
      // `{ status, tool }`: bursts appended while the generator is suspended
      // at a yield (before the first park) must each be observable, not
      // coalesced into the final state.
      //
      // Note (review, accepted minor): a client that reconnects mid-turn is
      // seeded `{ status: "idle" }` here — subscribe() has no history replay,
      // so the pre-subscribe state is unknowable; the next transition corrects
      // the snapshot. Deliberately not "fixed" (would require persisted state
      // replay into the live seam).
      const queue: AgentState[] = []
      let last: AgentState = { status: "idle" }
      let wake: (() => void) | undefined
      const onEvent = (ev: SessionEvent): void => {
        let next: AgentState | undefined
        if (ev.type === "turn/start") next = { status: "running" }
        else if (ev.type === "tool/call") next = { status: "tool", tool: (ev as { name?: string }).name }
        else if (ev.type === "tool/result") next = { status: "running" }
        else if (ev.type === "turn/end") next = { status: "idle" }
        if (next !== undefined && (next.status !== last.status || next.tool !== last.tool)) {
          last = next
          queue.push(next)
          wake?.()
        }
      }
      // Rebindable subscription (see events()); `last` carries over, so the
      // next transition on the attached session diffs against it normally.
      let unsubscribe = subscribe(stream.currentSession, onEvent)
      const rebind = (session: Session): void => {
        unsubscribe()
        unsubscribe = subscribe(session, onEvent)
      }
      stream.rebinds.add(rebind)
      try {
        yield { status: last.status }
        for (;;) {
          while (queue.length > 0) {
            const state = queue.shift()!
            yield { status: state.status, ...(state.tool === undefined ? {} : { tool: state.tool }) }
          }
          await park(signal, (w) => { wake = w })
          if (signal?.aborted) return
        }
      } finally {
        stream.rebinds.delete(rebind)
        unsubscribe()
      }
    })()
  }
}
