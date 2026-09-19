import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseRolesArgs, renderRoles, runRolesCommand } from "../src/roles.ts"

// `i-harness roles` — the surface that makes `agents.roles` usable
// (docs/superpowers/specs/2026-09-19-agent-roles-design.md §8).
//
// It closes a ONE-TASK LAG: Task 4's refusal message already told users to run
// `i-harness roles unset <role>` while the verb did not exist. A ruled surface
// with no invocation is the shape `i-harness hooks approve` was created to end.
const FOUR = "general, explore, research, worker"

describe("parseRolesArgs", () => {
  it("reads the three subcommands", () => {
    expect(parseRolesArgs(["roles"])).toEqual({ subcommand: "list", values: {} })
    expect(parseRolesArgs(["roles", "list"])).toEqual({ subcommand: "list", values: {} })
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "small"]))
      .toEqual({ subcommand: "set", role: "general", values: { provider: "gw", model: "small" } })
    expect(parseRolesArgs(["roles", "unset", "worker"])).toEqual({ subcommand: "unset", role: "worker", values: {} })
  })

  it("an unknown subcommand is refused, not read as a role name", () => {
    // `roles general` must not silently mean something: the second token is a
    // role only after `set`/`unset` says so.
    expect(parseRolesArgs(["roles", "frobnicate"]).error).toMatch(/unknown roles subcommand: frobnicate/)
    expect(parseRolesArgs(["roles", "general"]).error).toMatch(/unknown roles subcommand/)
  })

  it("a half selection is refused, naming the flag that is missing (§2 rule 1)", () => {
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw"]).error)
      .toMatch(/--model is missing/)
    expect(parseRolesArgs(["roles", "set", "general", "--model", "small"]).error)
      .toMatch(/--provider is missing/)
    // Neither half is a setting — "the same vendor, another model" must name
    // the vendor too.
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "small"]).error).toBeUndefined()
  })

  it("an unknown role is refused, naming the four built-ins (§2 rule 3)", () => {
    expect(parseRolesArgs(["roles", "set", "nosuchrole", "--provider", "gw", "--model", "m"]).error).toContain(FOUR)
    expect(parseRolesArgs(["roles", "unset", "nosuchrole"]).error).toContain(FOUR)
    // Case matters: the settings key is exact.
    expect(parseRolesArgs(["roles", "unset", "General"]).error).toContain(FOUR)
  })

  it("--protocol takes one of the five — never a guess", () => {
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "m", "--protocol", "anthropic-messages"]))
      .toEqual({ subcommand: "set", role: "general", values: { provider: "gw", model: "m", protocol: "anthropic-messages" } })
    const bad = parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "m", "--protocol", "grpc"])
    expect(bad.error).toContain("grpc")
    expect(bad.error).toContain("anthropic-messages")
    // `auto` is a second spelling of "no protocol", and here omitting the flag
    // already means that — `set` replaces the whole entry.
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "m", "--protocol", "auto"]).error)
      .toMatch(/auto/)
  })

  it("carries --reasoning-effort through unvalidated, like `models use`", () => {
    expect(parseRolesArgs(["roles", "set", "explore", "--provider", "gw", "--model", "m", "--reasoning-effort", "max"]))
      .toEqual({ subcommand: "set", role: "explore", values: { provider: "gw", model: "m", reasoningEffort: "max" } })
  })

  it("a blank value is refused: the store DROPS the whole entry, so the CLI must not report a write", () => {
    // settings' normalizeRoleModel returns null for a blank provider/model, so
    // `--model ""` would persist nothing while the verb printed success —
    // the provider tree's `--base-url ""` defect, one plane over.
    expect(parseRolesArgs(["roles", "set", "general", "--provider", " ", "--model", "small"]).error)
      .toMatch(/--provider needs a non-empty value/)
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", ""]).error)
      .toMatch(/--model needs a non-empty value/)
  })

  it("missing arguments, stray flags and stray arguments are all reported", () => {
    expect(parseRolesArgs(["roles", "set"]).error).toMatch(/set takes a role name/)
    expect(parseRolesArgs(["roles", "unset"]).error).toMatch(/unset takes a role name/)
    expect(parseRolesArgs(["roles", "unset", "worker", "extra"]).error).toMatch(/unexpected extra argument: extra/)
    expect(parseRolesArgs(["roles", "set", "general", "--provider", "gw", "--model", "m", "--wat", "x"]).error).toMatch(/unknown flag: --wat/)
    expect(parseRolesArgs(["roles", "set", "general", "--provider"]).error).toMatch(/--provider needs a value/)
  })

  it("list takes nothing", () => {
    // `provider list deepseek` used to print the full list with exit 0 — the
    // same "exit 0 having done something other than what was asked".
    expect(parseRolesArgs(["roles", "list", "general"]).error).toMatch(/list takes no arguments \(got "general"\)/)
    expect(parseRolesArgs(["roles", "list", "--provider", "gw"]).error).toMatch(/--provider is not a flag of "list"/)
  })
})

describe("renderRoles", () => {
  it("says which roles are declared and which inherit, and prints the declared selection", () => {
    const out = renderRoles([
      { name: "general", builtin: true, selection: { provider: "gw", model: "small", protocol: "anthropic-messages", reasoningEffort: "high" } },
      { name: "explore", builtin: true },
      { name: "worker", builtin: true, selection: { provider: "gw", model: "big" } },
    ])
    expect(out).toContain("general  declared: gw:small")
    expect(out).toContain("anthropic-messages")
    expect(out).toContain("high")
    // Inherited is a STATEMENT, not a blank: the parent's client is the answer.
    expect(out).toContain("explore  inherited")
    // An entry with no protocol/effort prints that the field is unset — an
    // omitted flag CLEARS it (`set` replaces the whole entry), so silence
    // would hide the thing the verb just did.
    expect(out).toContain("worker  declared: gw:big")
    expect(out).toContain("protocol: unset")
    expect(out).toContain("reasoning effort: unset")
  })

  it("marks a declared role that is not one of the four built-ins, and claims no more than that", () => {
    // Reachable only by hand-editing the file. The marker says the name is not
    // one the CLI's own `set` accepts — and NOTHING about whether the row is
    // live: plugin-contributed agents and the guardian's `reviewer` register
    // into the same role registry the spawn tools read, and a spawn resolves
    // `agents.roles[<any name>]`, so such an entry GATES that role. A
    // "nothing spawns it" clause here was a false absolute.
    const out = renderRoles([{ name: "reviewer", builtin: false, selection: { provider: "gw", model: "m" } }])
    expect(out).toContain("reviewer  declared: gw:m")
    expect(out).toContain("(not one of the four built-ins)")
    expect(out).not.toContain("nothing spawns it")
  })

  // D2: the read verb is where a user looks to understand state, and with the
  // shipped default every declared row is a spawn refusal — a fact the rows
  // alone cannot show. The note appears only when the caller KNOWS the switch
  // is off (a bare renderRoles call makes no claim) and only when there is at
  // least one declared row to refuse.
  it("says a declared row is refused while the switch is off, and says nothing when it is on", () => {
    const declared = [{ name: "worker", builtin: true, selection: { provider: "gw", model: "big" } }]
    const inheriting = [{ name: "worker", builtin: true }]

    const off = renderRoles(declared, false)
    expect(off).toContain("plugins.subagentModel is false")
    expect(off).toContain("refused")
    // no note while the switch is on — the rows already say everything true then
    expect(renderRoles(declared, true)).not.toContain("plugins.subagentModel")
    // and no note about refusals when nothing is declared
    expect(renderRoles(inheriting, false)).not.toContain("plugins.subagentModel")
    // a caller that did not state the switch gets no claim either way
    expect(renderRoles(declared)).not.toContain("plugins.subagentModel")
  })
})

describe("runRolesCommand", () => {
  let home: string
  let previous: string | undefined

  interface DiskDoc {
    fontSize?: number
    llm?: { defaultModel?: { provider?: string; model?: string } }
    agents?: { roles?: Record<string, unknown> }
  }
  const settingsOnDisk = (): DiskDoc => JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as DiskDoc
  const rolesOnDisk = (): Record<string, unknown> => settingsOnDisk().agents?.roles ?? {}

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "i-harness-rolescmd-"))
    previous = process.env.IH_CONFIG_DIR
    process.env.IH_CONFIG_DIR = home
    // A document with content in another section: the roles write must land in
    // its own plane and leave its neighbours alone.
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      fontSize: 15,
      llm: { providers: {}, defaultModel: { provider: "gw", model: "keep" } },
    }), "utf8")
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("set writes agents.roles.<role>, required halves together", async () => {
    expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "small"])).toBe(0)

    expect(rolesOnDisk()).toEqual({ general: { provider: "gw", model: "small" } })
    // The neighbouring plane is untouched — agents is its own section.
    const doc = settingsOnDisk()
    expect(doc.llm?.defaultModel).toEqual({ provider: "gw", model: "keep" })
    expect(doc.fontSize).toBe(15)
  })

  it("set says the gate will refuse the spawn, where the user just asked for it", async () => {
    // With the shipped default (`plugins.subagentModel: false`) this entry
    // turns every spawn of the role into a refusal. The plan accepted the
    // refusal as "a stop, not a surprise" — but the stop arrives LATER, in
    // another command's output. The note is a diagnostic (stderr), not an
    // error: the write is exactly what was asked for, so the exit stays 0.
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "small"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toContain("plugins.subagentModel is false")
    expect(errors.join("\n")).toContain("refused")
    // The note did not replace the write.
    expect(rolesOnDisk()).toEqual({ general: { provider: "gw", model: "small" } })
  })

  it("no note when the switch is already on", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ plugins: { subagentModel: true } }), "utf8")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "small"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toBe("")
    expect(rolesOnDisk()).toEqual({ general: { provider: "gw", model: "small" } })
  })

  it("set carries --protocol and --reasoning-effort into the entry", async () => {
    expect(await runRolesCommand([
      "roles", "set", "worker", "--provider", "gw", "--model", "big",
      "--protocol", "openai-responses", "--reasoning-effort", "max",
    ])).toBe(0)
    expect(rolesOnDisk()).toEqual({
      worker: { provider: "gw", model: "big", protocol: "openai-responses", reasoningEffort: "max" },
    })
  })

  it("a half selection is refused and NOTHING is written", async () => {
    const before = readFileSync(join(home, "settings.json"), "utf8")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toMatch(/--model is missing/)
    // The refusal happens at PARSE time, before the store is even loaded.
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before)
  })

  it("an unknown role is refused, the four are named, and nothing is written", async () => {
    const before = readFileSync(join(home, "settings.json"), "utf8")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "nosuchrole", "--provider", "gw", "--model", "m"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toContain(FOUR)
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before)
  })

  it("an unknown protocol is refused and nothing is written", async () => {
    const before = readFileSync(join(home, "settings.json"), "utf8")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "m", "--protocol", "grpc"])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join("\n")).toContain("grpc")
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before)
  })

  it("set REPLACES the whole entry: an omitted --protocol/--reasoning-effort clears it", async () => {
    expect(await runRolesCommand([
      "roles", "set", "general", "--provider", "gw", "--model", "small",
      "--protocol", "gemini", "--reasoning-effort", "high",
    ])).toBe(0)
    expect(rolesOnDisk()).toEqual({ general: { provider: "gw", model: "small", protocol: "gemini", reasoningEffort: "high" } })

    // The design's §2 rule 2, and the opposite of `models set` (where an
    // omitted flag leaves the field alone): the unit here is "which model this
    // role runs on", so the second write is the whole answer.
    expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "big"])).toBe(0)
    expect(rolesOnDisk()).toEqual({ general: { provider: "gw", model: "big" } })

    // …and the printed result states what happened to both cleared fields.
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "big"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join("\n")).toContain("role \"general\": gw:big (protocol: unset, reasoning effort: unset)")
  })

  it("unset takes the whole entry out — the role inherits again", async () => {
    await runRolesCommand(["roles", "set", "general", "--provider", "gw", "--model", "small"])
    await runRolesCommand(["roles", "set", "worker", "--provider", "gw", "--model", "big"])

    expect(await runRolesCommand(["roles", "unset", "general"])).toBe(0)
    expect(rolesOnDisk()).toEqual({ worker: { provider: "gw", model: "big" } })
  })

  it("unset of a role that declares nothing says so instead of claiming success", async () => {
    const before = readFileSync(join(home, "settings.json"), "utf8")
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "unset", "worker"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(lines.join("\n")).toContain("already inherits")
    expect(lines.join("\n")).not.toContain("now inherits")
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before)
  })

  it("list says a declared row is refused while the switch is off, and nothing when it is on", async () => {
    await runRolesCommand(["roles", "set", "worker", "--provider", "gw", "--model", "big"])
    const list = async (): Promise<string> => {
      const lines: string[] = []
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
      try {
        expect(await runRolesCommand(["roles", "list"])).toBe(0)
      } finally {
        spy.mockRestore()
      }
      return lines.join("\n")
    }

    // the shipped default: every declared row is a spawn refusal, and the read
    // verb is where a user looks to understand that
    expect(await list()).toContain("plugins.subagentModel is false")
    // …and with the switch on the same declared row is NOT a refusal
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      plugins: { subagentModel: true },
      agents: { roles: { worker: { provider: "gw", model: "big" } } },
    }), "utf8")
    const on = await list()
    expect(on).toContain("worker  declared: gw:big")
    expect(on).not.toContain("plugins.subagentModel")
  })

  it("list names each role and says declared or inherited", async () => {
    await runRolesCommand(["roles", "set", "worker", "--provider", "gw", "--model", "big", "--reasoning-effort", "max"])
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "list"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = lines.join("\n")
    for (const name of ["general", "explore", "research", "worker"]) expect(out).toContain(name)
    expect(out).toContain("worker  declared: gw:big")
    expect(out).toContain("reasoning effort: max")
    expect(out).toContain("general  inherited")
    expect(out).toContain("3 inheriting the parent's client")
  })

  it("list shows a role declared by hand that is not one of the four", async () => {
    // `reviewer` is a REAL role name here: the guardian registers it into the
    // registry the spawn tools read, and every role-carrying spawn (the
    // guardian's included) forwards the declared selection — so with the
    // switch on this entry is what decides its model, and with it off it is
    // what refuses the spawn.
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      agents: { roles: { reviewer: { provider: "gw", model: "m" }, general: { provider: "gw", model: "small" } } },
    }), "utf8")
    const lines: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")) })
    try {
      expect(await runRolesCommand(["roles", "list"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = lines.join("\n")
    expect(out).toContain("reviewer")
    expect(out).toContain("(not one of the four built-ins)")
    expect(out).not.toContain("nothing spawns it")
    expect(out).toContain("general  declared: gw:small")
  })

  it("the usage says set REPLACES the whole entry, and names the four roles", async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")) })
    try {
      // `roles help` prints usage; a refusal prints it on stderr too.
      expect(await runRolesCommand(["roles", "help"])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = errors.join("\n")
    expect(out).toMatch(/REPLACES the whole entry/)
    expect(out).toContain(FOUR)
    // The usage names only verbs that exist.
    expect(out).toMatch(/usage: i-harness roles <list\|set\|unset>/)
  })
})
