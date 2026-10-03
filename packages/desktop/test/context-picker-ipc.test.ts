import { expect, it, vi } from "vitest"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"

function fixture() {
  let members = ["host", "second"]
  const request = vi.fn(async (method: string) => method === "desktop/session/project/state" ? { sessionId: "s", projectId: "owner" } : { items: [], nextOffset: null })
  const get = vi.fn(async (_workspace: any) => ({ client: { request }, info: { capabilities: { "desktop-context-picker": ["1"], "desktop-project-scope": ["1"] } } }))
  const dependencies: any = { catalog: { get: (id: string) => ["host", "second", "foreign"].includes(id) ? { id, path: `D:/${id}`, label: id } : undefined },
    projects: { list: async () => [{ id: "owner", workspaceIds: members }, { id: "other", workspaceIds: ["foreign"] }] }, runtimes: { get } }
  return { dependencies, request, get, remove: () => { members = ["host"] } }
}
it("uses the session owner despite a forged renderer project and rejects a removed root after runtime startup", async () => {
  const f = fixture()
  const search = { kind: "desktop/context/search", workspaceId: "host", sessionId: "s", projectId: "other", query: "", contextKind: "files", offset: 0 }
  await dispatchDesktopRequest(search, f.dependencies)
  expect(f.get.mock.calls.map(([root]: any) => root.id)).toContain("second")
  expect(f.get.mock.calls.map(([root]: any) => root.id)).not.toContain("foreign")
  expect(f.request.mock.calls.some(([method]) => method === "desktop/context/search")).toBe(true)
  f.get.mockImplementation(async (workspace) => { if (workspace.id === "second") f.remove(); return { client: { request: f.request }, info: { capabilities: { "desktop-context-picker": ["1"], "desktop-project-scope": ["1"] } } } })
  await expect(dispatchDesktopRequest({ kind: "desktop/context/read", workspaceId: "host", sessionId: "s", reference: { kind: "file", workspaceId: "second", path: "a.md" } }, f.dependencies)).rejects.toThrow(/project|member|folder/i)
})
it("pages results across current project roots with bounded responses", async () => {
  const f = fixture()
  const items = Array.from({ length: 35 }, (_, index) => ({ kind: "file", path: `${index}.md`, label: `${index}.md` }))
  f.request.mockImplementation(async (method, ...args: any[]) => method === "desktop/context/search" ? { items: items.slice(args[0].offset, args[0].offset + 100), total: items.length } as any : { sessionId: "s", projectId: "owner" } as any)
  const search = { kind: "desktop/context/search", workspaceId: "host", sessionId: "s", query: "", contextKind: "files", offset: 0 }
  const first = await dispatchDesktopRequest(search, f.dependencies) as any
  expect(first.items).toHaveLength(30)
  expect(first.nextOffset).toBe(30)
  const second = await dispatchDesktopRequest({ ...search, offset: first.nextOffset }, f.dependencies) as any
  expect(second.items[0]).toMatchObject({ workspaceId: "host", path: "30.md" })
  expect(second.items).toHaveLength(30)
  expect(second.nextOffset).toBe(60)
})
it("unassigned sessions cannot use renderer projectId to read another root", async () => {
  const f = fixture()
  f.request.mockImplementation(async (method) => method === "desktop/session/project/state" ? { sessionId: "s" } as any : { items: [], nextOffset: null })
  await expect(dispatchDesktopRequest({ kind: "desktop/context/read", workspaceId: "host", sessionId: "s", projectId: "other", reference: { kind: "file", workspaceId: "foreign", path: "a.md" } }, f.dependencies)).rejects.toThrow(/project|member|folder/i)
})
