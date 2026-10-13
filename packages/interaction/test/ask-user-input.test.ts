import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { askUser, createAskUserInputTool, registerAskUserInput, registerQuestionProvider, USER_DEFERRED_QUESTION } from "../src/index.ts"

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

it("converts a deferred question into a structured result instead of passing a marker off as an answer", async () => {
  // WHY: "the user will answer later" must not reach the model as if it were
  // something the user said. `QuestionProvider.ask` returns a string, so the
  // deferral travels as a sentinel and the tool turns it into `deferred: true`
  // with NO `answer` — a shape the model can tell apart from typed text.
  const ctx = createContext()
  registerQuestionProvider(ctx, { ask: async () => USER_DEFERRED_QUESTION })
  const tool = createAskUserInputTool({ ask: (q) => askUser(ctx, q) })
  const out = await tool.execute({ question: "which approach?" }, {}) as { question: string; deferred?: true; answer?: string }
  expect(out).toEqual({ question: "which approach?", deferred: true })
  expect("answer" in out).toBe(false)
})

it("states the deferral in the tool description so the model knows not to invent a choice", () => {
  const tool = createAskUserInputTool({ ask: async () => "x" })
  expect(tool.description).toMatch(/skip|defer/i)
  const schema = tool.inputSchema as { properties: { options: { description: string } } }
  expect(schema.properties.options.description).toMatch(/free|own words|defer/i)
})

it("registerAskUserInput wires the ctx-based ask and registers the tool", () => {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  registerAskUserInput(ctx, registry)
  expect(registry.get("ask_user_input")).toBeDefined()
  // provider 未註冊時執行失敗閉：從 registry 直取 execute
})
