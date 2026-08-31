import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { deriveSearchText, type Session } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { AgentRegistry } from "@i-harness/core-agent"
import {
  spawnChild,
  type AgentTable, type JobRegistry, type RoleRegistry,
  type SpawnOptions, type SubagentRole,
} from "@i-harness/subagent"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import { GUARDIAN_JSON_CONTRACT, parseGuardianAssessment } from "./verdict.ts"

export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000
export const GUARDIAN_REVIEWER_ROLE_NAME = "reviewer"

export const BUNDLED_GUARDIAN_POLICY =
  "You are the approval guardian. A tool call needs approval, and you decide whether it may " +
  "execute without bothering the user. Deny destructive or anomalous actions, especially " +
  "outside-workspace writes, destructive shell commands (rm/del/wipe), or privilege escalations. " +
  "Approve only clearly safe, in-scope, low-risk actions. When uncertain, deny."

export interface GuardianReviewDeps {
  subagents: {
    roles: RoleRegistry
    jobs: JobRegistry
    table: AgentTable
    agents: AgentRegistry
  }
  parentRegistry: ToolRegistry
  parentSession: Session
  parentCtx: PluginContext
  providers: ProviderRegistry
  parentModel: ModelClient
  /** Dedicated reviewer model (defaults to the parent model). */
  model?: ModelClient
  /** Default 90_000 (fail-closed on timeout). */
  timeoutMs?: number
  /** Injected approval policy (defaults to BUNDLED_GUARDIAN_POLICY). */
  policyText?: string
  childSessions?: SpawnOptions["childSessions"]
}

// A dedicated role (codex `approvals_reviewer`): no tools — the reviewer is
// read-only by construction (it may not execute anything while reviewing).
export function ensureReviewerRole(roles: RoleRegistry): SubagentRole {
  const existing = roles.get(GUARDIAN_REVIEWER_ROLE_NAME)
  if (existing) return existing
  const role: SubagentRole = {
    name: GUARDIAN_REVIEWER_ROLE_NAME,
    description: "Approval guardian: assesses pending tool actions and returns strict JSON verdicts.",
    systemPrompt: BUNDLED_GUARDIAN_POLICY,
    tools: [],
  }
  roles.register(role)
  return role
}

/** Bounded recent-context transcript for the reviewer (codex transcript concept). */
export function renderRecentContext(session: Session, opts: { maxChars?: number; maxEvents?: number } = {}): string {
  const maxChars = opts.maxChars ?? 4_000
  const maxEvents = opts.maxEvents ?? 12
  const tail = session.events.slice(-maxEvents)
  const parts: string[] = []
  let used = 0
  for (const ev of tail) {
    if (ev.type === "assistant/chunk") continue
    let line = ""
    try {
      line = `${ev.type}: ${deriveSearchText(ev)}`
    } catch {
      line = `${ev.type}`
    }
    if (line.trim().length === 0) continue
    used += line.length + 1
    if (used > maxChars) break
    parts.push(line.slice(0, 200))
  }
  return parts.join("\n")
}

export function renderGuardianMessage(
  request: GuardianRequest,
  context: string,
  policy: string = BUNDLED_GUARDIAN_POLICY,
): string {
  const args = typeof request.args === "string" ? request.args : JSON.stringify(request.args ?? null)
  return [
    "An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),",
    "allow (ask the user first), or deny (never execute).",
    "",
    "<request>",
    `tool: ${request.name}`,
    `approval reason: ${request.reason}`,
    `arguments: ${args.slice(0, 4_000)}`,
    "</request>",
    "",
    "<recent_context>",
    context.slice(0, 4_000),
    "</recent_context>",
    "",
    "Policy:",
    policy,
    "",
    GUARDIAN_JSON_CONTRACT,
  ].join("\n")
}

// R-A9 reviewer runner: spawns the dedicated reviewer subagent via the EXISTING
// subagent machinery (spawnChild, forkTurns "none" — the reviewer sees only the
// request + bounded transcript), races a timeout (fail-closed → deny), parses
// the strict JSON verdict, and reclaims the transient child in a finally.
export async function runGuardianReview(deps: GuardianReviewDeps, request: GuardianRequest): Promise<GuardianVerdict> {
  const role = ensureReviewerRole(deps.subagents.roles)
  const timeoutMs = deps.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS
  const model = deps.model ?? deps.parentModel
  const message = renderGuardianMessage(request, renderRecentContext(deps.parentSession), deps.policyText ?? BUNDLED_GUARDIAN_POLICY)
  const { path, jobId, sessionId } = await spawnChild({
    taskName: `review-${randomUUID().slice(0, 8)}`,
    message,
    parentPath: "root",
    parentRegistry: deps.parentRegistry,
    parentSession: deps.parentSession,
    parentCtx: deps.parentCtx,
    role,
    parentModel: model,
    providers: deps.providers,
    jobs: deps.subagents.jobs,
    table: deps.subagents.table,
    agents: deps.subagents.agents,
    forkTurns: "none",
    ...(deps.childSessions !== undefined ? { childSessions: deps.childSessions } : {}),
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
    timer.unref?.()
  })

  try {
    const entry = deps.subagents.table.get(path)
    if (entry === undefined) return { outcome: "deny", rationale: "guardian review failed: reviewer entry missing" }
    const settled = await Promise.race([
      entry.followupChain ?? Promise.resolve(),
      timeout,
    ])
    if (settled === "timeout") {
      entry.controller.abort()
      return { outcome: "deny", rationale: `guardian review timed out after ${timeoutMs}ms (fail-closed)` }
    }
    const finalText = entry.finalText
    if (finalText === undefined) {
      return { outcome: "deny", rationale: `guardian review failed: ${entry.error ?? "no output"}` }
    }
    const parsed = parseGuardianAssessment(finalText)
    if (parsed === undefined) {
      return { outcome: "deny", rationale: "guardian review produced malformed output (fail-closed)" }
    }
    return { outcome: parsed.outcome, rationale: parsed.rationale }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Transient reviewer: reclaim resources (mirror of close_agent — abort,
    // unmount the child scope, drop from the subagent registries).
    const entry = deps.subagents.table.get(path)
    if (entry) {
      entry.controller.abort()
      entry.unmount?.()
      deps.subagents.table.remove(path)
      if (sessionId) deps.subagents.agents.remove(sessionId)
    }
    if (jobId) {
      try { deps.subagents.jobs.kill(jobId) } catch { /* best-effort */ }
    }
  }
}
