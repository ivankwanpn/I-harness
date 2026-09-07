// M49 Task 14: the capability-gated slash command registry — builtin map
// contents, CAPABILITY visibility gating (spec §10.1/§10.2: visible() checks
// the typed SlashCapability inventory; excluded account/billing/privacy/
// delete/cd/memory/media commands are NOT registered at all), name/alias
// matching, completion entries.

import { describe, expect, it } from "vitest"
import { CommandRegistry, builtinCommands } from "../src/app/slash/registry.ts"
import type { SlashCapability } from "../src/app/slash/types.ts"
import { slashContext } from "./slash-fixtures.ts"

/** The §10.2 inventory: groups whose backend capabilities are registered and
 * could be visible — the capability-gated ones show only with the capability. */
const CAPABILITY_GROUPS: Array<{ cap: SlashCapability; names: string[] }> = [
  { cap: "session-create", names: ["new"] },
  { cap: "session-list", names: ["resume"] },
  { cap: "dashboard", names: ["dashboard"] },
  { cap: "provider-settings", names: ["settings", "provider", "model", "effort"] },
  { cap: "rewind", names: ["rewind"] },
  { cap: "compact", names: ["compact"] },
  { cap: "fork", names: ["fork"] },
  { cap: "context", names: ["context"] },
  { cap: "plan-mode", names: ["plan", "view-plan"] },
  { cap: "guardian", names: ["always-approve", "auto"] },
  { cap: "vim-mode", names: ["vim-mode"] },
]

/** Always-visible commands (unconditional local actions — no backend gate). */
const UNCONDITIONAL = [
  "home", "rename", "session-info",
  "find", "jump", "history", "edit-prompt",
  "queue", "tasks", "btw",
  "theme", "timestamps", "multiline", "compact-mode", "minimal", "fullscreen",
  "timeline",
  "doctor", "copy", "export", "transcript", "help", "quit",
  "skills", "mcps", "hooks", "plugins", "marketplace", "config-agents", "workflow",
  "usage", "goal", "tutorial",
]

/** §10.3 + the state-only fakes: NEVER registered (zero registration hits —
 * not even as hidden inventory). */
const NEVER_REGISTERED = [
  "login", "logout", "share", "privacy", "import-claude", "remember",
  "recap", "dream", "flush", "loop", "voice", "imagine",
  "imagine-video", "gboom", "cd", "delete",
]

describe("CommandRegistry — capability inventory (spec §10.2)", () => {
  const ctx = slashContext({ capabilities: ["session-list", "provider-settings"] })

  it("lists only commands whose capabilities are present", () => {
    const names = new CommandRegistry().visible(ctx).map((command) => command.name)
    expect(names).toContain("resume") // session-list present
    expect(names).toContain("settings") // provider-settings present
    expect(names).not.toContain("rewind") // no rewind capability
    expect(names).not.toContain("login") // never registered
    expect(names).not.toContain("delete") // %10.3 exclusion — never registered
  })

  it("every registered command is visible with its capability present", () => {
    const full = slashContext({ capabilities: CAPABILITY_GROUPS.map((g) => g.cap) })
    const names = new Set(new CommandRegistry().visible(full).map((c) => c.name))
    for (const group of CAPABILITY_GROUPS) {
      for (const name of group.names) {
        expect(names.has(name), `"${name}" (${group.cap}) missing in the full inventory`).toBe(true)
      }
    }
    for (const name of UNCONDITIONAL) {
      expect(names.has(name), `unconditional "${name}" missing`).toBe(true)
    }
  })

  it("capability-gated commands are hidden WITHOUT their capability", () => {
    const bare = slashContext({ capabilities: [] })
    const names = new Set(new CommandRegistry().visible(bare).map((c) => c.name))
    for (const group of CAPABILITY_GROUPS) {
      for (const name of group.names) {
        expect(names.has(name), `"${name}" leaked without ${group.cap}`).toBe(false)
      }
    }
    for (const name of UNCONDITIONAL) {
      expect(names.has(name), `unconditional "${name}" mysteriously hidden`).toBe(true)
    }
  })

  it("the plan/auto/always-approve fakes are ABSENT under the default context", () => {
    // No live switching/guardian capability on the TUI backend (M49) — the
    // M46a UI-state-only implementations must not be visible.
    const names = new Set(new CommandRegistry().visible(slashContext({ capabilities: [] })).map((c) => c.name))
    expect(names).not.toContain("plan")
    expect(names).not.toContain("view-plan")
    expect(names).not.toContain("auto")
    expect(names).not.toContain("always-approve")
    expect(names).not.toContain("vim-mode")
    expect(names).not.toContain("fork")
  })

  it("registers nothing from the §10.3 exclusion list (zero registration hits)", () => {
    const names = new Set(builtinCommands().map((c) => c.name))
    for (const name of NEVER_REGISTERED) {
      expect(names.has(name), `excluded "${name}" is registered`).toBe(false)
    }
  })

  it("every command has a name + description; names are unique", () => {
    const names = new Set<string>()
    for (const c of builtinCommands()) {
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
      expect(names.has(c.name)).toBe(false)
      names.add(c.name)
    }
  })

  it("alias /workflows resolves to the /workflow command", () => {
    const m = new CommandRegistry().matches("/workflows", slashContext({ capabilities: [] }))
    expect(m?.command.name).toBe("workflow")
  })
})

describe("CommandRegistry — matching", () => {
  const registry = new CommandRegistry()

  it("matches a submitted line → command + arg", () => {
    const ctx = slashContext({ capabilities: [] })
    const m = registry.matches("/theme grokday", ctx)
    expect(m?.command.name).toBe("theme")
    expect(m?.arg).toBe("grokday")
    const bare = registry.matches("/theme", ctx)
    expect(bare?.command.name).toBe("theme")
    expect(bare?.arg).toBe("")
    // non-slash lines are never commands
    expect(registry.matches("hello", ctx)).toBeUndefined()
    // unknown commands → undefined (the loop renders "Unsupported command:")
    expect(registry.matches("/nope", ctx)).toBeUndefined()
  })

  it("excluded and capability-hidden commands never match (hard visibility gate)", () => {
    const ctx = slashContext({ capabilities: [] })
    expect(registry.matches("/share", ctx)).toBeUndefined()
    expect(registry.matches("/login", ctx)).toBeUndefined()
    expect(registry.matches("/loop", ctx)).toBeUndefined()
    expect(registry.matches("/delete", ctx)).toBeUndefined()
    // capability-gated without the capability: no match either
    expect(registry.matches("/plan", ctx)).toBeUndefined()
    expect(registry.matches("/auto", ctx)).toBeUndefined()
    expect(registry.matches("/rewind", ctx)).toBeUndefined()
  })

  it("gated commands match when their capability IS present", () => {
    const ctx = slashContext({ capabilities: ["plan-mode", "guardian", "rewind", "fork"] })
    expect(registry.matches("/plan", ctx)?.command.name).toBe("plan")
    expect(registry.matches("/auto", ctx)?.command.name).toBe("auto")
    const always = registry.matches("/always-approve", ctx)
    expect(always?.command.name).toBe("always-approve")
    const rewind = registry.matches("/rewind", ctx)
    expect(rewind?.command.name).toBe("rewind")
    expect(registry.matches("/fork thing", ctx)?.arg).toBe("thing")
  })
})

describe("CommandRegistry — completion entries", () => {
  it("lists visible commands (name + description), sorted; skips hidden + excluded", () => {
    const entries = new CommandRegistry().completionEntries(slashContext({ capabilities: [] }))
    const names = namesOf(entries)
    expect(names[0]!).toBe(names[0]!.localeCompare(names[1]!) <= 0 ? names[0]! : names[1]!)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    for (const e of entries) {
      expect((e.description ?? "").length).toBeGreaterThan(0)
    }
    expect(names).not.toContain("share")
    expect(names).not.toContain("login")
    expect(names).not.toContain("plan")
    expect(names).not.toContain("auto")
    expect(names).toContain("theme")
    expect(names).toContain("skills")
    expect(names).not.toContain("delete")
  })

  it("counts: no-capabilities set = unconditional only; full set = + every group", () => {
    const bare = new CommandRegistry().completionEntries(slashContext({ capabilities: [] }))
    expect(namesOf(bare).length).toBe(UNCONDITIONAL.length)
    const full = new CommandRegistry().completionEntries(
      slashContext({ capabilities: CAPABILITY_GROUPS.map((g) => g.cap) }),
    )
    const expected = UNCONDITIONAL.length + CAPABILITY_GROUPS.reduce((n, g) => n + g.names.length, 0)
    expect(namesOf(full).length).toBe(expected)
    // alias names are not separate entries
    expect(namesOf(full)).not.toContain("workflows")
  })
})

function namesOf(entries: Array<{ command: string; description?: string }>): string[] {
  return entries.map((e) => e.command)
}
