// M49 Task 13 (spec §9.6): the status-line TRUTH SOURCE — pure logic only.
//
// Builtin aggregation: collectStatus() derives the row segments from REAL
// inputs (workspace, model state, context usage, queue/task projections,
// todo/goal) — an absent input renders NO segment (unknown is omitted, never a
// fabricated zero or default). The row is ONE fixed row; view-side fitting
// drops rightmost low-priority segments before truncating text.
//
// Command mode: createCommandStatusSource() wraps the injected runner (the
// apps/tui host wires @i-harness/exec with workspace cwd + JSON stdin +
// 1000ms timeout; this module owns the output discipline): control-code
// sanitization, first non-empty line, 4096-byte cap, ≥300ms refresh floor,
// and the two-failure retention rule (a third CONSECUTIVE failure shows the
// error indicator). Never blocking draw is the loop's call (fire-and-forget
// refresh guarded per interval).

import type { BackendModelState } from "../contracts.ts"

/** The segment kinds the builtin row can carry (spec §9.2 items). */
export type StatusLineSegmentKind =
  | "cwd" | "branch" | "model" | "context" | "turn-timer" | "session" | "queue" | "tasks"

/** The truthful builtin row state — every field OPTIONAL: present ONLY when
 * the corresponding real source exists. */
export interface StatusLineState {
  cwd?: string
  branch?: string
  model?: string
  context?: { used: number; total?: number }
  /** Turn elapsed in ms (present ONLY while a turn runs). */
  turnTimerMs?: number
  /** Session title/id when the host knows it. */
  session?: string
  /** Queued count (the `+N` chip). */
  queue?: number
  tasks?: { running: number }
  todo?: { done: number; total: number }
  goal?: string
}

/** The real aggregates the builtin row is derived from (absent = unknown). */
export interface StatusAggregateInput {
  workspace: string
  branch?: string
  modelState?: BackendModelState
  context?: { used: number; total?: number }
  turnTimerMs?: number
  session?: string
  queueState?: { running: boolean; queued: number }
  tasks?: { running: number }
  todo?: { done: number; total: number }
  goal?: string
}

/** buildin aggregation — only sourced segments come out; `items` (the persisted
 * tui.prefs.statusLine.items allowlist) gates the configurable kinds; the
 * always-if-sourced todo/goal segments are NOT part of the allowlist (they are
 * data chips, not the configurable surface). */
export async function collectStatus(
  input: StatusAggregateInput,
  opts: { items?: ReadonlyArray<StatusLineSegmentKind> } = {},
): Promise<StatusLineState> {
  const allowed = (kind: StatusLineSegmentKind): boolean =>
    opts.items === undefined || opts.items.includes(kind)

  const out: StatusLineState = {}
  if (input.workspace !== "") out.cwd = input.workspace
  if (input.branch !== undefined && input.branch !== "" && allowed("branch")) out.branch = input.branch
  if (input.modelState?.status === "ready" && allowed("model")) out.model = input.modelState.label
  if (input.context !== undefined && allowed("context")) {
    out.context = { ...input.context }
  }
  if (input.turnTimerMs !== undefined && input.turnTimerMs >= 0 && allowed("turn-timer")) {
    out.turnTimerMs = input.turnTimerMs
  }
  if (input.session !== undefined && input.session !== "" && allowed("session")) out.session = input.session
  if (input.queueState !== undefined && input.queueState.queued > 0 && allowed("queue")) {
    out.queue = input.queueState.queued
  }
  if (input.tasks !== undefined && input.tasks.running > 0 && allowed("tasks")) {
    out.tasks = { running: input.tasks.running }
  }
  if (input.todo !== undefined && input.todo.total > 0) out.todo = { ...input.todo }
  if (input.goal !== undefined && input.goal !== "") out.goal = input.goal
  return out
}

// ------------------------------------------------------------------ command source

/** The context serialized to the command's stdin (JSON on the wire side —
 * the HOST's runner owns the actual exec; this module only types the shape). */
export interface StatusCommandContext {
  workspace: string
  sessionId?: string
  sessionTitle?: string
  model?: string
  queue?: { running: boolean; queued: number }
  tasks?: number
  todo?: { done: number; total: number }
  goal?: string
  nowMs?: number
}

/** The injected runner: resolve the status text or throw (transient failure).
 * The HOST wires @i-harness/exec (workspace cwd, JSON context on stdin,
 * 1000ms timeout); tests inject scriptedStatusRunner literals. */
export type StatusRunner = (ctx: StatusCommandContext) => Promise<string>

export interface StatusCommandSource {
  refresh(ctx: StatusCommandContext): Promise<string>
}

export interface CommandStatusSourceOptions {
  /** Exec timeout (ms) — the source races the runner against it. */
  timeoutMs: number
  /** Refresh interval (ms) — clamped to the 300ms minimum (spec §9.6). */
  refreshMs: number
  /** The third-consecutive-failure indicator. */
  errorText?: string
}

export const STATUS_LINE_MIN_REFRESH_MS = 300
const MAX_OUTPUT_BYTES = 4096
const DEFAULT_ERROR_TEXT = "status command failed"

/** Strip ANSI/OSC sequences + stray C0/C1 control bytes (\\n and \\t survive —
 * the first-non-empty-line walk needs them). */
export function sanitizeStatusText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}


/** The first non-empty line, whitespace-trimmed (empty output → ""). */
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") return line.trim()
  }
  return ""
}

/** 4096-byte cap, character-safe (never cut a multi-byte rune in half). */
export function capStatusText(text: string): string {
  for (;;) {
    if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text
    text = text.slice(0, text.length - 1)
  }
}

export function createCommandStatusSource(
  runner: StatusRunner,
  opts: CommandStatusSourceOptions,
): StatusCommandSource {
  const errorText = opts.errorText ?? DEFAULT_ERROR_TEXT
  let consecutiveFailures = 0
  let lastGood: string | undefined

  const timeoutOf = (promise: Promise<string>): Promise<string> => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`status command timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })

  const run = async (ctx: StatusCommandContext): Promise<string> => {
    const output = await timeoutOf(runner(ctx))
    const text = capStatusText(firstNonEmptyLine(sanitizeStatusText(output)))
    if (text === "") throw new Error("status command produced no output")
    return text
  }

  return {
    /** Every explicit refresh runs the runner (the refresh CADENCE — "no
     * faster than 300ms" — belongs to the caller's clock (the loop's anim
     * pump skips the source when the interval has not elapsed); the source
     * only owns the output discipline + the two-failure retention. */
    async refresh(ctx) {
      try {
        const text = await run(ctx)
        consecutiveFailures = 0
        lastGood = text
        return text
      } catch {
        consecutiveFailures++
        if (consecutiveFailures <= 2 && lastGood !== undefined) {
          // two consecutive transient failures keep the last good value
          return lastGood
        }
        // third consecutive failure (or no good value yet) — error indicator
        return errorText
      }
    },
  }
}
