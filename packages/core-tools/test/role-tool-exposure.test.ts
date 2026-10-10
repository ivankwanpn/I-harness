import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "../src/index.ts"

it("promotes declared tools only in their owning registry without replacing shared bindings or exposing hidden tools", () => {
  const parent = createToolRegistry(createContext()), child = createToolRegistry(createContext())
  const read: Tool = { name: "grep", description: "Search text", inputSchema: {}, exposure: "deferred", execute: async () => "found" }
  const hidden: Tool = { name: "hidden-admin", description: "Hidden", inputSchema: {}, exposure: "hidden", execute: async () => "hidden" }
  parent.register(read); child.register(read); child.register(hidden)
  child.promote(["grep", "hidden-admin"])
  expect(child.schemas().map(tool => tool.name)).toEqual(["grep"])
  expect(parent.schemas()).toEqual([])
  expect(child.get("grep")).toBe(parent.get("grep"))
  expect(read.exposure).toBe("deferred")
  expect(() => child.promote(["unregistered"])).toThrow("unknown tool")
  expect(child.schemas().map(tool => tool.name)).toEqual(["grep"])
})
