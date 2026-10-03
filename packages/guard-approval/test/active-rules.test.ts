import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createApprovalRuleStore, prepareApprovalEvidence } from "../src/active-rules.ts"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it("reuses immutable prepared arguments across restart and asks after revoke, expiry, policy or binding change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-rules-")); directories.push(directory)
  const executable = join(directory, "fixture.exe")
  writeFileSync(executable, Buffer.from([0x4d, 0x5a, 1, 2]))
  const ctx = createContext(); const registry = createToolRegistry(ctx)
  let binding = "fixture-v1", policy = "policy-v1", clock = 1000, asks = 0
  const tool: Tool = { name: "native", description: "fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (args) => args,
    approvalIdentity: () => ({ binding, executablePaths: [executable] }) }
  registry.register(tool)
  ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
  let store = createApprovalRuleStore(join(directory, "rules.json"), () => clock)
  let evidence: ReturnType<typeof prepareApprovalEvidence>["evidence"]
  ctx.services.register("approval/prepared", (input: { tool: Tool; call: { name: string; args: unknown } }) => {
    const prepared = prepareApprovalEvidence({ ...input, workspaceId: "w", policyRevision: policy })
    evidence = prepared.evidence
    return { remembered: evidence !== undefined && store.matches(evidence, "s"), remember: { available: evidence !== undefined } }
  })
  ctx.services.register("approval/answerer", async () => { asks++; return true })
  const call = { name: "native", args: { value: "one" } }
  await registry.prepare(call, undefined, { sessionId: "s" })
  expect(asks).toBe(1)
  const rule = store.add(evidence!, { kind: "session", sessionId: "s" }, 2000)
  store = createApprovalRuleStore(join(directory, "rules.json"), () => clock)
  await registry.prepare(call, undefined, { sessionId: "s" }); expect(asks).toBe(1)
  await registry.prepare({ ...call, args: { value: "two" } }); expect(asks).toBe(2)
  policy = "policy-v2"; await registry.prepare(call); expect(asks).toBe(3); policy = "policy-v1"
  binding = "fixture-v2"; await registry.prepare(call); expect(asks).toBe(4); binding = "fixture-v1"
  writeFileSync(executable, Buffer.from([0x4d, 0x5a, 9, 9])); await registry.prepare(call); expect(asks).toBe(5)
  writeFileSync(executable, Buffer.from([0x4d, 0x5a, 1, 2])); clock = 2001
  await registry.prepare(call); expect(asks).toBe(6)
  store.revoke(rule.id); expect(store.list()).toEqual([])
  clock = 1000; await registry.prepare(call); expect(asks).toBe(7)
})

it("refuses compound, wrapper and opaque shell evidence instead of broad prefix grants", () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-rules-")); directories.push(directory)
  const executable = join(directory, "git.exe"); writeFileSync(executable, Buffer.from([0x4d, 0x5a, 1]))
  const tool: Tool = { name: "shell", description: "", inputSchema: {}, execute: async () => null,
    approvalIdentity: (args: unknown) => ({ binding: "shell-v1", executablePaths: [executable], command: { text: (args as { command: string }).command, dialect: "posix" } }) }
  const prepare = (command: string) => prepareApprovalEvidence({ tool, call: { name: "shell", args: { command } }, workspaceId: "w", policyRevision: "p" })
  expect(prepare(`${executable.replaceAll("\\", "/")} status`).evidence).toBeDefined()
  for (const command of [`${executable} status && dangerous-other-command`, `${executable} status; echo bad`, "git status", "bash -c git", "$(git status)", "git status\nrm x"]) expect(prepare(command).evidence).toBeUndefined()
})

it("rejects truncated/redacted arguments, scripts, corrupt persistence and cross-session matches", () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-rules-")); directories.push(directory)
  const path = join(directory, "rules.json")
  const tool: Tool = { name: "fixture", description: "", inputSchema: {}, execute: async () => null, approvalIdentity: () => ({ binding: "v1" }) }
  const prepare = (args: unknown) => prepareApprovalEvidence({ tool, call: { name: "fixture", args }, workspaceId: "w", policyRevision: "p" })
  expect(prepare({ password: "secret" }).evidence).toBeUndefined()
  expect(prepare({ value: "x".repeat(4001) }).evidence).toBeUndefined()
  const evidence = prepare({ value: "one" }).evidence!
  const store = createApprovalRuleStore(path, () => 1000)
  store.add(evidence, { kind: "session", sessionId: "one" }, 2000)
  expect(store.matches(evidence, "two")).toBe(false)
  expect(store.matches(evidence, "one")).toBe(true)
  store.removeSession("one"); expect(store.matches(evidence, "one")).toBe(false)
  writeFileSync(path, "{bad json")
  expect(store.matches(evidence, "one")).toBe(false)
  expect(() => store.add(evidence, { kind: "workspace" }, 2000)).toThrow()
  const script = join(directory, "script.sh"); writeFileSync(script, "#!/bin/sh\necho fixture")
  tool.approvalIdentity = () => ({ binding: "v1", executablePaths: [script] })
  expect(prepare({ value: "one" }).evidence).toBeUndefined()
})
