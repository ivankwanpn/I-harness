import { describe, expect, it, vi } from "vitest"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"
import { dispatchDesktopRequest, type DesktopIpcDependencies } from "../src/main/ipc.ts"
import { DESKTOP_CONFIGURATION_ID } from "@i-harness/desktop-gateway/src/host-protocol.ts"

describe("global provider setup without a selected workspace", () => {
  it("routes shared extension management through the profile without starting a project or accepting a renderer import path", async () => {
    const request = vi.fn(async () => ({})), startProject = vi.fn()
    const deps = { catalog: { get: () => undefined }, runtimes: { get: startProject },
      globalProviders: createGlobalProviderSettings(async () => ({ request })), pickSkill: async () => "C:/picked/SKILL.md",
    } as unknown as DesktopIpcDependencies
    const call = (kind: string, params: Record<string, unknown> = {}) => dispatchDesktopRequest({ kind, workspaceId: DESKTOP_CONFIGURATION_ID, ...params }, deps)
    await call("desktop/mcp/state")
    await call("desktop/plugins/mutate", { command: { action: "disable", id: "plugin" } })
    await call("desktop/resources/list", { resourceKind: "skills", query: "", offset: 0 })
    await call("desktop/resources/import", { source: "global", selectedPath: "C:/ignored/SKILL.md" })
    expect(request).toHaveBeenCalledWith("desktop/resources/import", { source: "global", selectedPath: "C:/picked/SKILL.md" })
    await expect(call("desktop/resources/read", { resourceKind: "skills", name: "a", source: "workspace" })).rejects.toThrow(/requires a workspace/)
    expect(startProject).not.toHaveBeenCalled()
    await deps.globalProviders!.close()
  })
  it("routes directory and persistence commands to the dedicated configuration runtime", async () => {
    const calls: unknown[] = []
    const settings = createGlobalProviderSettings(async () => ({ request: async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true } } }))
    await settings.request({ kind: "desktop/global-provider/directory" })
    await settings.request({ kind: "desktop/global-provider/mutate", command: { action: "model/add", id: "local", model: "model-a", fields: { protocol: "openai-responses" } } })
    await settings.request({ kind: "desktop/global-provider/mutate", command: { action: "video-audio/set", id: "local", model: "audio-model" } })
    expect(calls).toEqual([
      { method: "desktop/provider/directory", params: {} },
      { method: "desktop/provider/mutate", params: { action: "model/add", id: "local", model: "model-a", fields: { protocol: "openai-responses" } } },
      { method: "desktop/provider/mutate", params: { action: "video-audio/set", id: "local", model: "audio-model" } },
    ])
  })
  it("does not start a runtime for unknown operations or malformed probe identifiers", async () => {
    let started = 0
    const settings = createGlobalProviderSettings(async () => { started++; return { request: async () => null } })
    await expect(settings.request({ kind: "session/prompt", prompt: "do work" })).rejects.toThrow(/provider/i)
    await expect(settings.request({ kind: "desktop/global-provider/probe", id: "../outside", token: "x" })).rejects.toThrow(/provider/i)
    expect(started).toBe(0)
  })
})
