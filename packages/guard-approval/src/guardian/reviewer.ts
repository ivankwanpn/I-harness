import { spawnReviewer } from "./reviewer-spawn.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { deriveSearchText, isNondurableSession, type SessionView as Session } from "@i-harness/core-session"
import { generationError, type ModelClient, type ApprovalGenerationAction } from "@i-harness/llm-seam"
import type { AgentRegistry } from "@i-harness/core-agent"
import {
  type AgentTable, type JobRegistry, type RoleRegistry,
  type SpawnOptions, type SubagentRole,
} from "@i-harness/subagent"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import { GUARDIAN_JSON_CONTRACT, parseGuardianAssessment } from "./verdict.ts"
import type { GuardianIsolatedConfig } from "./review-record.ts"

export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000
export const GUARDIAN_REVIEWER_ROLE_NAME = "reviewer"

export const BUNDLED_GUARDIAN_POLICY =
  "You are the approval guardian. A tool call needs approval, and you decide whether it may " +
  "execute without bothering the user. Deny destructive or anomalous actions, especially " +
  "outside-workspace writes, destructive shell commands (rm/del/wipe), or privilege escalations. " +
  "Approve only clearly safe, in-scope, low-risk actions. When uncertain, deny."

export interface GuardianReviewDeps {
  isolated?: GuardianIsolatedConfig
  subagents: {
    roles: RoleRegistry
    jobs: JobRegistry
    table: AgentTable
    agents: AgentRegistry
  }
  parentRegistry: ToolRegistry
  parentSession: Session
  parentCtx: PluginContext
  /** Forwarded verbatim to `spawnChild` — see SpawnOptions.resolveModel. */
  resolveModel: SpawnOptions["resolveModel"]
  /** Forwarded verbatim to `spawnChild` too: the host's declared role models
   * (`agents.roles`) and the `plugins.subagentModel` switch. The guardian's
   * spawn is a role-carrying spawn like any other — without them a
   * settings-declared `reviewer` entry is invisible at THIS site: the declared
   * selection collapses to the role's own `model` (undefined), the gate never
   * fires and the reviewer silently inherits the parent's client. */
  roleSelectionFor?: SpawnOptions["roleSelectionFor"]
  allowSubagentModelSelection?: SpawnOptions["allowSubagentModelSelection"]
  inheritedSystemContext?: SpawnOptions["inheritedSystemContext"]
  /** M73: the SESSION's own model's numbers (assembly's AssemblyOptions),
   * forwarded to `spawnChild` on the INHERITED arm only — see the gate at the
   * spawn below, which is deliberate and not symmetric with the two fields
   * above. Absent → no key written. */
  contextWindow?: SpawnOptions["contextWindow"]
  budgetBinding?: SpawnOptions["budgetBinding"]
  contextMetadata?: SpawnOptions["contextMetadata"]
  reasoningEffort?: SpawnOptions["reasoningEffort"]
  inheritedBindingForStep?: SpawnOptions["inheritedBindingForStep"]
  summaryFactory?: SpawnOptions['summaryFactory']
  autoCompactionEnabled?: SpawnOptions["autoCompactionEnabled"]
  maxOutputTokens?: SpawnOptions["maxOutputTokens"]
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

/** The reviewer's verdict plus a fail-closed cause. The outbound GuardianVerdict
 * contract (core-tools) stays unchanged; `cause` is the guard-approval-internal
 * distinction the breaker needs (M40 A7): a "deny" the MODEL produced vs a
 * deny the RUNNER fail-closed (timeout / strict-JSON malformed / operational failure). */
export interface GuardianReviewVerdict extends GuardianVerdict {
  /** Present only when the runner fail-closed: timeout, malformed strict JSON,
   * or an operational failure. Model-authored verdicts never carry it. */
  cause?: "timeout" | "malformed" | "operational"
}

/** Parent-owned approval allowance begins before any resolver or child spawn.
 * The child keeps its own response audit, with no imported parent action. */
export async function runGuardianReview(deps: GuardianReviewDeps, request: GuardianRequest): Promise<GuardianReviewVerdict> {
  const timeoutMs = deps.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS, controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('guardian review timed out')), timeoutMs)
  timer.unref?.()
  const cancel = () => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', cancel, { once: true })
  if (request.signal?.aborted) cancel()
  let generation: ApprovalGenerationAction | undefined, selectedModel = deps.model ?? deps.parentModel
  let child: Awaited<ReturnType<typeof spawnReviewer>> | undefined, completed = false
  const expire = () => controller.abort(generation?.signal.reason)
  let onAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    if (!isNondurableSession(deps.parentSession) && !request.generation) throw generationError('GENERATION_UNSUPPORTED')
    generation = await request.generation?.({ timeoutMs, selectedClient: () => selectedModel })
    generation?.signal.addEventListener('abort', expire, { once: true })
    if (generation?.signal.aborted) expire()
    const role = ensureReviewerRole(deps.subagents.roles)
    const message = renderGuardianMessage(request, renderRecentContext(deps.parentSession), deps.policyText ?? BUNDLED_GUARDIAN_POLICY)
    child = await spawnReviewer(deps, role, message, controller.signal, generation, model => { selectedModel = model })
    const entry = deps.subagents.table.get(child.path)
    if (!entry) return { outcome: 'deny', rationale: 'guardian review failed: reviewer entry missing', cause: 'operational' }
    const aborted = new Promise<'timeout'>(resolve => {
      onAbort = () => resolve('timeout')
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
    const settled = await Promise.race([entry.followupChain ?? Promise.resolve(), aborted])
    request.signal?.throwIfAborted()
    if (settled === 'timeout') return { outcome: 'deny', rationale: 'guardian review timed out after ' + timeoutMs + 'ms (fail-closed)', cause: 'timeout' }
    if (entry.finalText === undefined) return { outcome: 'deny', rationale: 'guardian review failed: ' + (entry.error ?? 'no output'), cause: 'operational' }
    const parsed = parseGuardianAssessment(entry.finalText)
    completed = parsed !== undefined
    return parsed ? { outcome: parsed.outcome, rationale: parsed.rationale }
      : { outcome: 'deny', rationale: 'guardian review produced malformed output (fail-closed)', cause: 'malformed' }
  } catch (error) {
    if (request.signal?.aborted) throw error
    if (controller.signal.aborted) return { outcome: 'deny', rationale: 'guardian review timed out after ' + timeoutMs + 'ms (fail-closed)', cause: 'timeout' }
    throw error
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener('abort', cancel)
    generation?.signal.removeEventListener('abort', expire)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    try {
      if (child) {
        const entry = deps.subagents.table.get(child.path)
        if (entry) {
          entry.controller.abort()
          if (entry.dispose) await entry.dispose()
          else { await entry.followupChain?.catch(() => {}); await entry.unmount?.() }
          deps.subagents.table.remove(child.path)
          if (child.sessionId) deps.subagents.agents.remove(child.sessionId)
        }
        if (child.jobId) try { deps.subagents.jobs.kill(child.jobId) } catch { /* Existing best-effort job cleanup. */ }
      }
    } finally { await generation?.close(controller.signal.aborted ? 'stopped' : completed ? 'completed' : 'failed') }
  }
}
