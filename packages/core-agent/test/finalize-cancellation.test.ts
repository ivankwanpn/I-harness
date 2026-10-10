import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, TOOL_ABORTED_BEFORE_DISPATCH } from "@i-harness/core-tools"
import { executeToolCalls } from "../src/execute-tool-calls.ts"

it("owner cancellation while finalize awaits keeps one completed result and suppresses post-tool and later bodies", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const owner = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const postTools: string[] = []
  let laterBodies = 0
  ctx.on("tools/post-execute", async () => { entered.resolve(); await release.promise })
  ctx.on("agent/post-tool", input => { postTools.push((input as { name: string }).name) })
  tools.register({ name: "first", description: "Complete before finalization", inputSchema: {}, execute: async () => ({ completed: true }) })
  tools.register({ name: "later", description: "Must not start after owner cancellation", inputSchema: {}, execute: async () => { laterBodies++; return {} } })
  const work = executeToolCalls(ctx, session, tools, [
    { callId: "completed", name: "first", args: {} },
    { callId: "pending", name: "later", args: {} },
  ], { maxParallel: 1, signal: owner.signal })
  const rejected = expect(work).rejects.toThrow("agent aborted")
  await entered.promise
  owner.abort()
  release.resolve()
  await rejected
  expect(postTools).toEqual([])
  expect(laterBodies).toBe(0)
  expect(session.events.filter(event => event.type === "tool/result")).toMatchObject([
    { callId: "completed", name: "first", output: { completed: true } },
    { callId: "pending", name: "later", isError: true, output: { code: TOOL_ABORTED_BEFORE_DISPATCH } },
  ])
  expect(session.events.filter(event => event.type === "tool/result" && event.callId === "completed")).toHaveLength(1)
  expect(session.events.filter(event => event.type === "tool/dispatch").map(event => event.callId)).toEqual(["completed"])
})
