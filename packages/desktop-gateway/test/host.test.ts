import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
import { createCredentialStore } from "@i-harness/credentials"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(mode: "read-only" | "workspace-write" | "danger-full-access") {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-host-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  const settingsPath = join(root, "settings.json")
  mkdirSync(workspace)
  mkdirSync(sessionDir)
  writeFileSync(settingsPath, JSON.stringify({ sandboxMode: mode }), "utf8")
  const frames: RpcMessage[] = []
  return { root, workspace, sessionDir, settingsPath, frames }
}

describe("Desktop host sandbox configuration", () => {
  it("reports saved agent defaults separately until a real host restart", async () => {
    const f = fixture("read-only")
    let host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    let id = 300
    const call = async (method: string, params = {}) => {
      const requestId = ++id
      await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === requestId)
      if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
      return reply.result
    }
    try {
      const init = await call("initialize")
      expect(init).toMatchObject({ capabilities: { "desktop-agent-settings": ["1"] } })
      expect(await call("desktop/agent-settings/configure", { sandboxMode: "workspace-write", autoCompaction: false })).toMatchObject({ restartRequired: true, effective: { sandboxMode: "read-only", autoCompaction: true } })
      await host.close()
      host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
      await call("initialize")
      expect(await call("desktop/agent-settings/state")).toMatchObject({ restartRequired: false, effective: { sandboxMode: "workspace-write", autoCompaction: false } })
    } finally { await host.close() }
  })
  it("persists provider commands across a host restart without leaking the API key", async () => {
    const f = fixture("read-only")
    let host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    let nextId = 1
    const call = async (method: string, params: unknown) => {
      const id = nextId++
      await host.handleLine(encodeFrame(makeRequest(id, method, params)))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === id)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("operation failed")
      return reply.result
    }
    try {
      await call("initialize", {})
      const session = await call("session/create", {}) as { sessionId: string }
      expect(await call("session/model/state", { sessionId: session.sessionId })).toMatchObject({ status: "unconfigured" })
      await call("desktop/provider/mutate", { action: "provider/create", id: "ui-test", fields: { protocol: "openai-completions", baseURL: "https://example.invalid" } })
      await call("desktop/provider/mutate", { action: "key/set", id: "ui-test", value: "ui-secret-fixture" })
      await call("desktop/provider/mutate", { action: "model/add", id: "ui-test", model: "m", fields: { contextWindow: 272000 } })
      await call("desktop/provider/mutate", { action: "model/edit", id: "ui-test", model: "m", fields: { contextWindow: 1000000 } })
      await call("desktop/provider/mutate", { action: "default/set", id: "ui-test", model: "m" })
      expect(await call("session/model/state", { sessionId: session.sessionId })).toMatchObject({ status: "ready", modelId: "m" })
      const selection = { provider: "ui-test", model: "another-model", protocol: "openai-responses", reasoningEffort: "high" }
      expect(await call("session/model/set", { sessionId: session.sessionId, selection })).toMatchObject({ status: "ready", providerId: "ui-test", modelId: "another-model", protocol: "openai-responses", reasoningEffort: "high" })
      await call("desktop/session/manage", { sessionId: session.sessionId, action: "rename", title: "Saved title" })
      await call("desktop/session/manage", { sessionId: session.sessionId, action: "archive" })
      expect(await call("session/list", {})).toMatchObject({ sessions: [] })
      await host.close()
      host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
      await call("initialize", {})
      expect(await call("session/model/state", { sessionId: session.sessionId })).toMatchObject({ status: "ready", providerId: "ui-test", modelId: "another-model", reasoningEffort: "high" })
      expect(await call("desktop/session/archived", {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: session.sessionId, title: "Saved title" })]))
      await call("desktop/session/manage", { sessionId: session.sessionId, action: "restore" })
      expect(await call("session/list", {})).toMatchObject({ sessions: [{ id: session.sessionId, title: "Saved title" }] })
      const directory = await call("desktop/provider/directory", {})
      expect(directory).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ui-test", auth: expect.objectContaining({ configured: true }), models: [expect.objectContaining({ id: "m", contextWindow: 1000000 })] })]))
      expect(JSON.stringify(f.frames)).not.toContain("ui-secret-fixture")
    } finally { await host.close() }
  })
  it("exposes the existing provider directory without returning credentials", async () => {
    const f = fixture("read-only")
    const credentialsPath = join(f.root, "credentials.json")
    await createCredentialStore(credentialsPath).set("DESKTOP_TEST_SECRET", "test-secret-not-for-renderer")
    writeFileSync(f.settingsPath, JSON.stringify({ sandboxMode: "read-only", llm: {
      providers: { "desktop-test": { protocol: "openai-completions", apiKeyEnv: "DESKTOP_TEST_SECRET", baseUrl: "https://example.invalid/v1", models: [{ id: "test-model", contextWindow: 272000 }] } },
    } }))
    const host = await createDesktopHost({ ...f, credentialsPath, onWrite: (frame) => f.frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/provider/directory", {})))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("provider directory missing")
      expect(reply.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: "desktop-test", models: expect.arrayContaining([expect.objectContaining({ id: "test-model", contextWindow: 272000 })]) })]))
      expect(JSON.stringify(reply.result)).not.toContain('"apiKey":')
      expect(JSON.stringify(reply.result)).not.toContain("test-secret-not-for-renderer")
      expect(reply.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: "desktop-test", auth: expect.objectContaining({ configured: true }) })]))
      const initialized = f.frames.find((frame) => "id" in frame && frame.id === 1)
      expect(isRpcSuccess(initialized) && initialized.result).toMatchObject({ capabilities: { "desktop-provider": ["1"] } })
    } finally { await host.close() }
  })
  it("loads settings before reporting the wired read-only mode", async () => {
    const f = fixture("read-only")
    const host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/sandbox/state", {})))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox state missing")
      expect(reply.result).toEqual({ mode: "read-only", source: "settings", wired: true })
    } finally { await host.close() }
  })

  it("uses the operator's workspace-write setting, not an implicit default", async () => {
    const f = fixture("workspace-write")
    const host = await createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })
    try {
      await host.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
      await host.handleLine(encodeFrame(makeRequest(2, "desktop/sandbox/state", {})))
      const reply = f.frames.find((frame) => "id" in frame && frame.id === 2)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error("sandbox state missing")
      expect(reply.result).toEqual({ mode: "workspace-write", source: "settings", wired: true })
    } finally { await host.close() }
  })

  it("refuses corrupt settings instead of reporting a default as configured", async () => {
    const f = fixture("read-only")
    writeFileSync(f.settingsPath, "{invalid", "utf8")
    await expect(createDesktopHost({ ...f, onWrite: (frame) => f.frames.push(frame) })).rejects.toThrow(/invalid settings/i)
  })
})
