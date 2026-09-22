import { describe, expect, it } from "vitest"
import { parseCommandMarkdown } from "../src/commands.ts"

// Spec 2026-09-17 §3 decision 3. A frontmatter key we do not honour must NOT be
// silently dropped: a command declaring `allowed-tools` would then believe it is
// restricted while nothing enforces it — the "looks successful, did nothing"
// defect this repo keeps deleting. It is RECORDED instead, and the command still
// loads (the CommandConflict precedent: "the plugin still enables, with the
// limitation recorded").
describe("command frontmatter — unsupported keys are recorded, never dropped", () => {
  it("records an unsupported key and still parses the command", () => {
    const desc = parseCommandMarkdown(
      "review.md",
      ["---", "description: Review a change", "allowed-tools: Read, Grep", "---", "## Your Task", "Review $ARGUMENTS"].join("\n"),
    )
    expect(desc.name).toBe("review")
    expect(desc.description).toBe("Review a change")
    expect(desc.body).toBe("## Your Task\nReview $ARGUMENTS")
    expect(desc.unsupported).toEqual(["allowed-tools"])
  })

  it("records every unsupported key, in file order, without duplicates", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "model: opus", "description: X", "allowed-tools: Bash", "---", "body"].join("\n"),
    )
    expect(desc.unsupported).toEqual(["model", "allowed-tools"])
  })

  it("the honoured keys are never recorded as unsupported, in any spelling", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "DESCRIPTION: X", "argument-hint: [a]", "argument_hints: [b]", "argumentHints: [c]", "---", "body"].join("\n"),
    )
    expect(desc.unsupported).toBeUndefined()
  })

  it("a command with no frontmatter has no unsupported keys", () => {
    const desc = parseCommandMarkdown("x.md", "just a body")
    expect(desc.unsupported).toBeUndefined()
    expect(desc.body).toBe("just a body")
  })

  it("a frontmatter line that is not key: value is neither honoured nor recorded", () => {
    const desc = parseCommandMarkdown("x.md", ["---", "not a pair", "description: X", "---", "body"].join("\n"))
    expect(desc.description).toBe("X")
    expect(desc.unsupported).toBeUndefined()
  })
})

// YAML block scalars: `key: |` (and `>`, and the `-`/`+` chomping variants)
// make the value the INDENTED BLOCK below the key, not the marker itself.
//
// Measured 2026-09-17 against the 35 real agents/*.md in the local official
// marketplace snapshot: 4 of them use `description: |`. The single-line reader
// takes the literal "|" as the value and then reads every INDENTED line that
// contains a colon as a KEY — so a real agent's description becomes the
// one-character string "|" and ~15 phantom keys (`Context`, `user`, `assistant`)
// land in `unsupported`. `commands/*.md` has zero block scalars (30 files,
// measured), which is the only reason this was latent.
describe("frontmatter block scalars", () => {
  it("a literal block scalar is the indented block, not the marker", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "description: |", "  first line", "  second line", "---", "body"].join("\n"),
    )
    expect(desc.description).toBe("first line\nsecond line")
    expect(desc.body).toBe("body")
  })

  it("indented block content is content, never a key", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "description: |", "  Context: a phantom key", "  user: another", "model: opus", "---", "body"].join("\n"),
    )
    // only `model` is a real key; the two indented lines are the description
    expect(desc.unsupported).toEqual(["model"])
    expect(desc.description).toBe("Context: a phantom key\nuser: another")
    expect(desc.body).toBe("body")
  })

  it("a blank line inside the block survives, and only an un-indented line ends it", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "description: |", "  para one", "", "  para two", "model: opus", "---", "body"].join("\n"),
    )
    expect(desc.description).toContain("para one")
    expect(desc.description).toContain("para two")
    expect(desc.unsupported).toEqual(["model"])
  })

  it("a chomping indicator is consumed, not read as the value", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "description: |-", "  only line", "---", "body"].join("\n"),
    )
    expect(desc.description).toBe("only line")
  })

  it("a folded block scalar joins its lines with spaces", () => {
    const desc = parseCommandMarkdown(
      "x.md",
      ["---", "description: >", "  folded one", "  folded two", "---", "body"].join("\n"),
    )
    expect(desc.description).toBe("folded one folded two")
  })
})
