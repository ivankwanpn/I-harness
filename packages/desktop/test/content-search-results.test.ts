import { describe, expect, it } from "vitest"
import { checkedContentSearchResult, checkedSearchPreview } from "../src/renderer/review/content-search-results.ts"

const result = { roots: [{ workspaceId: "root", label: "Root" }], matches: [], status: "completed", partial: false, truncated: false, reasons: [], diagnostics: [], stats: { candidateFiles: 1, attemptedFiles: 1, readFiles: 1, completedFiles: 1, eofFiles: 1, inputBytes: 1, engineRawBytes: 1, runnerRawBytes: 0 }, filters: {}, limits: {} }
describe("content response bounds", () => {
  it.each(["candidateFiles", "attemptedFiles", "readFiles", "completedFiles", "eofFiles"]) ("refuses an impossible %s count", key => {
    expect(() => checkedContentSearchResult({ ...result, stats: { ...result.stats, [key]: 1001 } })).toThrow()
  })
  it.each([["inputBytes", 33554433], ["engineRawBytes", 1048577], ["runnerRawBytes", 1048577]]) ("refuses a %s count exceeding the aggregate reader budget", (key, value) => {
    expect(() => checkedContentSearchResult({ ...result, stats: { ...result.stats, [key]: value } })).toThrow()
  })
  it("refuses a preview whose displayed UTF16 text exceeds 32KiB", () => {
    expect(() => checkedSearchPreview({ readonly: true, text: "a".repeat(16385), startLine: 1, encoding: "utf16le", revision: "a".repeat(64), changedSinceSearch: false, truncated: true })).toThrow()
  })
})
