import { expect, it, vi } from "vitest"
import { projectRuntimeContexts, syncLiveProjectContexts } from "../src/main/project-runtime.ts"
import type { ProjectCatalog } from "../src/main/projects.ts"
import type { WorkspaceCatalog } from "../src/main/workspaces.ts"
import type { WorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
const folders = [{ id: "a", path: "D:/a", label: "a" }, { id: "b", path: "D:/b", label: "b" }]
const catalog: WorkspaceCatalog = { get: (id) => folders.find((folder) => folder.id === id), list: async () => folders, open: async () => folders[0]! }
function projects(): ProjectCatalog { return { list: async () => [{ id: "p", name: "Project", workspaceIds: ["a", "b"], primaryWorkspaceId: "b", createdAt: "now", updatedAt: "now" }, { id: "empty", name: "Empty", workspaceIds: [], createdAt: "now", updatedAt: "now" }], save: async () => { throw new Error("unused") }, remove: async () => {}, unassigned: async () => [] } }
it("maps known folder IDs to all project roots and retains empty authority markers", async () => {
  expect(await projectRuntimeContexts(projects(), catalog)).toEqual([{ id: "p", name: "Project", roots: ["D:/a", "D:/b"], primaryRoot: "D:/b" }, { id: "empty", name: "Empty", roots: [] }])
})
it("syncs only existing runtimes and closes a runtime that cannot accept the changed authority", async () => {
  const request = vi.fn(async () => { throw new Error("scope update rejected") })
  const invalidate = vi.fn(async () => {})
  const get = vi.fn(async () => { throw new Error("must remain lazy") })
  const runtimes = { get, peek: (id: string) => id === "a" ? { client: { request } } : undefined, invalidate } as unknown as WorkspaceRuntimeManager
  await expect(syncLiveProjectContexts(projects(), catalog, runtimes)).rejects.toThrow("Project scope update failed")
  expect(get).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledWith("desktop/project/sync", { projects: expect.arrayContaining([{ id: "empty", name: "Empty", roots: [] }]) })
  expect(invalidate).toHaveBeenCalledWith("a")
})
it("uses the manager publication fence so pending gateways cannot be skipped", async () => {
  const refreshProjectContexts = vi.fn(async () => {})
  const get = vi.fn(async () => { throw new Error("must remain lazy") })
  const runtimes = { get, refreshProjectContexts } as unknown as WorkspaceRuntimeManager
  await syncLiveProjectContexts(projects(), catalog, runtimes)
  expect(refreshProjectContexts).toHaveBeenCalledTimes(1)
  expect(get).not.toHaveBeenCalled()
})
