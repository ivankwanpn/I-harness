import { describe, expect, it } from "vitest"
import { buildCommandLine, quoteArg } from "../src/spawn.ts"

describe("quoteArg (Windows argv quoting)", () => {
  it("quotes empty args", () => {
    expect(quoteArg("")).toBe('""')
  })

  it("does not quote a plain non-whitespace arg", () => {
    expect(quoteArg("hello")).toBe("hello")
  })

  it("quotes args with spaces + backslashes before a quote", () => {
    expect(quoteArg("C:\\path with spaces\\file.txt")).toBe('"C:\\path with spaces\\file.txt"')
  })

  // buildCommandLine is imported for the same quoteArg surface: it joins the
  // program and args through quoteArg into the single command-line string
  // CreateProcess parses.
  it("joins program and args through quoteArg", () => {
    expect(buildCommandLine("C:\\bin\\tool.exe", ["plain", "with space"])).toBe(
      'C:\\bin\\tool.exe plain "with space"',
    )
  })
})
