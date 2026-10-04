import { expect, it } from "vitest"
import { applyHistory, applyNotification, emptyEventWindow, timelineEvents } from "../src/renderer/session/event-window.ts"
import { projectHistoryTimeline, projectTimeline, type WireEvent } from "../src/renderer/session/project.ts"
import { groupActivities } from "../src/renderer/session/activity-groups.ts"
import { workStages } from "../src/renderer/session/work-stages.ts"

it("keeps repeated model rounds inside one ordered work stage and leaves the final answer visible", () => {
  // The observed Messages run had 59 nonempty reasoning blocks in one turn.
  const events: WireEvent[] = [{ type: "turn/start", seq: 0 }, { type: "user/message", text: "Run a tool check", seq: 1 }]
  for (let round = 0; round < 59; round++) {
    events.push({ type: "reasoning", streamId: `${round}:0`, blockId: "0", text: `Check ${round}`, seq: events.length })
    events.push({ type: "tool/call", callId: `read-${round}`, name: "read", args: {}, seq: events.length })
    events.push({ type: "tool/result", callId: `read-${round}`, name: "read", output: `Result ${round}`, seq: events.length })
  }
  const finalSeq = events.length
  events.push({ type: "assistant/message", text: "Check complete", seq: finalSeq }, { type: "todo/write", version: 1, items: [], seq: finalSeq + 1 }, { type: "turn/end", seq: finalSeq + 2 })
  const grouped = groupActivities(projectHistoryTimeline(events))
  expect(workStages(grouped, new Map()).map(row => row.id)).toEqual(["message:1", "work:turn:0", `message:${finalSeq}`])
  const expanded = workStages(grouped, new Map([["work:turn:0", true]]))
  expect(expanded.filter(row => row.kind === "other" && row.label === "reasoning")).toHaveLength(59)
  expect(expanded.slice(2, 6).map(row => row.id)).toEqual(["reasoning:0:0", "tool:read-0", "reasoning:1:0", "tool:read-1"])
  const reasoning = expanded.find(row => row.id === "reasoning:20:0")
  expect(reasoning?.kind === "other" && reasoning.seqs).toEqual([62])
})

it("does not promote commentary followed by a tool to a final answer", () => {
  const rows = projectTimeline([{ type: "turn/start", seq: 0 }, { type: "assistant/message", text: "Checking", seq: 1 }, { type: "tool/call", callId: "r", name: "read", args: {}, seq: 2 }, { type: "turn/end", seq: 3 }])
  expect(workStages(groupActivities(rows), new Map()).map(row => row.id)).toEqual(["work:turn:0"])
})

it("does not create an empty final bubble for a tool-only provider round", () => {
  const rows = projectTimeline([{ type: "turn/start", seq: 0 }, { type: "tool/call", callId: "r", name: "read", args: {}, seq: 1 }, { type: "tool/result", callId: "r", name: "read", output: "file", seq: 2 }, { type: "assistant/message", text: "", seq: 3 }, { type: "turn/end", seq: 4 }])
  expect(rows.filter(row => row.kind === "message")).toEqual([])
  expect(workStages(groupActivities(rows), new Map()).map(row => row.id)).toEqual(["work:turn:0"])
  expect(projectTimeline([{ type: "step/end", empty: true, seq: 5 }])).toMatchObject([{ kind: "outcome", flags: { empty: true } }])
})

it("omits empty thinking without disturbing later live block identity", () => {
  expect(projectTimeline([{ type: "reasoning", text: "", seq: 0 }, { type: "reasoning/chunk", streamId: "a", text: " \n", offset: 0, atSeq: 1 }])).toEqual([])
  const rows = projectTimeline([{ type: "reasoning/chunk", streamId: "a", text: "", offset: 0, atSeq: 1 }, { type: "reasoning/chunk", streamId: "a", text: "Inspect", offset: 0, atSeq: 1 }])
  expect(rows).toEqual([{ id: "reasoning:a", kind: "other", label: "reasoning", detail: "Inspect", transient: true }])
})

it("retains reasoning pieces across a delivery gap and settles replay without repeating text", () => {
  const chunks: WireEvent[] = [
    { type: "reasoning/chunk", streamId: "a", text: "A", offset: 0, atSeq: 0 },
    { type: "reasoning/chunk", streamId: "a", text: "C", offset: 2, atSeq: 0 },
    { type: "reasoning/chunk", streamId: "a", text: "B", offset: 1, atSeq: 0 },
  ]
  expect(projectTimeline(chunks)[0]).toMatchObject({ id: "reasoning:a", detail: "ABC" })
  let state = emptyEventWindow()
  for (const chunk of chunks) state = applyNotification(state, chunk)
  state = applyHistory(state, { events: [{ type: "reasoning", streamId: "a", text: "ABC", seq: 0 }], nextSeq: 1 })
  state = applyNotification(state, chunks[2]!)
  expect(projectTimeline(timelineEvents(state))).toEqual([{ id: "reasoning:a", kind: "other", label: "reasoning", detail: "ABC" }])
})

it("renders trusted machine inputs as readable activity while literal human wrappers remain user messages", () => {
  const task = '<task id="child"><task_error>Prepared approval authority or policy changed before dispatch</task_error></task>'
  const team = "Team result: child stopped"
  const schedule = "[SCHEDULE REMINDER] Tool check due"
  const events: WireEvent[] = [
    { type: "user/message", text: `${task}\n${team}\n${schedule}`, seq: 0 },
    { type: "user/message", text: task, input: { inputId: "child-1", intent: "system", synthetic: { description: "Child task result", scope: "turn" } }, seq: 1 },
    { type: "user/message", text: team, input: { inputId: "team-1", intent: "system" }, seq: 2 },
    { type: "user/message", text: schedule, input: { inputId: "schedule-1", intent: "system" }, seq: 3 },
  ]
  const rows = projectHistoryTimeline(events)
  expect(rows.filter(row => row.kind === "message")).toEqual([{ id: "message:0", kind: "message", role: "user", text: `${task}\n${team}\n${schedule}`, seqs: [0] }])
  expect(rows.slice(1).map(row => row.kind === "other" ? row.detail : undefined)).toEqual([task, team, schedule])
  expect(rows[1]).toMatchObject({ id: "message:1", kind: "other", label: "agent/input/system", title: "Child task result", seqs: [1] })
})

it("uses exact trusted admission correlation for legacy records and treats missing provenance conservatively", () => {
  const machine = "[SCHEDULE REMINDER] Due"
  const rows = projectTimeline([
    { type: "agent/input/admitted", version: 1, inputId: "q", text: machine, delivery: "steer", intent: "system", synthetic: { description: "Scheduled reminder", scope: "turn" }, seq: 0 },
    { type: "agent/input/promoted", version: 1, inputId: "q", seq: 1 },
    { type: "user/message", text: machine, seq: 2 },
    { type: "user/message", text: machine, seq: 3 },
    { type: "user/message", text: "Team result: no admission in this window", source: { kind: "plugin", plugin: "i-harness/system-input" }, seq: 4 },
  ])
  expect(rows.map(row => row.kind)).toEqual(["other", "message", "other"])
  expect(rows[0]).toMatchObject({ id: "message:2", label: "agent/input/system", title: "Scheduled reminder", detail: machine })
  expect(rows[1]).toMatchObject({ role: "user", text: machine })
})

it("shows structured task presentation without changing its raw model transport", () => {
  const frame = '<task state="completed"><task_result>Read tool failed</task_result></task>'
  const rows = projectTimeline([{ type: "user/message", text: frame, input: { inputId: "task", intent: "system", synthetic: { description: "Inspect", scope: "turn", display: { kind: "task", title: "Task reply ended: Inspect", body: "Read tool failed" } } }, seq: 1 }])
  expect(rows).toEqual([{ id: "message:1", kind: "other", label: "agent/input/system", title: "Task reply ended: Inspect", detail: "Read tool failed" }])
})

it("keeps partial historical pages readable without inventing a missing turn start or a final answer", () => {
  const rows = projectHistoryTimeline([{ type: "reasoning", streamId: "old", text: "Thought from an older page", seq: 100 }, { type: "assistant/message", text: "Partial page", seq: 101 }, { type: "turn/end", seq: 102 }])
  expect(workStages(groupActivities(rows), new Map())).toEqual(rows)
  expect(rows.every(row => row.turn === undefined)).toBe(true)
})
