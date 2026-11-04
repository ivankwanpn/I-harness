import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { resolveRoleTools } from "../src/child/role-tools.ts"

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: "object" }, execute: async () => name })

it("keeps a host-provided child tool and does not overwrite it with the parent copy", () => {
  const ctx = createContext()
  const parent = createToolRegistry(ctx), child = createToolRegistry(ctx)
  const parentBash = tool("bash"), childBash = tool("bash")
  parent.register(parentBash)
  child.register(childBash)
  expect(resolveRoleTools("worker", ["bash"], parent, child)).toEqual([])
  expect(child.get("bash")).toBe(childBash)
})

it("still copies a parent tool the child does not have", () => {
  const ctx = createContext()
  const parent = createToolRegistry(ctx), child = createToolRegistry(ctx)
  const parentRead = tool("read")
  parent.register(parentRead)
  expect(resolveRoleTools("worker", ["read"], parent, child)).toEqual([])
  expect(child.get("read")).toBe(parentRead)
})
