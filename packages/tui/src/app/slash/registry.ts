// @i-harness/tui — G2 (M46a): the slash command registry (spec §2 — grok's
// registry shape: builtin list + per-command visible() gate).
// The builtin set is the BACKEND-SUPPORTED map; the skip-list is registered
// HIDDEN (visible: () => false) with its honest reason (impl/skipped.ts).
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
import { skippedCommands } from "./impl/skipped.ts"
import { surfaceCommands } from "./impl/surfaces.ts"
import { toolsCommands } from "./impl/tools.ts"
import { visualCommands } from "./impl/visual.ts"

/** Builtin command map (the M46a backend-supported set + the skip-list). */
export function builtinCommands(): SlashCommand[] {
  return [
    // sessions
    ...sessionCommands,
    // navigation
    ...navigationCommands,
    // G1-owned modals (/provider /model /settings /effort)
    ...g1Commands,
    // run/rewind
    ...runCommands,
    // visual
    ...visualCommands,
    // approval
    ...approvalCommands,
    // tools
    ...toolsCommands,
    // eco (light panels over the real backends)
    ...ecoCommands,
    // new surfaces
    ...surfaceCommands,
    // M46b G1: mouse surfaces — /toggle-mouse-reporting (feature-gated:
    // visible + executable ONLY when [ui] mouse_reporting_toggle is on).
    ...mouseCommands(),
    // hidden skip-list (visible: false — completeness inventory only)
    ...skippedCommands,
  ]
}

export class CommandRegistry {
  private readonly byName: Map<string, SlashCommand> = new Map()

  constructor(commands: SlashCommand[] = builtinCommands()) {
    this.byName.clear()
    for (const c of commands) {
      if (this.byName.has(c.name)) {
        throw new Error(`duplicate slash command: ${c.name}`)
      }
      this.byName.set(c.name, c)
      for (const a of c.aliases ?? []) {
        if (!this.byName.has(a)) this.byName.set(a, c)
      }
    }
  }

  /** All commands (incl. hidden) — registry inventory. */
  all(): SlashCommand[] {
    return [...this.byName.values()]
  }

  /** Visible commands (the dropdown/listing set). */
  visible(ctx: SlashContext): SlashCommand[] {
    return this.all().filter((c) => c.visible?.(ctx) !== false)
  }

  /**
   * Resolve a submitted line ("/theme grokday") → the command + arg.
   * Hidden commands are NOT matched (visible gate is a hard gate — a hidden
   * skip-list entry can never execute).
   */
  matches(line: string, ctx: SlashContext): { command: SlashCommand; arg: string } | undefined {
    const trimmed = line.trim()
    if (!trimmed.startsWith("/")) return undefined
    const head = trimmed.slice(1).split(/\s+/, 1)[0]!
    const cmd = this.byName.get(head)
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
