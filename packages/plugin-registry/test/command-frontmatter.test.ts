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
