import { expect, it } from "vitest"
import { parseUnifiedDiff } from "../src/renderer/review/unified-diff.ts"
it("derives old/new positions and stops at the hunk boundary", () => {
  const rows = parseUnifiedDiff('--- a/file\n+++ b/file\n@@ -8,2 +10,3 @@\n same\n-old\n+++value\n+next\n+++ metadata')
  expect(rows[3]).toMatchObject({ oldLine: 8, newLine: 10 })
  expect(rows[4]).toMatchObject({ oldLine: 9, kind: "removed" })
  expect(rows[5]).toMatchObject({ newLine: 11, kind: "added" })
  expect(rows[6]).toMatchObject({ newLine: 12 })
  expect(rows[7]).toEqual({ line: "+++ metadata", kind: "context" })
})
it("supports new-file hunks and does not count no-newline metadata", () => {
  const rows = parseUnifiedDiff('@@ -0,0 +1,2 @@\r\n+first\r\n\\ No newline at end of file\r\n+last')
  expect(rows[1]).toMatchObject({ newLine: 1 })
  expect(rows[2]).not.toHaveProperty("newLine")
  expect(rows[3]).toMatchObject({ newLine: 2 })
})
