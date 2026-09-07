// @i-harness/tui — G2 (M46a): the slash command registry (spec §2 — grok's
// registry shape: builtin list + per-command visible() gate).
// M49 Task 14 (spec §10.1/§10.2/§10.3): the builtin set is the CAPABILITY-
// GATED map — visible() checks the typed SlashCapability inventory on the
// SlashContext (real backend/host members only). The §10.3 exclusions
// (login/logout/share/privacy/delete/cd/memory/media/…) are NOT registered at
// all (no hidden skip-list — the registry inventory IS the honest inventory);
// capability-hidden commands (plan/view-plan/auto/always-approve/vim-mode/
// fork/context/rewind/compact/…) are registered but gated — hidden commands
// never list nor match (the loop renders `Unsupported command: /<name>`).
// The loop owns the SlashContext (the seams above); the registry itself is a
// pure table: matches() resolves name/aliases for a submitted line,
// completionEntries() feeds the M37b slash dropdown (visibility-filtered).

import type { SlashCommand, SlashContext } from "./types.ts"
import { approvalCommands } from "./impl/approval.ts"
import { ecoCommands } from "./impl/eco.ts"
import { g1Commands } from "./impl/g1.ts"
import { mouseCommands } from "./impl/mouse.ts"
import { navigationCommands } from "./impl/navigation.ts"
import { runCommands } from "./impl/run.ts"
import { sessionCommands } from "./impl/sessions.ts"
import { surfaceCommands } from "./impl/surfaces.ts"
import { timelineCommands } from "./impl/timeline.ts"
import { toolsCommands } from "./impl/tools.ts"
import { visualCommands } from "./impl/visual.ts"
import { workflowCommands } from "./impl/workflow2.ts"
import { editorSafetyCommands } from "./impl/text-input.ts"

/** Builtin command map (the capability-gated set — no hidden skip-list). */
export function builtinCommands(): SlashCommand[] {
  return [
    // sessions (+ the capability-gated /fork //context — "Conditional session")
    ...sessionCommands,
    // navigation (+ /edit-prompt — spec §10.2 "Navigation/editor")
    ...navigationCommands,
    // G1-owned modals (/provider /model /settings /effort)
    ...g1Commands,
    // run/rewind (rewind/compact/plan/view-plan capability-gated)
    ...runCommands,
    // visual
    ...visualCommands,
    // approval (always-approve/auto — "guardian" gated)
    ...approvalCommands,
    // tools (+ the dynamic /help)
    ...toolsCommands,
    // eco (inventories — skills/mcps/hooks/plugins/marketplace/config-agents)
    ...ecoCommands,
    // M46c G2: /workflow surface — run <name> | status [id] | list (owns the
    // "workflow" name + the §10.2 "workflows" alias).
    ...workflowCommands,
    // new surfaces (/usage — local this-session meter — /goal /tutorial)
    ...surfaceCommands,
    // M46c G1: /timeline — the turn rail toggle.
    ...timelineCommands,
    // M46b G1: mouse surfaces — /toggle-mouse-reporting (feature-gated:
    // visible + executable ONLY when [ui] mouse_reporting_toggle is on).
    ...mouseCommands(),
    // M49 Task 14 (spec §10.2 "Conditional editor/safety"): /vim-mode —
    // registered, "vim-mode" capability-gated (absent at M49).
    ...editorSafetyCommands,
  ]
}

export class CommandRegistry {
  /** Canonical names → command (all()/visible()/matching source of truth). */
  private readonly byName: Map<string, SlashCommand> = new Map()
  /** Aliases → command (matches only — never an inventory duplicate). */
  private readonly byAlias: Map<string, SlashCommand> = new Map()

  constructor(commands: SlashCommand[] = builtinCommands()) {
    this.byName.clear()
    this.byAlias.clear()
    for (const c of commands) {
      if (this.byName.has(c.name)) {
        throw new Error(`duplicate slash command: ${c.name}`)
      }
      this.byName.set(c.name, c)
      for (const a of c.aliases ?? []) {
        if (!this.byName.has(a) && !this.byAlias.has(a)) this.byAlias.set(a, c)
      }
    }
  }

  /** All commands (incl. capability-hidden) — registry inventory. */
  all(): SlashCommand[] {
    return [...this.byName.values()]
  }

  /** Visible commands (the dropdown/listing set — capability-gated). */
  visible(ctx: SlashContext): SlashCommand[] {
    return this.all().filter((c) => c.visible?.(ctx) !== false)
  }

  /**
   * Resolve a submitted line ("/theme grokday") → the command + arg.
   * Hidden (capability-absent) commands are NOT matched (visible gate is a
   * hard gate — an ungated command can never execute). Excluded names are not
   * registered at all → undefined here too (the loop's unsupported path).
   */
  matches(line: string, ctx: SlashContext): { command: SlashCommand; arg: string } | undefined {
    const trimmed = line.trim()
    if (!trimmed.startsWith("/")) return undefined
    const head = trimmed.slice(1).split(/\s+/, 1)[0]!
    const cmd = this.byName.get(head) ?? this.byAlias.get(head)
    if (cmd === undefined) return undefined
    if (cmd.visible?.(ctx) === false) return undefined
    const arg = trimmed.slice(head.length + 1).trim()
    return { command: cmd, arg }
  }

  /** The M37b dropdown entries (visible only; name + description). */
  completionEntries(ctx: SlashContext): Array<{ command: string; description?: string }> {
    return this.visible(ctx)
      .map((c) => ({ command: c.name, description: c.description }))
      .sort((a, b) => a.command.localeCompare(b.command))
  }
}

/** The default app registry (builtin map) — the loop owns the context. */
export function defaultRegistry(): CommandRegistry {
  return new CommandRegistry()
}
