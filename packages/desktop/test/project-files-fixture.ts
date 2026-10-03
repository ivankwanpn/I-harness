import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectCatalog } from "../src/main/projects.ts"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import { createProjectFiles, dispatchGatewayProjectFiles, type ProjectFilesRequest } from "../../desktop-gateway/src/project-files.ts"
import { createWorkspaceReview } from "../../desktop-gateway/src/review.ts"
import { createProjectContentSearch, dispatchGatewayContentSearch } from "../../desktop-gateway/src/project-content-search.ts"
import { closeDesktopProjectContentSearches } from "../src/main/project-content-search.ts"
import type { DesktopIpcDependencies } from "../src/main/ipc.ts"

export async function projectFilesFixture() {
  const home = await mkdtemp(join(tmpdir(), "ih-project-files-")), firstPath = join(home, "first"), secondPath = join(home, "second")
  await mkdir(firstPath); await mkdir(secondPath)
  await writeFile(join(firstPath, "same.txt"), "first"); await writeFile(join(secondPath, "same.txt"), "second")
  const catalog = createWorkspaceCatalog(join(home, "workspaces.json")), first = await catalog.open(firstPath), second = await catalog.open(secondPath)
  const projects = createProjectCatalog(join(home, "projects.json"), catalog)
  const project = await projects.save({ name: "Both roots", workspaceIds: [first.id, second.id], primaryWorkspaceId: first.id })
  const pending = new Set<Promise<unknown>>()
  let closing = false
  function track<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) throw new Error("Project files fixture is closing")
    const job = operation(); pending.add(job)
    void job.then(() => pending.delete(job), () => pending.delete(job))
    return job
  }
  const trackedFiles = (files: ReturnType<typeof createProjectFiles>) => ({ ...files,
    list: (...args: Parameters<typeof files.list>) => track(() => files.list(...args)),
    search: (...args: Parameters<typeof files.search>) => track(() => files.search(...args)),
    read: (...args: Parameters<typeof files.read>) => track(() => files.read(...args)),
    save: (...args: Parameters<typeof files.save>) => track(() => files.save(...args)),
  })
  const reviews = new Map([[first.id, createWorkspaceReview(firstPath)], [second.id, createWorkspaceReview(secondPath)]]), files = new Map([...reviews].map(([id, review]) => [id, trackedFiles(createProjectFiles(catalog.get(id)!.path, review))]))
  const content = new Map([first, second].map(entry => [entry.id, createProjectContentSearch(entry.path)]))
  let onGet: ((id: string) => Promise<void>) | undefined
  let onRequest: ((method: string) => Promise<void>) | undefined
  let onBeforeRequest: ((method: string, params: unknown) => Promise<void> | void) | undefined
  const dependencies = { catalog, projects, runtimes: { async get(entry: { id: string }) {
    await onGet?.(entry.id)
    return { info: { capabilities: { "desktop-project-files": ["1"], "desktop-project-scope": ["1"], "desktop-project-content-search": ["1"] } }, client: { async request(method: string, params: unknown) {
      await onBeforeRequest?.(method, params)
      if (method === "desktop/session/project/state") return { sessionId: "owner", projectId: project.id }
      const result = await (["desktop/project-files/content-search", "desktop/project-files/content-cancel", "desktop/project-files/search-preview", "desktop/project-files/external-read", "desktop/project-files/external-preview"].includes(method) ? dispatchGatewayContentSearch(method, params, content.get(entry.id)!) : dispatchGatewayProjectFiles(method, params, files.get(entry.id)!))
      await onRequest?.(method)
      return result
    } } }
  } } } as unknown as DesktopIpcDependencies
  const selection = { workspaceId: first.id, sessionId: "owner", projectId: "renderer-forgery" }
  return { home, first, second, projects, project, selection, files, reviews, content, dependencies,
    request: (request: ProjectFilesRequest) => track(() => dispatchDesktopRequest(request, dependencies)),
    seedFiles(workspaceId: string, names: readonly string[]) {
      const root = catalog.get(workspaceId)?.path
      if (!root || names.some(name => !name || /[\\/\0:]/.test(name) || name === "." || name === "..")) throw new Error("Invalid owned fixture file")
      const copied = [...names]
      return track(async () => {
        let next = 0
        // Bound filesystem queue pressure; every requested file is still real.
        const results = await Promise.allSettled(Array.from({ length: Math.min(16, copied.length) }, async () => {
          while (next < copied.length) { const name = copied[next++]!; await writeFile(join(root, name), "x") }
        }))
        const failure = results.find(result => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      })
    },
    async dispose() {
      closing = true
      await closeDesktopProjectContentSearches()
      await Promise.all([...content.values()].map(service => service.close()))
      while (pending.size) await Promise.allSettled([...pending])
      await Promise.all([...reviews.values()].map(review => review.close()))
    },
    beforeGet(callback: (id: string) => Promise<void>) { onGet = callback },
    afterRequest(callback: (method: string) => Promise<void>) { onRequest = callback },
    beforeRequest(callback: (method: string, params: unknown) => Promise<void> | void) { onBeforeRequest = callback },
  }
}
