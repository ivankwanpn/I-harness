import { expect, it } from "vitest"
import { projectTimeline } from "../src/renderer/session/project.ts"

it("does not label a truncated step as an interrupted response", () => {
  const rows = projectTimeline([
    { type: "turn/start", seq: 1 },
    { type: "user/message", seq: 2, text: "write a long answer" },
    { type: "assistant/message", seq: 3, text: "partial answer" },
    { type: "step/end", seq: 4, truncated: true },
    { type: "step/failed", seq: 5 },
    { type: "turn/end", seq: 6 },
  ] as never)
  expect(rows.some(row => row.kind === "outcome" && row.flags?.truncated === true)).toBe(true)
  expect(rows.some(row => row.kind === "other" && row.label === "step/failed")).toBe(false)
})

it("keeps a genuine failed step visible", () => {
  const rows = projectTimeline([
    { type: "turn/start", seq: 1 },
    { type: "step/start", seq: 2 },
    { type: "step/failed", seq: 3 },
    { type: "turn/end", seq: 4 },
  ] as never)
  expect(rows.some(row => row.kind === "other" && row.label === "step/failed")).toBe(true)
})
