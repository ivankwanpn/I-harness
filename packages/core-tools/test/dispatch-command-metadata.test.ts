import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type ToolDispatchMetadata } from "../src/index.ts"

it("captures command dialect once so pre/post hooks describe the same prepared executable", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let dialect: "posix" | "powershell" = "posix"
  const seen: unknown[] = []
  ctx.onCascade("tools/execute", async (input, next) => {
    const metadata = input as ToolDispatchMetadata
    seen.push(metadata.commandDialect)
    const output = await next()
    seen.push(metadata.commandDialect)
    return output
  })
  tools.register({ name: "shell", description: "", inputSchema: {},
    commandDialect: () => dialect,
    execute: async () => { dialect = "powershell"; return {} },
  })
  await tools.execute({ name: "shell", args: { command: "echo safe" } })
  expect(seen).toEqual(["posix", "posix"])
})
