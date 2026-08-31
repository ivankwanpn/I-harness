import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { listCommands, listCommandNames, parseCommandLine, registerCommand } from "../src/index.ts"

describe("command discovery + line parsing (C-region additive surface)", () => {
  it("lists registered command descriptors (never the handlers), name-sorted", () => {
    const ctx = createContext()
    registerCommand(ctx, { name: "sandbox", execute: async () => "s" })
    registerCommand(ctx, { name: "theme", description: "Set the theme", argumentHints: "dark|light", execute: async () => "t" })
    expect(listCommandNames(ctx)).toEqual(["sandbox", "theme"])
    expect(listCommands(ctx)).toEqual([
      { name: "sandbox" },
      { name: "theme", description: "Set the theme", argumentHints: "dark|light" },
    ])
  })

  it("an empty registry lists [] without throwing", () => {
    const ctx = createContext()
    expect(listCommands(ctx)).toEqual([])
    expect(listCommandNames(ctx)).toEqual([])
  })

  it("registerCommand rejects a name the parser could never dispatch", () => {
    const ctx = createContext()
    expect(() => registerCommand(ctx, { name: "PlanOff", execute: async () => "x" }))
      .toThrow(/command name "PlanOff" must match/)
    expect(() => registerCommand(ctx, { name: "9lives", execute: async () => "x" }))
      .toThrow(/9lives/)
  })

  it("parseCommandLine accepts slash and slashless lowercase forms", () => {
    expect(parseCommandLine("/theme dark")).toEqual({ name: "theme", input: "dark" })
    expect(parseCommandLine("theme dark")).toEqual({ name: "theme", input: "dark" })
    expect(parseCommandLine("  theme   dark  ")).toEqual({ name: "theme", input: "dark" })
    expect(parseCommandLine("/join-team")).toEqual({ name: "join-team", input: "" })
  })

  it("parseCommandLine rejects blank and uppercase lines (the grammar, not the registry, decides)", () => {
    expect(parseCommandLine("")).toBeUndefined()
    expect(parseCommandLine("   ")).toBeUndefined()
    expect(parseCommandLine("/PlanOff dark")).toBeUndefined()
    // "ls" parses (the name grammar is lowercase) — whether it is REGISTERED
    // is the host's check against listCommandNames.
    expect(parseCommandLine("ls")).toEqual({ name: "ls", input: "" })
  })
})
