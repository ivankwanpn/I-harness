import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "../src/index.ts"

it("classifies only the missing binding lookup as a repairable tool-name failure before policy or approval", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let policyCalls = 0
  ctx.on("tools/pre-execute", () => { policyCalls++ })
  let failure: unknown
  try { await registry.prepare({ name: "parent_only_tool", args: {} }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ name: "ToolNotFoundError", message: "unknown tool: parent_only_tool" })
  expect(policyCalls).toBe(0)
})
