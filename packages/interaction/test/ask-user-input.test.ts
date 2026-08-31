import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { askUser, createAskUserInputTool, registerAskUserInput, registerQuestionProvider } from "../src/index.ts"

it("ask_user_input forwards the question to the provider and returns the answer", async () => {
  const ctx = createContext()
  registerQuestionProvider(ctx, { ask: async (q) => { expect(q.prompt).toBe("which approach?"); expect(q.options).toEqual(["a", "b"]); return "a" } })
  const tool = createAskUserInputTool({ ask: (q) => askUser(ctx, q) })
  expect(tool.name).toBe("ask_user_input")
  const out = await tool.execute({ question: "which approach?", options: ["a", "b"] }, {})
  expect(out).toEqual({ question: "which approach?", answer: "a" })
})

it("fails closed with NO_PROVIDER when no question provider is registered", async () => {
  const ctx = createContext()
  const tool = createAskUserInputTool({ ask: (q) => askUser(ctx, q) })
  await expect(tool.execute({ question: "x" }, {})).rejects.toThrow(/NO_PROVIDER/)
})

it("registerAskUserInput wires the ctx-based ask and registers the tool", () => {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registerAskUserInput(ctx, registry)
  expect(registry.get("ask_user_input")).toBeDefined()
  // provider 未註冊時執行失敗閉：從 registry 直取 execute
})
