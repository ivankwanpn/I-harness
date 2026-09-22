import { describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeAgents, parseAgentMarkdown } from "../src/agents.ts"

// A plugin declares subagents as `agents/*.md`: frontmatter plus a body that IS
// the system prompt. Every case below is shaped from the real files in the local
// official marketplace snapshot (8 plugins, 35 agents/*.md) rather than from a
// reading of the format — the four `tools:` forms and the scoped-argument comma
// are both things the corpus does and a guess would have missed.
describe("agent frontmatter", () => {
  it("reads a real-shaped agent: name, description, model, tools, body-as-prompt", () => {
    const a = parseAgentMarkdown("code-simplifier.md", [
      "---",
      "name: code-simplifier",
      "description: Simplifies and refines code for clarity.",
      "model: opus",
      "tools: Read, Glob, Grep",
      "color: blue",
      "---",
      "You are an expert code simplification specialist.",
    ].join("\n"))

    expect(a.name).toBe("code-simplifier")
    expect(a.description).toBe("Simplifies and refines code for clarity.")
    expect(a.systemPrompt).toBe("You are an expert code simplification specialist.")
    expect(a.tools).toEqual(["Read", "Glob", "Grep"])
    expect(a.model).toBe("opus")
    // display-only: recorded, never silently dropped
    expect(a.unsupported).toEqual(["color"])
  })

  it("reads the JSON-array tools form", () => {
    const a = parseAgentMarkdown("x.md", ["---", 'tools: ["Read", "Grep"]', "---", "prompt"].join("\n"))
    expect(a.tools).toEqual(["Read", "Grep"])
  })

  it("an absent tools key is 'inherit', which is NOT the same as an empty list", () => {
    const inherited = parseAgentMarkdown("x.md", ["---", "name: x", "---", "prompt"].join("\n"))
    const none = parseAgentMarkdown("y.md", ["---", "name: y", "tools: []", "---", "prompt"].join("\n"))
    expect(inherited.tools).toBeUndefined()
    expect(none.tools).toEqual([])
  })

  it("a comma inside a scoped argument does not split the entry", () => {
    // `Agent(a:one, a:two)` is ONE entry; a naive split would yield the two
    // fragments `Agent(a:one` and `a:two)`, which resolve to nothing.
    const a = parseAgentMarkdown("x.md", ["---", "tools: Read, Agent(a:one, a:two), Grep", "---", "p"].join("\n"))
    expect(a.tools).toEqual(["Read", "Agent(a:one, a:two)", "Grep"])
  })

  it("the declared name wins; the file name is only the fallback", () => {
    // All 32 real files that declare a `name` have it equal to the file name, so
    // the corpus cannot tell these two rules apart — this case has to be
    // synthetic, and the first version of it (filename only) passed against a
    // do-nothing stub, i.e. it did not test the rule it claimed to.
    const declared = parseAgentMarkdown("file-name.md", ["---", "name: declared-name", "---", "prompt"].join("\n"))
    const fallback = parseAgentMarkdown("helper.md", ["---", "description: d", "---", "prompt"].join("\n"))
    expect(declared.name).toBe("declared-name")
    expect(fallback.name).toBe("helper")
  })

  it("a file with no frontmatter is all prompt", () => {
    const a = parseAgentMarkdown("bare.md", "You are a bare agent.")
    expect(a.name).toBe("bare")
    expect(a.systemPrompt).toBe("You are a bare agent.")
    expect(a.description).toBe("")
    expect(a.tools).toBeUndefined()
    expect(a.unsupported).toBeUndefined()
  })

  it("reads a block-scalar description (the shared reader reaches this parser too)", () => {
    const a = parseAgentMarkdown("x.md", [
      "---", "description: |", "  Context: a phantom key", "  user: another", "color: blue", "---", "prompt",
    ].join("\n"))
    expect(a.description).toBe("Context: a phantom key\nuser: another")
    // `color` is the only key here this parser does not honour (`model` IS
    // honoured for agents, unlike for commands) — the block's two lines are
    // content, and reading them as keys is the defect this pins.
    expect(a.unsupported).toEqual(["color"])
  })
})

describe("describeAgents", () => {
  it("scans *.md sorted by name; a missing directory is no agents, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ih-agents-"))
    try {
      // the FILE names and the DECLARED names sort in OPPOSITE orders, so this
      // distinguishes "sort by the name the host will show" from "sort by file"
      await writeFile(join(dir, "b-file.md"), ["---", "name: alpha", "---", "a prompt"].join("\n"), "utf8")
      await writeFile(join(dir, "a-file.md"), ["---", "name: zeta", "---", "z prompt"].join("\n"), "utf8")
      await writeFile(join(dir, "notes.txt"), "not an agent", "utf8")
      expect(describeAgents(dir).map((a) => a.name)).toEqual(["alpha", "zeta"])
      expect(describeAgents(join(dir, "no-such-subdir"))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("an entry that cannot be read is SKIPPED with a warning, and the rest still load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ih-agents-"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await writeFile(join(dir, "good.md"), ["---", "name: good", "---", "prompt"].join("\n"), "utf8")
      // a DIRECTORY named *.md: readdir lists it, readFile cannot read it
      await mkdir(join(dir, "broken.md"), { recursive: true })
      expect(describeAgents(dir).map((a) => a.name)).toEqual(["good"])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain("broken.md")
    } finally {
      warn.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
