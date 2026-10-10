import { expect, it } from "vitest"
import { projectHistoryTimeline, projectTimeline } from "../src/renderer/session/project.ts"

it("retains dispatch separately from call admission and preserves its history sequence", () => {
  const call = { type: "tool/call" as const, callId: "owned-c1", name: "bash", args: { command: "node owned-fixture" }, seq: 1 }
  expect(projectTimeline([call])[0]).not.toHaveProperty("dispatched")
  expect(projectHistoryTimeline([call, { type: "tool/dispatch", callId: "owned-c1", eventSeq: 1, seq: 2 }])[0]).toMatchObject({ id: "tool:owned-c1", kind: "tool", dispatched: true, seqs: [1, 2] })
})

it("pairs nested calls by cell identity and keeps their groups separate", () => {
  const rows = projectHistoryTimeline([
    { type: "turn/start", seq: 0 },
    { type: "code/call", cellId: "a", parentCallId: "outer-a", callId: "same", name: "read", args: { path: "a.txt" }, seq: 1 },
    { type: "code/call", cellId: "b", parentCallId: "outer-b", callId: "same", name: "read", args: { path: "b.txt" }, seq: 2 },
    { type: "code/dispatch", cellId: "a", callId: "same", eventSeq: 1, seq: 3 },
    { type: "code/result", cellId: "b", callId: "same", name: "read", output: { content: "b result" }, seq: 4 },
    { type: "code/result", cellId: "a", callId: "same", name: "read", output: { error: "a failed" }, isError: true, seq: 5 },
    { type: "turn/end", seq: 6 },
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ id: "code-tool:a:same", kind: "tool", cellId: "a", parentCallId: "outer-a", output: { error: "a failed" }, dispatched: true, resultReceived: true, isError: true, seqs: [1, 3, 5] })
  expect(rows[1]).toMatchObject({ id: "code-tool:b:same", kind: "tool", cellId: "b", parentCallId: "outer-b", output: { content: "b result" }, resultReceived: true, seqs: [2, 4] })
  expect(rows[0]?.kind === "tool" && rows[0].groupScope).not.toBe(rows[1]?.kind === "tool" && rows[1].groupScope)
})

it("keeps an orphan nested result readable under its actual cell and call identity", () => {
  expect(projectHistoryTimeline([{ type: "code/result", cellId: "old-cell", callId: "old-call", name: "read", output: "saved content", seq: 90 }])[0]).toMatchObject({ id: "code-tool:old-cell:old-call", kind: "tool", name: "read", cellId: "old-cell", output: "saved content", resultReceived: true, seqs: [90] })
})

it("attaches a retained result reference without dropping persisted metadata or replaying its result", () => {
  const ref = { id: "owned-ref", workspaceId: "owned-w", sessionId: "owned-s", callId: "c", label: "owned", revision: "r", bytes: 8, originalBytes: 80, complete: false, expiresAt: 100 }
  const rows = projectHistoryTimeline([
    { type: "tool/call", callId: "c", name: "read", args: { path: "owned" }, seq: 1 },
    { type: "context/result-ref", ref, seq: 2 },
    { type: "tool/result", callId: "c", name: "read", output: { content: "captured" }, seq: 3 },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: "tool:c", output: { content: "captured" }, resultRefs: [ref], seqs: [1, 2, 3] })
})

it("retains durable Code Mode records for lazy presentation with their cell identity", () => {
  const rows = projectTimeline([
    { type: "code/cell", cellId: "owned-cell", parentCallId: "outer", state: "started", source: "text('owned')", seq: 1 },
    { type: "code/output", cellId: "owned-cell", content: { type: "text", text: "owned output" }, seq: 2 },
    { type: "code/store", version: 1, cellId: "owned-cell", writes: [["owned-key", { value: 7 }]], seq: 3 },
    { type: "code/cell", cellId: "owned-cell", state: "interrupted", error: "recorded interruption", seq: 4 },
  ])
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ kind: "other", codeActivity: { type: "code/cell", source: "text('owned')" }, title: expect.stringContaining("owned-cell") })
  expect(rows[1]).toMatchObject({ kind: "other", codeActivity: { type: "code/output", content: { type: "text", text: "owned output" } }, title: expect.stringContaining("owned-cell") })
  expect(rows[2]).toMatchObject({ kind: "other", codeActivity: { type: "code/store", writes: [["owned-key", { value: 7 }]] }, title: expect.stringContaining("owned-cell") })
  expect(rows[3]).toMatchObject({ kind: "other", codeActivity: { type: "code/cell", state: "interrupted", error: "recorded interruption" }, title: expect.stringContaining("owned-cell") })
  expect(rows.every(row => row.kind === "other" && row.detail === undefined)).toBe(true)
})
