import { expect, it } from "vitest"
import { projectTimeline } from "../src/renderer/session/project.ts"
import { groupActivities } from "../src/renderer/session/activity-groups.ts"
import { workStages } from "../src/renderer/session/work-stages.ts"
it("collapses a recorded turn's work without hiding the user, final answer or outcome", () => {
  const rows = projectTimeline([
    { type: "turn/start", seq: 0 }, { type: "user/message", text: "task", seq: 1 },
    { type: "assistant/message", text: "Checking", seq: 2 },
    { type: "tool/call", name: "read", callId: "c", args: { path: "a" }, seq: 3 },
    { type: "tool/result", name: "read", callId: "c", output: "file", seq: 4 },
    { type: "assistant/message", text: "Final answer", seq: 5 },
    { type: "step/end", truncated: true, seq: 6 }, { type: "turn/end", seq: 7 },
  ])
  const grouped = groupActivities(rows)
  const expanded = workStages(grouped, new Map())
  expect(expanded.map((row) => row.kind)).toEqual(["message", "work-stage", "message", "tool", "message", "outcome"])
  const collapsed = workStages(grouped, new Map([["work:turn:0", false]]))
  expect(collapsed.map((row) => row.id)).toEqual(["message:1", "work:turn:0", "message:5", "step:6"])
})
