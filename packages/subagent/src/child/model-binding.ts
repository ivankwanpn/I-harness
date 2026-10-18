import type { SessionView } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ReasoningEffort } from "@i-harness/core-agent"
import type { SettingsProviderProtocol } from "@i-harness/settings"
import type { CodeModeConfig, CodeModeFactory } from "@i-harness/code-mode"
import { builtinRoles, type SubagentRole } from "../roles.ts"

/** A role's model selection: which route, which model, and optionally the wire
 * protocol / reasoning effort the role asks for. A settings
 * `agents.roles.<name>` entry satisfies this shape structurally — nothing in
 * this package names that type. */
export interface RoleModelSelection {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

/** The host's side of the rule: the declared role models, read through a
 * CALLBACK at spawn time so a settings edit applies to the next spawn without
 * restarting the session, and `plugins.subagentModel` — the switch that lets a
 * role run on a declared model at all. `SpawnOptions`, the subagent tool deps
 * and `RegisterSubagentOptions` all carry this shape, so it is written here
 * ONCE and the rule below is stated once. */
export interface RoleModelHost {
  generationFactoryFor?: import('@i-harness/core-agent').DocumentGenerationFactory
  modelActionTimeoutMs?: number
  modelActionMaxAttempts?: number
  summaryFactory?: import('@i-harness/core-agent').AgentDeps['summaryFactory']
  inheritedBindingForStep?: () => import("@i-harness/core-agent").ModelContextBindingDescriptor
  codeMode?: CodeModeConfig
  codeModeFactory?: CodeModeFactory
  /** Trusted parent context, rendered afresh for each child model request. */
  inheritedSystemContext?: (session?: SessionView) => string
  /** Settings' `agents.roles.<name>` (or any host's equivalent): the model the
   * host declares for a role. Absent → the role's own `model`, then inherit. */
  roleSelectionFor?: (roleName: string) => RoleModelSelection | undefined
  /** The switch. ABSENT MEANS OFF — the setting's own default is false, and a
   * host that never wired it has not enabled the feature. Off, a declared
   * selection is refused (`subagentModelSelectionGated`) rather than run. */
  allowSubagentModelSelection?: boolean | (() => boolean)
  /** Shared live compaction preference for main and child Agents. */
  autoCompactionEnabled?: () => boolean
  /** M73: the SESSION's own model's numbers — what an INHERITING child runs
   * under (no declared role model). They ride this host shape for the same
   * reason `roleSelectionFor` does: every spawn arm (the subagent tool, the
   * team scheduler, the guardian) already carries it, so the values reach
   * `spawnChild` without a second parameter path. NOT the numbers of a role's
   * DECLARED model — that binding resolves at spawn and carries its own
   * (RoleModelState's ready arm below). Absent → no key is written. */
  contextWindow?: number
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
  contextMetadata?: import("@i-harness/core-session").ContextBindingMetadata
  reasoningEffort?: ReasoningEffort
  maxOutputTokens?: number
}

/** The role's model for THIS spawn, in order: the HOST's declared
 * `agents.roles.<name>` selection, then the role's own `model` (the session
 * snapshot / plugin path), then nothing — inherit the parent's client, which is
 * what an unconfigured harness does and what every role did before this section
 * existed. Settings wins because it is the host's deliberate decision, while a
 * snapshot role is per-session residue.
 *
 * Pure: whether a returned selection may actually run is the switch's question
 * (`subagentModelSelectionGated`) — the two are separate so the refusing call
 * sites can fail in their own vocabulary (throw for a spawn, `false` for a
 * lazy rebuild) without a second copy of the ordering. */
export function declaredRoleModel(role: SubagentRole, host: RoleModelHost): RoleModelSelection | undefined {
  return host.roleSelectionFor?.(role.name) ?? role.model
}

/** The recorded label for a resolved selection — `provider:model`, the ONE
 * spelling of that pair. `spawnChild` and the resident rebuild
 * (`ensureResidentAgent`) both RECORD what the child runs on; a second copy of
 * this expression would be a second place for the two records to drift. */
export function modelLabelOf(selection: RoleModelSelection): string {
  return `${selection.provider}:${selection.model}`
}

/** The four built-in names, read from the ONE place that declares them
 * (`builtinRoles`). The refusal below picks its second repair by this set: the
 * CLI's `roles unset` accepts no other name, so offering it for a
 * plugin-contributed role or the guardian's `reviewer` sent the reader to a
 * verb that exits 1 with "unknown role". */
const BUILTIN_ROLE_NAMES = new Set(builtinRoles().map((role) => role.name))

/** The ONE refusal for a gated selection — shared by the spawn path, the
 * restored resident rebuild and `resume_agent`'s diagnostic, so the message
 * cannot drift between them. It names BOTH fixes because the reader has both at
 * hand: turn the switch on, or clear the role's model — and the second names
 * the surface that can actually clear THIS name, since `roles unset` only
 * accepts the four built-ins. */
export function subagentModelSelectionDisabled(roleName: string): Error {
  const clear = BUILTIN_ROLE_NAMES.has(roleName)
    ? `clear it with \`i-harness roles unset ${roleName}\``
    : `clear \`agents.roles.${roleName}\` in settings.json`
  return new Error(
    `role "${roleName}" declares a model, but sub-agent model selection is disabled: ` +
      `set plugins.subagentModel=true in settings, or ${clear}`,
  )
}

/** True when a declared selection must be refused: the switch is on ONLY when
 * it is literally `true`. ABSENT is off — the setting's own default is false,
 * and a host that never wired the option has not enabled the feature. This is
 * the ONE place that rule is written. */
export function subagentModelSelectionGated(host: RoleModelHost, declared: RoleModelSelection | undefined): boolean {
  const enabled = typeof host.allowSubagentModelSelection === "function" ? host.allowSubagentModelSelection() : host.allowSubagentModelSelection
  return declared !== undefined && enabled !== true
}

/** The resolver's answer, structurally: the `status` decides, and a `ready`
 * state's `client` and `reasoningEffort` are read here. provider-runtime's own
 * answer satisfies it as it stands (the field names and the three arms match) —
 * kept local because this package does not depend on provider-runtime, the same
 * reason session-executor declares its own binding result type.
 *
 * M73 widened the ready arm with the binding's `contextWindow`/`maxOutputTokens`
 * (provider-runtime already emits them — `resolveModel`'s ready arm spreads
 * both when they resolve). They were REACHING this spawn at runtime and being
 * dropped HERE, by the type and the one read site: an undeclared field cannot
 * be read without a cast, so the child kept the client and silently ran
 * unbounded. Absent stays absent — both are optional and neither is defaulted. */
export type RoleModelState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: { client: ModelClient; reasoningEffort?: ReasoningEffort; contextWindow?: number; maxOutputTokens?: number; budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding; contextMetadata?: import("@i-harness/core-session").ContextBindingMetadata } }
