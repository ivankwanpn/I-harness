import { createCompactionEngine, type CompactionConfig, type CompactionResult } from "@i-harness/compaction"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append, deriveMessages, deriveProjectionRewrite } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import { assertMessagesFromLog, clampOutputCap } from "@i-harness/llm-seam"
import { activeTokens, checkBudget, estimateContent } from "@i-harness/token-meter"
import type { Telemetry } from "@i-harness/telemetry"

export {
  executeToolCalls,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
  type BatchCall,
  type ExecuteToolCallsOptions,
} from "./execute-tool-calls.ts"
import { executeToolCalls, type BatchCall } from "./execute-tool-calls.ts"
export { createSessionExecutor, createSessionExecutorRegistry, mapSubmitToAdmission } from "./executor.ts"
export type { SessionExecutor, SessionExecutorDeps, SessionExecutorRegistry, AgentRunSurface, InputSubmit } from "./executor.ts"

// M20 budget/overflow control (absorb codex token-budget): `contextWindow` is
// the absolute context window; the agent budget is `contextWindow *
// reserveRatio` (default 0.9). Overflow at a step boundary triggers the
// three-layer ladder: layer 1 compact (M11 summary) → layer 2 pure reset
// (compaction.resetWindow, only when enabled) → layer 3 `prompt_too_long`
// fail-closed throw.
export interface AgentBudgetConfig {
  contextWindow: number // REQUIRED: total window the budget is computed against
  reserveRatio?: number // default 0.9; budget = contextWindow * reserveRatio
  resetWindow?: boolean // default true (allow layer 2 pure reset; false → straight to fail-closed)
  resetRetainLast?: number // default 20 (resetWindow keeps the last N events)
  // M33 §3.1: the host-known charge the session log does NOT carry (system
  // prompt + tool schemas) — added to the checkBudget measurement at every
  // boundary. 0 (default) = pre-M33 measurement.
  overheadTokens?: number
}

export interface AgentConfig {
  /** Prompt for every request. A STRING is fixed for the session. A FUNCTION is
   * resolved at the start of each step, for prompts that carry a fact the
   * session can change while the agent runs (the sandbox policy: see
   * session-executor/src/assembly.ts). */
  systemPrompt: string | (() => string)
  maxTurns?: number
  signal?: AbortSignal
  compact?: CompactionConfig // M11: enable context-pressure auto-compaction (requires contextWindow)
  budget?: AgentBudgetConfig // M20: absolute context budget + overflow ladder (requires contextWindow)
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10; 1 = serial)
  // NOTE: `model?: string` from the task brief collides with `AgentDeps.model`
  // (the ModelClient) under `AgentDeps & AgentConfig`, so the string selector
  // is dropped for M1 — the ModelClient IS the model configuration and the
  // `model` field of `LLMRequest` is not populated by the loop.
}

export interface AgentDeps {
  session: Session
  tools: ToolRegistry
  model: ModelClient
  // M19 (Ruling 24): the executing session's id, seeded onto every prepared
  // ToolExec so tool bodies can attribute the caller (agent-team resolves
  // team-tool callers from it). Additive: absent → ToolExec.sessionId stays
  // undefined (pre-M19 behavior).
  sessionId?: string
  // M25 (Ruling M25-P3): optional independent host telemetry stream — SEPARATE
  // from the session log (events here are never appended to it; the agent and
  // its tools cannot see them). Absent = no events at all (backward compat:
  // every pre-M25 deps object behaves byte-identically).
  telemetry?: Telemetry
  // M70: optional checkpoint capability handed to the tool scheduler — see
  // `ExecuteToolCallsOptions.flush`. The host builds it over its coordinator
  // (`() => coordinator.flush(sessionId)`), so the `tool/dispatch` marker is
  // durable BEFORE the tool body runs; a rejected flush fails the turn closed.
  // Absent → no checkpoint, byte-identical pre-M70 behavior (every existing
  // deps object, subagent hosts included).
  flush?: () => Promise<void>
  // R-A1: optional step-boundary input seam (steer tier). The loop calls it at
  // the START of every step (including the first) so mid-turn steering lands in
  // the log before the model sees this step's messages. The seam itself appends
  // the promoted user/messages to the session (inbox.claimAtStepBoundary).
  // Absent → byte-identical pre-R-A1 behavior.
  stepInputs?: { claimAtStepBoundary(): void }
  // M32 T3: per-session reasoning effort — copied VERBATIM onto every
  // LLMRequest of this agent (the adapter owns the wire translation; see
  // translateReasoning in the llm-* adapters). Absent → the request never
  // carries the field (缺省不發 — the provider's own default applies).
  reasoningEffort?: ReasoningEffort
  /** M72 Ⅱ: the resolved output cap for this session's model (undefined → the
   * adapter sends none). Read at request assembly, clamped there. */
  maxOutputTokens?: number
}

// M32: canonical ReasoningEffort lives in @i-harness/llm-seam (T2) — import
// for local use and re-export (G1 TEMPORARY declaration reconciled at merge).
import type { ReasoningEffort } from "@i-harness/llm-seam"
export type { ReasoningEffort }

export interface AgentResult {
  finalText: string
  turns: number
  reasoning: string[]
}

export interface Agent {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal): Promise<AgentResult>
  // M11: explicit manual compaction. Optional because a registry may hold
  // agents that were never configured with a compact seam (no engine). With no
  // compact config, `createAgent` still returns a `compact` that no-ops.
  // M33 §5: optional `instructions` are threaded to the summarizer (the
  // session-compact command surface).
  compact?(instructions?: string): Promise<CompactionResult>
}

/** M5 T2 (second half): one message as canonical JSON, for the per-request
 * prefix comparison. "The same message" has to mean the same CONTENT, not the
 * same construction order — a message rebuilt from a resumed log, or by a
 * producer that assembles its object in another order, must fingerprint
 * identically or the comparison reports a break that never happened. So object
 * keys are sorted (recursively), arrays keep their order (a tool-result run is
 * ordered), and `undefined`-valued keys are dropped the way `JSON.stringify`
 * drops them. Not exported: its only consumer is the comparison in
 * `createAgent`, in this file.
 *
 * ⚠ WHAT IT CALLS IDENTITY — and where it DISAGREES with the tree's other
 * definition of it. This fingerprints plain JSON structure: two values are the
 * same iff they have the same keys (order irrelevant) and the same values, with
 * array order significant. A value whose meaning lives in `toJSON` — a `Date`, a
 * `Map`/`Set`, a class instance — has no enumerable properties, so it collapses
 * to `{}`: measured, `canonicalJson(new Date(0)) === canonicalJson(new Date(1))
 * === "{}"`, while the seam's `assertMessagesFromLog` — which compares
 * `JSON.stringify` output — sees `"…:00.000Z"` against `"…:00.001Z"` and tells
 * them apart. The two definitions therefore disagree on exactly that class of
 * value. Deliberate, and NOT a behaviour to "fix": the model-visible surface is
 * derived from the JSON-persisted session log (tool args arrive via
 * `JSON.parse`), so nothing on this path produces such a value, and widening the
 * definition would change what `prefixKept` means for every input in order to
 * close a case nothing reaches. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  const maxTurns = deps.maxTurns ?? 20
  const maxParallel = deps.maxParallelToolCalls ?? 10
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallelToolCalls must be a positive integer (got ${maxParallel})`)
  }
  // M20 final review (Ruling 8a): budget config validation must fail LOUD here,
  // at agent creation. `checkBudget` validates `reserveRatio` but never
  // `contextWindow`: a non-finite one (e.g. a computed catalog value) made every
  // comparison `tokens > NaN === false` → state "ok" forever → the entire
  // compact→reset→fail-closed ladder silently dead. `resetRetainLast` already
  // failed closed at resetWindow time, but late/mislabeled — reject invalid
  // values at creation too. Absent optional fields keep their defaults; no
  // change to `resetWindow` runtime behavior.
  if (deps.budget !== undefined) {
    const { contextWindow, resetRetainLast, overheadTokens } = deps.budget
    if (!(Number.isFinite(contextWindow) && contextWindow > 0)) {
      throw new Error(`budget.contextWindow must be a finite positive number (got ${contextWindow})`)
    }
    if (resetRetainLast !== undefined && (!Number.isInteger(resetRetainLast) || resetRetainLast < 0)) {
      throw new Error(`budget.resetRetainLast must be a non-negative integer (got ${resetRetainLast})`)
    }
    // M33 §3.1: fail loud at creation like resetRetainLast — a NaN/negative
    // overhead would silently poison every comparison downstream.
    if (overheadTokens !== undefined && (!Number.isInteger(overheadTokens) || overheadTokens < 0)) {
      throw new Error(`budget.overheadTokens must be a non-negative integer (got ${overheadTokens})`)
    }
  }
  // M11: optional compaction seam. No `compact` config → no engine → the agent
  // behaves byte-identically to before this milestone.
  // M5/D2: the agent is the only layer that knows the shape the model sees, so
  // it hands the engine a getter — read at compact time, matching the LAST
  // request rather than whatever was true at construction. Without this the
  // summarizer falls back to its text form and the whole conversation is re-read
  // at full price; with it, the call is a byte-prefix of the main request and the
  // provider's cache serves it.
  const compactor = deps.compact
    ? createCompactionEngine({
        model: deps.model,
        config: deps.compact,
        // M73: compaction builds and sends its OWN model request, so it never
        // met the clamp the session's requests go through — on an anthropic
        // route that left the adapter's 128k fallback unclamped on the call
        // that runs BECAUSE the context is nearly full. The resolved cap is
        // handed down here; the engine clamps it against the window it
        // resolved (compaction's own `contextWindow`, above).
        ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
        requestShape: () => ({
          systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
          tools: deps.tools.schemas(),
        }),
      })
    : undefined
  const compactEnabled = deps.compact?.auto ?? true
  // M20: budget ladder config (`contextWindow`/`resetRetainLast` are validated
  // at creation above); the default matches the engine convention.
  const budgetCfg = deps.budget
  const resetAllowed = budgetCfg?.resetWindow ?? true
  const resetRetainLast = budgetCfg?.resetRetainLast ?? 20

  // M20: absolute-budget enforcement, called at every step boundary after
  // maybeCompact (pressure check) and before the model sees the derived
  // surface. Three layers:
  //  1. M11 compact (shadow-projection + summary) — fail-soft, never throws,
  //     falls through to layer 2 when compacted:false or still overflow.
  //  2. pure reset (absorption of codex token-budget) — ONLY when enabled
  //     (`budget.resetWindow !== false`); keeps the last resetRetainLast
  //     events visible, no summary. Fix round 1 (Ruling 4): append-only —
  //     the durable log is never truncated; checkBudget sees the post-reset
  //     surface because activeTokens prices exactly deriveMessages, which
  //     shadows the reset marker's removedSeqs (M11 shadow mechanism).
  //  3. fail-closed: throw `prompt_too_long` — the session cannot be brought
  //     under budget. No budget config → no-op (pre-M20 behavior).
  async function enforceBudget(): Promise<void> {
    if (budgetCfg === undefined) return
    // M33 §3.1: the host-known charge the session log does not carry (system
    // prompt + tool schemas) is added to EVERY boundary measurement.
    const overhead = budgetCfg.overheadTokens ?? 0
    const before = checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio, overhead)
    if (before.state === "ok") return
    // Layer 1: M11 compact (shadow-projection + summary).
    if (compactor) {
      await compactor.compact(deps.session)
      if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio, overhead).state === "ok") return
    }
    // Layer 2: pure reset (absorb codex token-budget) — keep the recent tail.
    if (compactor && resetAllowed) {
      await compactor.resetWindow(deps.session, resetRetainLast)
      if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio, overhead).state === "ok") return
    }
    // Layer 3: fail-closed.
    throw new Error(`prompt_too_long: context budget exceeded (${before.tokens} tokens > ${before.budget} budget)`)
  }
  // `steps`/`callSeq`/`reasoning` are shared across the agent's lifetime so a
  // followup continues the same step budget, call-id sequence and reasoning
  // trail as the original run.
  let steps = 0
  let callSeq = 0
  const reasoning: string[] = []
  // M5/D3: how many rewrite markers the log carried at the PREVIOUS request. A
  // bigger count next time means a rewrite landed in between, which is what
  // breaks the cached prefix — the absolute count is not a break, since it stays
  // non-zero forever after the first compaction. Undefined before the first
  // request: a resumed session has no predecessor to compare against, so the
  // first request claims nothing rather than guessing.
  let rewriteMarkers: number | undefined
  // M5 T2, second half: the PREVIOUS request's per-message fingerprints. It
  // lives here, beside `steps`/`callSeq`, for the same reason they do — a
  // followup continues the same conversation, so its first request must be
  // compared against the previous turn's LAST request, not against nothing.
  // Undefined before the first request: this process has sent nothing yet, so a
  // resumed session has no predecessor to compare with and claims none.
  let prevFingerprints: string[] | undefined

  async function runTurn(message: string, signal?: AbortSignal): Promise<AgentResult> {
    const abort = signal ?? deps.signal
    append(deps.session, { type: "turn/start" })
    // M25: host telemetry beside the session-log append (independent stream —
    // the session log itself is untouched; agent-invisible).
    deps.telemetry?.emit({ type: "turn/start", ts: Date.now(), data: { message } })
    append(deps.session, { type: "user/message", text: message })

    let needsContinuation = true
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      // Guard against an infinite tool-call loop: throw once steps exceed
      // the configured maximum (default 20).
      if (steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      // R-A1: steer-tier inputs arrive at the provider boundary — claimed
      // before step/start so deriveMessages below already includes them.
      deps.stepInputs?.claimAtStepBoundary()
      append(deps.session, { type: "step/start" })

      // M11 compaction: pressure check at the step boundary, before the model sees
      // the derived surface. Compaction only ever runs between steps.
      if (compactor && compactEnabled) await compactor.maybeCompact(deps.session)

      // M20 budget enforcement: absolute-budget check (compact→reset→fail-closed)
      // at the same boundary, after the pressure check and before the model sees
      // the surface.
      await enforceBudget()

      await ctx.emit("agent/pre-step", { task: message, session: deps.session })

      const messages = deriveMessages(deps.session)
      // Invariant at the seam (audit F01-3): the model may only ever see
      // messages that come from the session log. This passes trivially here
      // because the loop derives-and-rechecks from the log, but it is the
      // discipline point that keeps external producers honest.
      assertMessagesFromLog(messages, deps.session)

      const request: LLMRequest = {
        messages,
        tools: deps.tools.schemas(),
        systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
        // M72 Ⅱ: the cap the host resolved for this model, CLAMPED here because
        // this is the only place that holds all three inputs at once: the value
        // (deps), the window (budgetCfg) and the input we are about to send.
        // Estimated with the same meter the budget check uses, plus the same
        // overhead it charges — so the clamp and the compaction ladder agree on
        // what "the input" costs. Absent deps value → absent field.
        ...(deps.maxOutputTokens !== undefined
          ? {
              maxOutputTokens: clampOutputCap(
                deps.maxOutputTokens,
                budgetCfg?.contextWindow,
                estimateContent(messages) + (budgetCfg?.overheadTokens ?? 0),
              ),
            }
          : {}),
        // M32 T3: verbatim effort passthrough (absent → the field is never set;
        // the adapter's translateReasoning owns the wire vocabulary).
        ...(deps.reasoningEffort !== undefined ? { reasoningEffort: deps.reasoningEffort } : {}),
        // M61: the turn's abort signal rides the request so cancel reaches the
        // transport — the loop only checks `aborted` when an event ARRIVES, so
        // a provider parked on a silent socket could not be stopped.
        ...(abort !== undefined ? { signal: abort } : {}),
      }

      // M25: provider/call before the model stream opens.
      // NOTE (retry/start deferral): M12 tool retry (guard-retry) and M20
      // provider retry (llm-seam createRetryingClient) are both SILENT by
      // design and expose no callback/event seam — neither is wired into the
      // core-agent loop, so a retry is not observable from this layer. v0
      // emits no retry/start (a failed call still surfaces as provider/error
      // or tool/error); adding a retry hook to those packages is follow-up.
      // M5/D3: whether THIS request's prefix was rewritten by a marker that
      // arrived since the last one. Derived from the log rather than reported by
      // whoever rewrote it, so a rewrite path that forgets to announce itself
      // still shows up. Read beside T2-1's `reported:` numbers, which say
      // whether the provider actually charged full price.
      const rewrite = deriveProjectionRewrite(deps.session)
      const prefixRewritten = rewriteMarkers !== undefined && rewrite.markers > rewriteMarkers
      rewriteMarkers = rewrite.markers
      // M5 T2 (second half): the same question asked of our OWN bytes — this
      // request's message prefix against the previous request's. D3 above
      // attributes a count of rewrite MARKERS (the cause); this measures the
      // bytes themselves (the effect), so the two are read together. `shared` is
      // the number of leading messages that are byte-identical, and the previous
      // request is "still a prefix" only when every one of its messages is.
      const fingerprints = messages.map(canonicalJson)
      let shared = 0
      if (prevFingerprints !== undefined) {
        const limit = Math.min(fingerprints.length, prevFingerprints.length)
        while (shared < limit && fingerprints[shared] === prevFingerprints[shared]) shared += 1
      }
      const previous = prevFingerprints
      prevFingerprints = fingerprints
      deps.telemetry?.emit({
        type: "provider/call",
        ts: Date.now(),
        data: {
          step: steps,
          messages: messages.length,
          tools: request.tools.length,
          ...(prefixRewritten
            ? { prefixRewritten: true, ...(rewrite.lastCause !== undefined ? { prefixCause: rewrite.lastCause } : {}) }
            : {}),
          // M5 T2 (second half), the honesty rule: present ONLY when there was a
          // previous request to compare against. A resumed session's first
          // request reports NEITHER field — absent, never `shared: 0`, which is
          // a measurement it did not make and would read as a regression.
          // `prefixKept` is that measurement when it exists: how many of the
          // previous request's messages are still the identical head of this
          // one. `prefixBroke` says the rest is gone — a compaction's summary
          // takes the head, so this is 0/true on the request that follows one.
          ...(previous === undefined ? {} : { prefixKept: shared, prefixBroke: shared < previous.length }),
        },
      })

      let stepText = ""
      let toolCallsThisStep = 0
      // M5 T2: the provider's own usage report for THIS round-trip. Merged
      // rather than overwritten, because one request can report twice and each
      // report carries only its own fields.
      const stepUsage: Record<string, number> = {}
      const batch: BatchCall[] = []
      // M72 Ⅱ: this step's ending, decided by the provider's own terminal
      // literal (Task 6) and carried to the durable log below. Per-STEP, so
      // declared here rather than beside `steps`/`callSeq`: a truncated step
      // must not mark the next one, and a clean ending writes no field at all.
      let truncatedThisStep = false
      // M77: the sibling bit, same shape and same discipline — the seam's `end`
      // carries `refused` when the provider declined to produce content. The
      // wire literals stay in the adapters, and they are NOT one-per-wire: the
      // `content_filter` reason is read on both openai wires (as an
      // `incomplete_details.reason` on one, a `finish_reason` on the other), the
      // compatible wire ALSO reads the delta's own `refusal` field, gemini reads
      // its whole set of content-block `finishReason`s plus
      // `promptFeedback.blockReason`, and anthropic and bedrock read one stop
      // reason each. INDEPENDENT of `truncated` — a response can be capped AND
      // refused — so neither bit is the other's `else`, and a clean ending
      // writes no field at all.
      let refusedThisStep = false
      for await (const ev of deps.model.stream(request)) {
        if (abort?.aborted) throw new Error("agent aborted")
        switch (ev.type) {
          case "text/chunk":
            stepText += ev.text
            break
          case "reasoning":
            reasoning.push(ev.text)
            break
          case "tool_call": {
            callSeq += 1
            const callId = `call_${callSeq}`
            // M26 (R-D1): capture the seq BEFORE append — append assigns seq =
            // events.length, so the value below IS the tool/call event's
            // durable seq.
            const eventSeq = deps.session.events.length
            append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
            // M13: collect the call; execution happens after the stream ends so
            // the step's tool calls can run concurrently (bounded pool).
            batch.push({ callId, name: ev.call.name, args: ev.call.args, eventSeq })
            toolCallsThisStep += 1
            break
          }
          case "usage":
            // M5 T2. This `case` is the ONLY thing that turns a provider report
            // into something the host can see: the switch has no default and no
            // exhaustiveness assert, so without it the event is dropped in
            // silence — the run looks perfect and the numbers are simply absent.
            for (const [field, value] of Object.entries(ev.usage)) {
              if (typeof value === "number") stepUsage[field] = value
            }
            break
          case "error":
            deps.telemetry?.emit({ type: "provider/error", ts: Date.now(), data: { step: steps, error: ev.error.message } })
            throw new Error(`model stream error: ${ev.error.message}`)
          case "end":
            // M72 Ⅱ / M77. Recorded in TWO places on purpose: the durable log
            // (what a reopen reads) and the host's telemetry (what an operator
            // watches). Absent stays absent — a clean ending writes no field at
            // all, and neither bit is ever written as `false`.
            if (ev.truncated === true) {
              truncatedThisStep = true
              deps.telemetry?.emit({ type: "provider/truncated", ts: Date.now(), data: { step: steps } })
            }
            if (ev.refused === true) {
              refusedThisStep = true
              deps.telemetry?.emit({ type: "provider/refused", ts: Date.now(), data: { step: steps } })
            }
            break
        }
      }

      // M5 T2: emitted ONLY on a completed round-trip, and only if something was
      // actually reported. The event count is the denominator for every number
      // in it, so a round-trip that died mid-stream must not report: llm-seam's
      // retry wrapper is silent, and an attempt that failed and was retried
      // would otherwise be counted as its own reported request. No report at all
      // is the honest outcome — absent is not zero.
      if (Object.keys(stepUsage).length > 0) {
        deps.telemetry?.emit({ type: "provider/usage", ts: Date.now(), data: { ...stepUsage } })
      }

      if (batch.length > 0) {
        // M13: concurrent execution. The scheduler appends tool/result in model
        // order and emits agent/post-tool from its commit lane; it throws
        // "agent aborted" on step abort (draining + synthesizing results for
        // never-started calls). A tool BODY failure does not throw: the failed
        // call is filled with a synthetic failure result, its never-started
        // siblings get a cancellation result, and the turn continues so the
        // model sees the error and can retry. A POLICY refusal still throws — a
        // `prepare` refusal by site, a cascade veto by the marker
        // `isPolicyRefusal` reads. A failure of the commit lane itself is not
        // swallowed either: the fills still run and the lane's error is
        // rethrown, so a lost durable write fails the turn. (Before M5 T4
        // block ① every failure threw and the batch was discarded;
        // fs/src/error.ts records what that looked like outside.)
        await executeToolCalls(ctx, deps.session, deps.tools, batch, {
          maxParallel,
          signal: abort,
          sessionId: deps.sessionId,
          // M25: tool/start|end|error host telemetry rides the scheduler.
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
          // M70: the host's checkpoint seam rides the same way — absent stays
          // absent, so a deps object without one is byte-identical to pre-M70.
          ...(deps.flush ? { flush: deps.flush } : {}),
        })
      }

      // M77: a REFUSED step still appends this message, and its text stays `""`.
      // The choice is deliberate and is the spec's (§1.3): the log must carry
      // SOMETHING for the step either way, and putting the semantics in the text
      // would make them unreadable to a program — "the model said nothing" and
      // "the model was blocked" would stay indistinguishable on the one surface
      // a reopen reads. The bit lives on `step/end.refused` below; the text is
      // the model's output and there was none.
      if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
      else if (toolCallsThisStep === 0) append(deps.session, { type: "assistant/message", text: "" })

      // M80: the THIRD ending, and the only one that carries no signal of its
      // own — a non-content success (HTTP 200, no text, no tool call, a bare
      // `end`: the ten non-content gemini stop reasons land here). Reported at
      // the step boundary, where both halves of the predicate are known. The
      // two bits above are EXCLUDED on purpose: a capped or refused step is
      // also text-less with no tool calls, and it already has its own, more
      // specific report — writing this one too would double-report it (M77
      // pinned that neither bit is the other's `else`, and the same discipline
      // holds on this side). A step whose only output was a tool call is NOT
      // empty: the call is content, and the loop continues on it.
      const emptyThisStep = stepText === "" && toolCallsThisStep === 0 && !truncatedThisStep && !refusedThisStep
      if (emptyThisStep) deps.telemetry?.emit({ type: "provider/empty", ts: Date.now(), data: { step: steps } })

      append(deps.session, { type: "step/end", ...(truncatedThisStep ? { truncated: true } : {}), ...(refusedThisStep ? { refused: true } : {}), ...(emptyThisStep ? { empty: true } : {}) })

      // Continuation: after a step with tool calls, run another step so the
      // model can produce its final message. A step without tool calls is a
      // final answer → loop ends (per-turn mock semantics).
      needsContinuation = toolCallsThisStep > 0
    }

    append(deps.session, { type: "turn/end" })
    // M25: turn/end + token/usage at the turn boundary. The token count is the
    // SAME estimate the M20 budget check uses (activeTokens over the derived
    // surface); guarded so an absent telemetry never pays for it.
    if (deps.telemetry) {
      deps.telemetry.emit({ type: "turn/end", ts: Date.now(), data: { turns: steps } })
      deps.telemetry.emit({ type: "token/usage", ts: Date.now(), data: { tokens: activeTokens(deps.session) } })
    }
    // M14: content may be a parts array (image-bearing); extract text parts
    // only. The final message is an assistant text message, but be robust.
    const last = deriveMessages(deps.session).at(-1)
    const finalText = typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.filter((p) => p.type === "text").map((p) => p.text).join("")
        : ""
    // E5 "stop" hooks seam: emit at the turn boundary so hook handlers observe
    // the final text and can refuse it (a listener throw propagates as the
    // turn's failure). No handlers → emit returns the payload unchanged
    // (zero behavior change; additive event, no session-log write).
    await ctx.emit("agent/stop", { session: deps.session, turns: steps, finalText })
    return { finalText, turns: steps, reasoning }
  }

  return {
    run: (task, signal) => runTurn(task, signal),
    followup: (message, signal) => runTurn(message, signal),
    compact: async (instructions?: string) =>
      compactor ? compactor.compact(deps.session, instructions) : { compacted: false, shadowedSeqs: [] },
  }
}

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  return {
    register: (sessionId, agent) => {
      agents.set(sessionId, agent)
    },
    get: (sessionId) => agents.get(sessionId),
    remove: (sessionId) => {
      agents.delete(sessionId)
    },
    entries: () => agents,
  }
}
