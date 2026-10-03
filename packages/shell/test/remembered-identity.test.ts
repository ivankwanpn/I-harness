import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createShellTools } from "../src/index.ts"
import type { ExecService } from "@i-harness/exec"

it("provides a prepared executable binding for a literal native version query while refusing opaque scripts", async () => {
  const commands: any[] = []
  const tools = createShellTools({ exec: { run: async (command: unknown) => { commands.push(command); return { stdout: "fixture", stderr: "", exitCode: 0 } } } as unknown as ExecService, cwd: process.cwd(), agentShell: () => ({ id: "fixture", label: "fixture", command: process.execPath, dialect: "posix" }) })
  const shell = tools.find((tool) => tool.name === "shell")!
  const ctx = createContext(); const registry = createToolRegistry(ctx); registry.register(shell)
  let identity: any
  ctx.on("tools/pre-execute", (call: any) => { identity = shell.approvalIdentity?.(call.args) })
  const prepared = await registry.prepare({ name: "shell", args: { command: `"${process.execPath}" --version` } })
  expect(identity?.executablePaths).toContain(process.execPath)
  expect(JSON.parse(identity.binding).cwd).toBe(process.cwd())
  expect(shell.approvalIdentity?.({ command: "git status && other" })).toBeUndefined()
  await registry.dispatch(prepared)
  expect(commands[0].argv[0]).toBe(process.execPath)
})
