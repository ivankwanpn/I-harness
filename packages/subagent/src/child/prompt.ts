import { CHARS_PER_TOKEN } from "@i-harness/token-meter"

/**
 * M49 Task 14 (spec §11): the subagent prompt contract — appended AFTER the
 * role prompt on every child agent. It carries the delegated-task scope, the
 * no-recursive-delegation rule, the changed-files/test reporting and the
 * result delivery; the closing note keeps human/project instructions (the
 * task message, project rules) above this contract.
 */
export const SUBAGENT_PROMPT_CONTRACT = `Subagent contract:
- Scope: complete the delegated task only; do not expand into adjacent work.
  Your task scope is exactly what was asked of you. The parent owns the
  overall plan — ask about ambiguity instead of assuming scope.
- Delegation: do not delegate recursively unless the harness explicitly
  supports it. Use the tools you were given; your tools list is the authority.
- Reporting: in your final result, report the changed files and the tests you
  ran or added, with their outcomes.
- Result delivery: deliver the concrete deliverable of your task in your final
  message. The parent integrates your result into its own work — do not
  repeat work the parent already owns.
Note: human and project instructions (your task message, project rules, and
the role prompt above) remain higher priority than this contract.`

/** Role system prompt + the subagent contract (the child agent's system
 * prompt). The role prompt always leads; the contract follows. */
export function composeSubagentPrompt(roleSystemPrompt: string, identity?: { path: string; role: string; tools: readonly string[] }): string {
  const scope = identity ? `Child identity: ${JSON.stringify(identity.path)}; role: ${JSON.stringify(identity.role)}.
You are a separate child agent completing your delegated task. Available tools: ${JSON.stringify(identity.tools)}.
Parent history is context supplied by the parent, not work you performed. Parent tool calls do not grant you those tools. Attribute inherited observations to the parent and report your own work separately.` : ""
  return [roleSystemPrompt, scope, SUBAGENT_PROMPT_CONTRACT].filter(Boolean).join("\n\n")
}

/**
 * M73 (ruling M73-P1): the child's prompt-and-schemas overhead, priced the way
 * the session's own assembly prices the same pair (`estimateAssemblyOverhead`,
 * assembly.ts): the charge the child's log never carries but the model sees on
 * every request. ONE definition because BOTH arms of the budget chain need it —
 * `spawnChild` below charges it so the child's request is clamped against a
 * realistic input, and the rebuilt child (`tools.ts`'s `ensureResidentAgent`)
 * imports it so a resumed child does not silently lose the charge the first one
 * had. Two copies of one rule are two places to drift.
 *
 * Module-local by ruling: it is exported for its sibling module in this
 * package, NOT through the package entry (`index.ts` names its exports and does
 * not re-export this one).
 */
export function estimateChildOverhead(systemPrompt: string, schemas: unknown): number {
  return Math.ceil(systemPrompt.length / CHARS_PER_TOKEN) + Math.ceil(JSON.stringify(schemas).length / CHARS_PER_TOKEN)
}
