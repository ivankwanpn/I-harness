import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentSettings } from "../src/agent-settings.ts"
import { createFileProviderRuntime } from "@i-harness/provider-runtime/file"
import { vi } from "vitest"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it("persists only supported defaults without claiming the running sandbox changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, JSON.stringify({ sandboxMode: "read-only", compaction: { auto: true } }))
  const settings = createAgentSettings(path, { sandboxMode: "read-only", autoCompaction: true, approvalMode: "dangerous" })
  const provider = createFileProviderRuntime({ settingsPath: path, credentialsPath: join(root, "credentials.json") })
  await Promise.all([
    settings.configure({ sandboxMode: "workspace-write", autoCompaction: false }),
    provider.createProvider("test", { protocol: "openai-completions" }),
  ])
  expect(await settings.state()).toMatchObject({ saved: { sandboxMode: "workspace-write", autoCompaction: false }, effective: { sandboxMode: "read-only", autoCompaction: true }, restartRequired: true })
  const raw = JSON.parse(await readFile(path, "utf8"))
  expect(raw.llm.providers.test).toBeTruthy()
  await expect(settings.configure({ autoCompaction: "false" })).rejects.toThrow()
  await expect(settings.configure({ unknown: true })).rejects.toThrow()
})

it("refuses to replace damaged configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-agent-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, "{broken")
  const settings = createAgentSettings(path, { sandboxMode: "read-only", autoCompaction: true, approvalMode: "dangerous" })
  await expect(settings.configure({ autoCompaction: false })).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("{broken")
})

it("does not claim a live approval change when no host callback is installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-approval-static-")); roots.push(root)
  const path = join(root, "settings.json")
  const settings = createAgentSettings(path, { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" })
  expect(await settings.configure({ approvalMode: "delegate" })).toMatchObject({ saved: { approvalMode: "delegate" }, effective: { approvalMode: "dangerous" }, restartRequired: true })
})
it("tightens a live host when a watched settings document is invalid, then recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-policy-sync-")); roots.push(root)
  const path = join(root, "settings.json")
  await writeFile(path, JSON.stringify({ sandboxMode: "danger-full-access", approvalMode: "full-access" }))
  const sandbox = vi.fn()
  const approval = vi.fn()
  const settings = createAgentSettings(path, { sandboxMode: "danger-full-access", autoCompaction: true, approvalMode: "full-access" }, { onSandboxModeChanged: sandbox, onApprovalModeChanged: approval })
  await writeFile(path, JSON.stringify({ sandboxMode: "invalid", approvalMode: "full-access" }))
  await expect(settings.sync()).rejects.toThrow(/sandbox|settings/i)
  expect(sandbox).toHaveBeenLastCalledWith("read-only")
  expect(approval).toHaveBeenLastCalledWith("ask-all")
  await writeFile(path, JSON.stringify({ sandboxMode: "workspace-write", approvalMode: "dangerous" }))
  expect(await settings.sync()).toMatchObject({ effective: { sandboxMode: "workspace-write", approvalMode: "dangerous" }, restartRequired: false })
})

it("applies sandbox and approval changes live, including full access", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-approval-settings-")); roots.push(root)
  const path = join(root, "settings.json")
  const onApprovalModeChanged = vi.fn()
  const onSandboxModeChanged = vi.fn()
  const settings = createAgentSettings(path, { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" }, { onApprovalModeChanged, onSandboxModeChanged })
  const delegate = await settings.configure({ approvalMode: "delegate" })
  expect(delegate).toMatchObject({ saved: { approvalMode: "delegate" }, effective: { approvalMode: "delegate" }, restartRequired: false })
  expect(onApprovalModeChanged).toHaveBeenCalledWith("delegate")
  const full = await settings.configure({ approvalMode: "full-access" })
  expect(full).toMatchObject({ saved: { approvalMode: "full-access", sandboxMode: "danger-full-access" }, effective: { approvalMode: "full-access", sandboxMode: "danger-full-access" }, restartRequired: false })
  expect(onApprovalModeChanged).toHaveBeenLastCalledWith("full-access")
  expect(onSandboxModeChanged).toHaveBeenCalledWith("danger-full-access")
  expect((await readFile(path, "utf8"))).toContain('"approvalMode": "full-access"')
  await expect(settings.configure({ approvalMode: "full-access", sandboxMode: "read-only" })).rejects.toThrow(/full.access|sandbox/i)
  const narrowed = await settings.configure({ approvalMode: "dangerous", sandboxMode: "read-only" })
  expect(narrowed).toMatchObject({ effective: { approvalMode: "dangerous", sandboxMode: "read-only" }, restartRequired: false })
  expect(onSandboxModeChanged).toHaveBeenLastCalledWith("read-only")
})
