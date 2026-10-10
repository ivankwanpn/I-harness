import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, TOOL_FAILED, ToolArgsError, ToolNotFoundError } from "@i-harness/core-tools"
import { executeToolCalls } from "../src/execute-tool-calls.ts"

it("answers an unknown model tool once and executes the independently authorized call in model order", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const prepared: string[] = []
  let bodies = 0
  ctx.on("tools/pre-execute", input => { prepared.push((input as { name: string }).name) })
  tools.register({ name: "allowed", description: "Allowed role capability", inputSchema: {}, execute: async () => { bodies++; return { completed: true } } })
  await executeToolCalls(ctx, session, tools, [
    { callId: "unknown", name: "parent_only_tool", args: {} },
    { callId: "known", name: "allowed", args: {} },
  ], { maxParallel: 2 })
  expect(prepared).toEqual(["allowed"])
  expect(bodies).toBe(1)
  expect(session.events.filter(event => event.type === "tool/result")).toMatchObject([
    { callId: "unknown", name: "parent_only_tool", isError: true, output: { error: "unknown tool: parent_only_tool", code: TOOL_FAILED } },
    { callId: "known", name: "allowed", output: { completed: true } },
  ])
  expect(session.events.filter(event => event.type === "tool/dispatch").map(event => event.callId)).toEqual(["known"])
})

it("an untyped preparation refusal remains loud even when its text looks like an unknown tool", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let bodies = 0
  ctx.on("tools/pre-execute", () => { throw new Error("unknown tool: policy unavailable") })
  for (const name of ["first", "later"]) tools.register({ name, description: "Known binding", inputSchema: {}, execute: async () => { bodies++; return {} } })
  await expect(executeToolCalls(ctx, session, tools, [
    { callId: "first", name: "first", args: {} }, { callId: "later", name: "later", args: {} },
  ], { maxParallel: 2 })).rejects.toThrow("unknown tool: policy unavailable")
  expect(bodies).toBe(0)
  expect(session.events.filter(event => event.type === "tool/dispatch")).toEqual([])
})

it.each([
  { label: "unknown tool", error: new ToolNotFoundError("absent") },
  { label: "arguments", error: new ToolArgsError(["policy metadata unavailable"]) },
])("an explicit policy refusal dominates a repairable $label error type", async ({ error }) => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let bodies = 0
  const refusal = Object.assign(error, { policyRefusal: true as const })
  ctx.on("tools/pre-execute", input => { if ((input as { name: string }).name === "first") throw refusal })
  for (const name of ["first", "later"]) tools.register({ name, description: "Known binding", inputSchema: {}, execute: async () => { bodies++; return {} } })
  await expect(executeToolCalls(ctx, session, tools, [
    { callId: "first", name: "first", args: {} }, { callId: "later", name: "later", args: {} },
  ], { maxParallel: 2 })).rejects.toBe(refusal)
  expect(bodies).toBe(0)
  expect(session.events.filter(event => event.type === "tool/dispatch")).toEqual([])
})
