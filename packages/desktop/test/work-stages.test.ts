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
  const expanded = workStages(grouped, new Map([["work:turn:0", true]]))
  expect(expanded.map((row) => row.kind)).toEqual(["message", "work-stage", "message", "tool", "message", "outcome"])
  const collapsed = workStages(grouped, new Map())
  expect(collapsed.map((row) => row.id)).toEqual(["message:1", "work:turn:0", "message:5", "step:6"])
})

it("shows an unfinished turn inline until an actual turn end", () => {
  const rows = groupActivities(projectTimeline([
    { type: "turn/start", seq: 0 }, { type: "user/message", text: "task", seq: 1 },
    { type: "tool/call", callId: "c1", name: "read", args: {}, seq: 2 },
  ]))
  expect(workStages(rows, new Map()).map((row) => row.kind)).toEqual(["message", "tool"])
})

it("keeps mid-turn human steering, commentary and thinking ordered while work continues", () => {
  const events = [
    {type: "turn/start" as const, seq: 0}, {type: "user/message" as const, text: "Start", seq: 1},
    {type: "assistant/message" as const, text: "Checking files", seq: 2},
    {type: "reasoning" as const, text: "Inspect the actual directory", seq: 3},
    {type: "user/message" as const, text: "Also check the dialogs", seq: 4},
    {type: "tool/call" as const, name: "read", callId: "read", args: {path: "dialog.tsx"}, seq: 5},
    {type: "tool/result" as const, name: "read", callId: "read", output: "actual source", seq: 6},
  ]
  const live = workStages(groupActivities(projectTimeline(events)), new Map())
  expect(live.map(row => row.kind)).toEqual(["message", "message", "other", "message", "tool"])
  expect(live.some(row => row.kind === "work-stage")).toBe(false)
  const ended = workStages(groupActivities(projectTimeline([...events,
    {type: "assistant/message", text: "Final answer", seq: 7}, {type: "turn/end", seq: 8},
  ])), new Map())
  expect(ended.filter(row => row.kind === "work-stage")).toHaveLength(1)
  expect(ended.filter(row => row.kind === "message").map(row => row.text)).toEqual(["Start", "Also check the dialogs", "Final answer"])
})

it("counts failed activities inside a collapsed completed turn and keeps its final reply", () => {
  const items=groupActivities(projectTimeline([{type:"turn/start",seq:0},{type:"user/message",text:"Read",seq:1},
    {type:"tool/call",callId:"first",name:"bash",args:{},seq:2},
    {type:"tool/result",callId:"first",name:"bash",output:{exitCode:1},seq:3},
    {type:"tool/call",callId:"second",name:"bash",args:{},seq:4},
    {type:"tool/result",callId:"second",name:"bash",output:{exitCode:0},seq:5},
    {type:"assistant/message",text:"Final answer",seq:6},{type:"turn/end",seq:7}]))
  const stages=workStages(items,new Map())
  expect(stages.find(row=>row.kind==="work-stage")).toMatchObject({count:2,failedCount:1,expanded:false})
  expect(stages.at(-1)).toMatchObject({kind:"message",text:"Final answer"})
})
