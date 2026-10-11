import { expect, it, vi } from "vitest"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import type { DesktopIpcDependencies } from "../src/main/ipc.ts"
import type { DesktopRequest } from "../src/shared/bridge.ts"

function fixture() {
  const page = { items: [{ name: "brainstorming", kind: "skill", source: "plugin", pluginId: "fixture__superpowers" }], total: 1, diagnostics: [] }
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method !== "desktop/resources/suggestions") throw new Error(`Unexpected operation: ${method}`)
    if (JSON.stringify(params) !== JSON.stringify({ query: "" })) throw new Error("Only the query may cross IPC")
    return page
  })
  const workspace = { id: "known", path: "D:/fixture", label: "Fixture" }
  const get = vi.fn(async () => ({ client: { request }, info: { capabilities: { "desktop-resources": ["1"] } } }))
  const dependencies = { catalog: { get: (id: string) => id === "known" ? workspace : undefined }, runtimes: { get } } as unknown as DesktopIpcDependencies
  return { page, request, get, dependencies }
}

it("routes resource suggestions to the selected workspace using only a bounded query without a session", async () => {
  const f = fixture()
  const request: DesktopRequest = { kind: "desktop/resources/suggestions", workspaceId: "known", query: "" }
  expect(await dispatchDesktopRequest({ ...request, body: "renderer body", path: "D:/untrusted", includeShadowed: true }, f.dependencies)).toEqual(f.page)
  expect(f.request).toHaveBeenCalledWith("desktop/resources/suggestions", { query: "" }, 30000)
})

it("rejects invalid queries and unknown workspaces before starting a runtime", async () => {
  const f = fixture()
  for (const query of [undefined, null, 1, "x".repeat(513)]) {
    await expect(dispatchDesktopRequest({ kind: "desktop/resources/suggestions", workspaceId: "known", query }, f.dependencies)).rejects.toThrow(/query/i)
  }
  await expect(dispatchDesktopRequest({ kind: "desktop/resources/suggestions", workspaceId: "absent", query: "" }, f.dependencies)).rejects.toThrow(/Unknown workspace/i)
  expect(f.get).not.toHaveBeenCalled()
})
