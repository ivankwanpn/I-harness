// M46a G2: the slash command registry — builtin map contents, visibility
// gating (the skip-list is registered hidden: listed in the inventory but
// never listed/executable), name/alias matching, completion entries.

import { describe, expect, it } from "vitest"
import { CommandRegistry, builtinCommands } from "../src/app/slash/registry.ts"
import type { SlashContext } from "../src/app/slash/types.ts"

/** Minimal ctx for registry-level tests (commands never run here). */
const ctx = {
  app: {},
  backend: {},
  engine: {},
  input: "",
  arg: "",
  toast: () => {},
} as unknown as SlashContext

/** The backend-supported mapped set (spec §2 — visible). */
const EXPECTED_VISIBLE = new Set([
  // sessions
  "new", "home", "resume", "delete", "rename", "session-info",
  // navigation
  "find", "jump", "history",
  // G1 modals
  "provider", "model", "settings", "effort",
  // run/rewind
  "rewind", "compact", "plan", "view-plan", "queue", "tasks", "btw",
  // visual
  "theme", "timestamps", "multiline", "compact-mode", "minimal", "fullscreen",
  // M46c G1: /timeline — the turn rail toggle (the skip entry superseded).
  "timeline",
  // approval
  "always-approve", "auto",
  // tools
  "doctor", "copy", "export", "transcript", "help", "quit",
  // eco
  "skills", "mcps", "hooks", "plugins", "marketplace", "personas",
  "config-agents", "workflow",
  // new surfaces
  "usage", "tutorial", "goal",
])

/** The skip-list — registered hidden with visible() false. ("settings" is NOT
 * here: the VISIBLE /settings (G1 modal) owns that name.) */
const EXPECTED_HIDDEN = new Set([
  "share", "login", "logout", "import-claude", "remember", "recap",
  "loop", "voice", "imagine", "imagine-video", "gboom", "cd", "fork",
  "dashboard", "context", "edit-prompt", "expand",
  "toggle-mouse-reporting", "debug", "scroll-debug",
])

describe("CommandRegistry — builtin inventory", () => {
  const registry = new CommandRegistry()

  it("holds every backend-supported command (visible set intact)", () => {
    const names = new Set(registry.visible(ctx).map((c) => c.name))
    for (const name of EXPECTED_VISIBLE) {
      expect(names.has(name), `visible command "${name}" missing`).toBe(true)
    }
  })

  it("registers the skip-list HIDDEN (inventory only — visible() false)", () => {
    const all = new Set(registry.all().map((c) => c.name))
    for (const name of EXPECTED_HIDDEN) {
      expect(all.has(name), `skip-list command "${name}" not registered`).toBe(true)
    }
    const visible = new Set(registry.visible(ctx).map((c) => c.name))
    for (const name of EXPECTED_HIDDEN) {
      expect(visible.has(name), `skip-list command "${name}" leaked into visible`).toBe(false)
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
})

describe("CommandRegistry — matching", () => {
  const registry = new CommandRegistry()

  it("matches a submitted line → command + arg", () => {
    const m = registry.matches("/theme grokday", ctx)
    expect(m?.command.name).toBe("theme")
    expect(m?.arg).toBe("grokday")
    const bare = registry.matches("/theme", ctx)
    expect(bare?.command.name).toBe("theme")
    expect(bare?.arg).toBe("")
    // non-slash lines are never commands
    expect(registry.matches("hello", ctx)).toBeUndefined()
    // unknown commands → undefined (the loop falls through to normal submit)
    expect(registry.matches("/nope", ctx)).toBeUndefined()
  })

  it("hidden commands never match (hard visibility gate)", () => {
    expect(registry.matches("/share", ctx)).toBeUndefined()
    expect(registry.matches("/login", ctx)).toBeUndefined()
    expect(registry.matches("/loop", ctx)).toBeUndefined()
    expect(registry.matches("/fork", ctx)).toBeUndefined()
  })

  it("aliases resolve to their command (/auto → always-approve behavior via auto)", () => {
    const m = registry.matches("/auto", ctx)
    expect(m?.command.name).toBe("auto")
    const always = registry.matches("/always-approve", ctx)
    expect(always?.command.name).toBe("always-approve")
  })
})

describe("CommandRegistry — completion entries", () => {
  const registry = new CommandRegistry()

  it("lists visible commands (name + description), sorted; skips hidden", () => {
    const entries = registry.completionEntries(ctx)
    const names = entries.map((e) => e.command)
    expect(names[0]!).toBe(names[0]!.localeCompare(names[1]!) <= 0 ? names[0]! : names[1]!)
    // sorted check (full)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
    for (const e of entries) {
      expect((e.description ?? "").length).toBeGreaterThan(0)
    }
    expect(names).not.toContain("share")
    expect(names).not.toContain("login")
    expect(names).toContain("theme")
    expect(names).toContain("skills")
  })

  it("counts: visible = mapped set, hidden = skip-list minus duplicates", () => {
    const visible = registry.completionEntries(ctx)
    expect(visible.length).toBe(EXPECTED_VISIBLE.size)
    const all = registry.all()
    expect(all.length).toBe(EXPECTED_VISIBLE.size + EXPECTED_HIDDEN.size)
  })
})
