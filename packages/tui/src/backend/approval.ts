// @i-harness/tui — G1 (M37b): approval/question bridge (seam-only) + store
// listing (M37b D3: `@i-harness/session-persistence` + `-jsonl` become tui
// deps; the m37a embedded.ts could not import them).
//
// What this is: a BackendClient EXTENSION (contracts.ts is NOT modified — the
// extended surface lives HERE). createApprovalBridge attaches to the
// SessionService's per-assembly plugin ctx via service.onAssembly and
// registers the interaction seams verbatim:
//   - registerApprovalAnswerer(ctx, fn) — fn maps an ApprovalRequest to a
//     PermissionSurface (spec §3.7), emits it on the 16ms-batched approvals()
//     stream, then awaits the host's decision (fail-closed 30s timeout →
//     { approved: false }, web-host parity, audit F05-5).
//   - registerQuestionProvider(ctx, provider.ask) — maps a UserQuestion to a
//     QuestionQuestion (spec §3.8), emits on questions(), awaits the answer
//     (timeout REJECTS — an unanswered question has no safe default).
// The seam is boolean-only: ApprovalDecision = { approved: boolean }, so
// Always/Never/Once/Reject map to that boolean HERE (see DECISION_MAP below);
// the optional { scope, feedback } of answerApproval are host-side records
// (the interaction + guard-approval seams carry no scope/persist surface —
// reported as a known gap; a future persist seam lands on the TUI host side).
//
// What goes through the EXISTING BackendClient: attachApproval() wraps a
// BackendClient (embedded.ts, M37a) with the bridge's streams, and the host
// wires listSessionsFromStore into it via the EmbeddedOptions.listSessions
// seam (embedded.ts untouched).
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { registerApprovalAnswerer, registerQuestionProvider } from "@i-harness/interaction"
import type { ApprovalDecision, ApprovalRequest, UserQuestion } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { BackendClient } from "../contracts.ts"
import type { PermissionSurface } from "../views/permission.ts"
import type { QuestionQuestion } from "../views/question.ts"
import { QUESTION_OPTION_KEYS } from "../views/question.ts"

// ------------------------------------------------------------------ constants

/** 16ms outbound batching (embedded.ts parity, spec §3.5). */
export const BATCH_MS = 16
/** Fail-closed approval timeout (web-host parity: 30s, unref'd). */
export const APPROVAL_TIMEOUT_MS = 30_000
/** Question timeout — REJECTS the ask (no safe default answer; web-host parity). */
export const QUESTION_TIMEOUT_MS = 30_000

// ------------------------------------------------------------------ decisions

/** The interaction seam is boolean-only. The TUI's Always/Never/Once/Reject
 * verdicts map to it here (the four verdicts the app sends through
 * answerApproval): */
export const DECISION_MAP = {
  /** Always allow: {scope} → yes, persisted host-side later (M38). */
  always: () => ({ approved: true }),
  /** Never allow: {scope} → deny. */
  never: () => ({ approved: false }),
  /** Yes, proceed / No, I trust it → yes (once). */
  once: () => ({ approved: true }),
  /** No, reject {feedback} → deny. */
  reject: () => ({ approved: false }),
} as const

// ------------------------------------------------------------------ surface mapping

function approvalKindOf(name: string): PermissionSurface["kind"] {
  const n = name.toLowerCase()
  if (n === "bash" || n === "pwsh") return "bash"
  if (n === "write") return "edit"
  if (n.startsWith("mcp_")) return "mcp"
  return "other"
}

/** ApprovalRequest (interaction, echo-consent M22 fields) → PermissionSurface
 * (spec §3.7). Scopes are suggested labels only ("Always allow: {scope}") —
 * the backend seam carries no real scope, so the app records the chosen one
 * with the answer; see the module header (D1 seam-only posture). */
export function approvalSurfaceOf(req: ApprovalRequest, id: string): PermissionSurface {
  const kind = approvalKindOf(req.name)
  const title = kind === "bash"
    ? req.command ?? req.name
    : kind === "edit" ? "Allow Edit?"
    : `Allow ${req.name}?`
  const detailParts = [req.reason]
  if (req.argv !== undefined && req.argv.length > 0) detailParts.push(req.argv.join(" "))
  if (req.pathSummary !== undefined) detailParts.push(req.pathSummary)
  const scopes =
    kind === "bash" ? [req.command ?? req.name]
    : kind === "edit" ? [req.pathSummary ?? req.name]
    : kind === "mcp" ? mcpScopesOf(req.name)
    : [req.name]
  return { id, kind, title, detail: detailParts.join("\n"), freeform: true, scopes }
}

/** MCP scope labels per spec §3.7: `all tools from {Server}` / `{Server} {action}`. */
function mcpScopesOf(name: string): string[] {
  const rest = name.slice(4) // strip "mcp_"
  const idx = rest.indexOf("_")
  const server = idx === -1 ? rest : rest.slice(0, idx)
  const action = idx === -1 ? "" : rest.slice(idx + 1)
  return [`all tools from ${server}`, ...(action.length > 0 ? [`${server} ${action}`] : [])]
}

// ------------------------------------------------------------------ bridge

export interface ApprovalBridgeService {
  /** Subscribe to assembly creation (fires once per already-stored assembly). */
  onAssembly(hook: (assembly: SessionAssembly) => void): () => void
  /** Resolve the (creating if necessary) assembly for a session; the bridge's
   * `ensureAttached(id)` uses it for a pre-existing live assembly. */
  assemblyFor(id: string): Promise<SessionAssembly>
}

export interface ApprovalBridge {
  /** 16ms-batched live permission surfaces (§3.7). Stays open per session. */
  approvals(): AsyncIterable<PermissionSurface>
  /** Resolve a pending approval. Unknown/stale id → no-op (the fail-closed
   * timeout already decided). `opts.scope` / `opts.feedback` are host-side
   * records — the seam is boolean-only (see module header). */
  answerApproval(
    surfaceId: string,
    decision: ApprovalDecision,
    opts?: { scope?: string; feedback?: string },
  ): Promise<void>
  /** 16ms-batched live questions (§3.8). Stays open per session. */
  questions(): AsyncIterable<QuestionQuestion>
  /** Resolve a pending question with the chosen/freeform answer. */
  answerQuestion(qid: string, choice: { value: string }): Promise<void>
}

interface PendingApproval {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

interface PendingQuestion {
  resolve: (answer: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** One 16ms-batched outbound queue (embedded.ts events() shape). */
function createOutQueue<T>(): { push(item: T): void; stream(): AsyncIterable<T> } {
  const items: T[] = []
  let timer: NodeJS.Timeout | undefined
  let wake: (() => void) | undefined
  return {
    push(item) {
      items.push(item)
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          wake?.()
        }, BATCH_MS)
        timer.unref()
      }
    },
    async *stream() {
      for (;;) {
        if (timer === undefined && items.length > 0) {
          yield items.shift()!
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
}

/** Wire the interaction seams onto every assembly ctx (idempotent). */
export function createApprovalBridge(service: ApprovalBridgeService): ApprovalBridge {
  const attachedCtxs = new Set<unknown>()
  const approvals = createOutQueue<PermissionSurface>()
  const questions = createOutQueue<QuestionQuestion>()
  const pendingApprovals = new Map<string, PendingApproval>()
  const pendingQuestions = new Map<string, PendingQuestion>()

  function attach(ctx: SessionAssembly["ctx"]): void {
    if (attachedCtxs.has(ctx)) return
    attachedCtxs.add(ctx)

    // Approval: register the pending entry BEFORE emit (a synchronous answer
    // inside the emit callback must find it — web-host lesson).
    registerApprovalAnswerer(ctx, async (req: ApprovalRequest) => {
      const id = randomUUID()
      approvals.push(approvalSurfaceOf(req, id))
      const approved = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingApprovals.delete(id)
          resolve(false) // fail-closed: unanswered never approves (audit F05-5)
        }, APPROVAL_TIMEOUT_MS)
        timer.unref()
        pendingApprovals.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, timer })
      })
      return { approved }
    })

    // Question: REJECT on timeout — an unanswered question has no safe default
    // (web-host parity).
    registerQuestionProvider(ctx, {
      ask: (q: UserQuestion) => {
        const id = randomUUID()
        questions.push(questionSurfaceOf(q, id))
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingQuestions.delete(id)
            reject(new Error(`question unanswered (timeout): ${id}`))
          }, QUESTION_TIMEOUT_MS)
          timer.unref()
          pendingQuestions.set(id, {
            resolve: (answer) => { clearTimeout(timer); resolve(answer) },
            reject: (error) => { clearTimeout(timer); reject(error) },
            timer,
          })
        })
      },
    })
  }

  service.onAssembly((assembly) => attach(assembly.ctx))

  return {
    approvals: () => approvals.stream(),
    async answerApproval(surfaceId, decision, opts) {
      const pending = pendingApprovals.get(surfaceId)
      if (pending === undefined) return // stale/timeout — already fail-closed
      pendingApprovals.delete(surfaceId)
      pending.resolve(decision.approved)
      // opts.scope / opts.feedback have NO seam to carry them today (the
      // interaction + guard-approval surfaces are boolean-only) — reserved.
      void opts
    },
    questions: () => questions.stream(),
    async answerQuestion(qid, choice) {
      const pending = pendingQuestions.get(qid)
      if (pending === undefined) return // stale/timeout — the ask already rejected
      pendingQuestions.delete(qid)
      if (typeof choice.value === "string") pending.resolve(choice.value)
      else pending.reject(new Error(`question answer malformed: ${qid}`))
    },
  }
}

// ------------------------------------------------------------------ question mapping

function questionSurfaceOf(q: UserQuestion, id: string): QuestionQuestion {
  const paras = q.prompt.split(/\n\n+/)
  const label = paras[0] ?? q.prompt
  const description = paras.length > 1 ? paras.slice(1).join("\n\n") : undefined
  return {
    id,
    label,
    ...(description !== undefined && description.length > 0 ? { description } : {}),
    options: (q.options ?? []).map((text, i): { key: string; label: string } => ({
      key: QUESTION_OPTION_KEYS[i] ?? "",
      label: text,
    })),
    multi: false, // the seam answers with ONE string (single-select quick-picks)
    freeform: true, // a user can always type freely (spec §3.8 `z` row)
  }
}

// ------------------------------------------------------------------ attach (BackendClient extension)

export interface ApprovalClient extends BackendClient {
  approvals(): AsyncIterable<PermissionSurface>
  answerApproval(
    surfaceId: string,
    decision: ApprovalDecision,
    opts?: { scope?: string; feedback?: string },
  ): Promise<void>
  questions(): AsyncIterable<QuestionQuestion>
  answerQuestion(qid: string, choice: { value: string }): Promise<void>
}

/**
 * Compose the existing BackendClient (embedded.ts, M37a) with the bridge:
 * every backend method is forwarded explicitly (the embedded methods use
 * `this`, so a `{ ...backend, ... }` spread would break their receiver); the
 * approval/question streams come from the bridge. contracts.ts stays closed.
 */
export function attachApproval(backend: BackendClient, bridge: ApprovalBridge): ApprovalClient {
  return {
    listSessions: () => backend.listSessions(),
    open: (id) => backend.open(id),
    submit: (prompt) => backend.submit(prompt),
    steer: (text) => backend.steer(text),
    cancel: () => backend.cancel(),
    events: () => backend.events(),
    seqCursor: () => backend.seqCursor(),
    replay: (afterSeq) => backend.replay(afterSeq),
    status: () => backend.status(),
    close: () => backend.close(),
    approvals: () => bridge.approvals(),
    answerApproval: (surfaceId, decision, opts) => bridge.answerApproval(surfaceId, decision, opts),
    questions: () => bridge.questions(),
    answerQuestion: (qid, choice) => bridge.answerQuestion(qid, choice),
  }
}

// ------------------------------------------------------------------ store listing (read-only)

export interface StoredSession {
  id: string
  title: string
  updatedAt: number
  turnCount: number
}

/**
 * Read-only jsonl store listing (M37b D3: real session enumeration for the
 * picker; the host passes `listSessionsFromStore(storeRoot)` into
 * EmbeddedOptions.listSessions). One coordinator per call is unnecessary —
 * list/profile/read are non-mutating backend paths, so the raw backend is
 * used directly (never acquires the M23 ownership lease). `updatedAt` is the
 * artifact mtime (SessionEvents carry no timestamp; SessionMeta has only
 * createdAt); turnCount = turn/start events in the log. A corrupt/foreign
 * artifact is skipped (the list stays honest instead of failing hard).
 */
export async function listSessionsFromStore(storeRoot: string): Promise<StoredSession[]> {
  const backend = createJsonlBackend(storeRoot)
  const ids = await backend.list()
  const out: StoredSession[] = []
  for (const id of ids) {
    try {
      const { meta, events } = await backend.read(id)
      const turnCount = events.filter((ev) => ev.type === "turn/start").length
      const updatedAt = await stat(join(storeRoot, `${id}.jsonl`))
        .then((s) => s.mtimeMs)
        .catch(() => 0)
      out.push({ id, title: meta?.title ?? "Session", updatedAt, turnCount })
    } catch {
      // unknown/corrupt session (e.g. a foreign-version artifact) — skip
    }
  }
  out.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : 1))
  return out
}
