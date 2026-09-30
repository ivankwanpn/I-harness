import { mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createProjectScopeBroker } from "../src/project-scope.ts"
import { createConversationVisibility } from "../src/session-visibility.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "desktop-project-scope-")); roots.push(root)
  const workspace = join(root, "one"), second = join(root, "two"), third = join(root, "three")
  await Promise.all([workspace, second, third].map((path) => mkdir(path)))
  const sessionDir = join(root, "sessions")
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  await coordinator.create({ sessionId: "s1" })
  const broker = createProjectScopeBroker(coordinator, workspace, createConversationVisibility(coordinator))
  const project = { id: "p1", name: "Project", roots: [workspace, second], primaryRoot: workspace }
  return { root, workspace, second, third, sessionDir, coordinator, broker, project }
}

describe("trusted project scope broker", () => {
  it("persists only project ownership and requires current process confirmation after restart", async () => {
    const { coordinator, broker, project, workspace, sessionDir } = await setup()
    await broker.configure(project)
    await broker.bind("s1", "p1")
    expect((await broker.forSession("s1"))()).toEqual(project)
    await coordinator.close()
    const files = (await readdir(sessionDir)).filter((name) => name.includes("session-project"))
    expect(files).toHaveLength(1)
    const saved = JSON.parse(await readFile(join(sessionDir, files[0]!), "utf8"))
    expect(saved).toEqual({ version: 1, projectId: "p1" })
    const reloaded = createSessionCoordinator(createJsonlBackend(sessionDir))
    const restarted = createProjectScopeBroker(reloaded, workspace)
    try {
      expect(await restarted.state("s1")).toEqual({ sessionId: "s1", projectId: "p1" })
      const get = await restarted.forSession("s1")
      expect(get()).toBeUndefined()
      await restarted.configure(project)
      expect(get()).toEqual(project)
    } finally { await reloaded.close() }
  })

  it("updates live getters when trusted roots change and withdraws a removed project", async () => {
    const { coordinator, broker, project, third } = await setup()
    try {
      const get = await broker.forSession("s1")
      await broker.configure(project)
      await broker.bind("s1", "p1")
      expect(get()?.roots).toEqual(project.roots)
      await broker.configure({ ...project, name: "Renamed", roots: [project.primaryRoot, third] })
      expect(get()).toEqual({ ...project, name: "Renamed", roots: [project.primaryRoot, third] })
      get()!.roots.push("mutated by caller")
      expect(get()!.roots).toEqual([project.primaryRoot, third])
      await broker.revoke("p1")
      expect(get()).toBeUndefined()
      expect(await broker.projectFor("s1")).toBe("p1")
    } finally { await coordinator.close() }
  })

  it("rejects unknown projects and invalid roots while allowing project roots independent of storage cwd", async () => {
    const { coordinator, broker, project, second } = await setup()
    try {
      await expect(broker.bind("s1", "p1")).rejects.toThrow(/confirmed/)
      await broker.configure({ ...project, roots: [second], primaryRoot: second })
      await broker.bind("s1", "p1")
      expect((await broker.forSession("s1"))()).toEqual({ ...project, roots: [second], primaryRoot: second })
      await expect(broker.configure({ ...project, roots: ["relative", second] })).rejects.toThrow(/absolute/)
      await expect(broker.configure({ ...project, roots: [project.primaryRoot, join(second, "missing")] })).rejects.toThrow(/directory/)
      await expect(broker.configure({ ...project, primaryRoot: second + "-outside" })).rejects.toThrow(/primary/)
      expect(await broker.forSession("s1")).toThrow("Project folders are unavailable")
    } finally { await coordinator.close() }
  })

  it("keeps a session's project sticky including explicit unassigned ownership", async () => {
    const { coordinator, broker, project } = await setup()
    try {
      await broker.configure(project)
      await broker.configure({ ...project, id: "p2" })
      await broker.bind("s1", "p1")
      await broker.bind("s1", "p1")
      await expect(broker.bind("s1", "p2")).rejects.toThrow(/already belongs/)
      expect(await broker.bind("s1")).toEqual({ sessionId: "s1", projectId: "p1" })
      await coordinator.create({ sessionId: "unassigned" })
      await broker.bind("unassigned")
      await expect(broker.bind("unassigned", "p1")).rejects.toThrow(/already belongs/)
      expect((await broker.forSession("unassigned"))()).toBeUndefined()
    } finally { await coordinator.close() }
  })

  it("replaces the whole trusted catalog so removed projects cannot retain extra authority", async () => {
    const { coordinator, broker, project, second } = await setup()
    try {
      await broker.sync([project, { ...project, id: "p2", roots: [second], primaryRoot: second }])
      await broker.bind("s1", "p1")
      const get = await broker.forSession("s1")
      await broker.sync([{ ...project, id: "p2", roots: [second], primaryRoot: second }])
      expect(get()).toBeUndefined()
      expect(await broker.projectFor("s1")).toBe("p1")
      await broker.sync([project])
      expect(get()).toEqual(project)
      await expect(broker.sync([project, { ...project }])).rejects.toThrow(/duplicate/)
    } finally { await coordinator.close() }
  })

  it("fails closed for an existing project with no folders instead of restoring its old storage folder", async () => {
    const { coordinator, broker, project } = await setup()
    try {
      await broker.configure(project)
      await broker.bind("s1", "p1")
      const get = await broker.forSession("s1")
      await broker.sync([{ id: "p1", name: project.name, roots: [] }])
      expect(get).toThrow("Project has no workspace folders")
      expect(await broker.projectFor("s1")).toBe("p1")
      await expect(broker.bind("s1")).rejects.toThrow("Project has no workspace folders")
      await broker.sync([]) // deleting the whole grouping retains the legacy base folder
      expect(get()).toBeUndefined()
    } finally { await coordinator.close() }
  })

  it("isolates unavailable project folders while keeping healthy scopes usable and withdrawing old roots", async () => {
    const { coordinator, broker, project, third } = await setup()
    try {
      await coordinator.create({ sessionId: "s2" })
      const unavailable = { id: "p2", name: "Other", roots: [third], primaryRoot: third }
      await broker.sync([project, unavailable])
      await broker.bind("s1", "p1")
      await broker.bind("s2", "p2")
      const healthy = await broker.forSession("s1"), missing = await broker.forSession("s2")
      await rename(third, `${third}-moved`)
      await broker.sync([project, unavailable])
      expect(healthy()?.roots).toEqual(project.roots)
      expect(missing).toThrow("Project folders are unavailable")
      await expect(broker.bind("s2")).rejects.toThrow("Project folders are unavailable")
      await expect(broker.bind("s2", "p2")).rejects.toThrow("Project folders are unavailable")
      await coordinator.create({ sessionId: "s3" })
      await expect(broker.bind("s3", "p2")).rejects.toThrow("Project folders are unavailable")
      await expect(broker.sync([project, { ...unavailable, roots: ["relative"], primaryRoot: "relative" }])).rejects.toThrow(/absolute/)
      await expect(broker.sync([project, { ...unavailable, primaryRoot: project.primaryRoot }])).rejects.toThrow(/primary/)
      expect(healthy()?.roots).toEqual(project.roots)
      expect(missing).toThrow("Project folders are unavailable")
    } finally { await coordinator.close() }
  })

  it("does not let a slower earlier scope update restore authority after a newer removal", async () => {
    const { coordinator, broker, project } = await setup()
    try {
      await broker.configure(project)
      await broker.bind("s1", "p1")
      const get = await broker.forSession("s1")
      await Promise.all([broker.sync([project]), broker.sync([])])
      expect(get()).toBeUndefined()
      await Promise.all([broker.configure(project), broker.sync([])])
      expect(get()).toBeUndefined()
    } finally { await coordinator.close() }
  })

  it("withdraws live scope and drains owned asynchronous work during shutdown", async () => {
    const { coordinator, broker, project } = await setup()
    try {
      await broker.configure(project)
      await broker.bind("s1", "p1")
      const get = await broker.forSession("s1")
      const update = broker.sync([project])
      const closing = broker.close()
      await expect(update).rejects.toThrow(/closed/)
      await closing
      expect(get).toThrow("Project scope service closed")
      await expect(broker.bind("s1", "p1")).rejects.toThrow(/closed/)
    } finally { await coordinator.close() }
  })

  it("serializes competing first bindings and refuses internal reviewers", async () => {
    const { coordinator, broker, project } = await setup()
    try {
      await broker.configure(project)
      await broker.configure({ ...project, id: "p2" })
      const results = await Promise.allSettled([broker.bind("s1", "p1"), broker.bind("s1", "p2")])
      expect(results.map((row) => row.status)).toEqual(["fulfilled", "rejected"])
      await coordinator.create({ sessionId: "review", origin: "approval-review" })
      await expect(broker.bind("review", "p1")).rejects.toThrow(/unavailable/)
      await expect(broker.state("missing")).rejects.toThrow()
    } finally { await coordinator.close() }
  })

  it("inherits normal and team child ownership without storing permission roots or moving it to another project", async () => {
    const { coordinator, broker, project, sessionDir } = await setup()
    try {
      await coordinator.create({ sessionId: "child", parentSession: "s1", origin: "subagent", seedLength: 0 })
      await coordinator.create({ sessionId: "team-child", parentSession: "child", origin: "team", seedLength: 0 })
      const get = await broker.forSession("team-child")
      expect(get()).toBeUndefined()
      await broker.sync([project, { ...project, id: "p2" }])
      await broker.bind("s1", "p1")
      expect(await broker.projectFor("child")).toBe("p1")
      expect(await broker.projectFor("team-child")).toBe("p1")
      expect(get()?.id).toBe("p1")
      expect((await readdir(sessionDir)).filter((name) => name.includes("session-project"))).toHaveLength(1)
      await expect(broker.bind("team-child", "p2")).rejects.toThrow(/already belongs/)
      expect(await broker.bind("team-child")).toEqual({ sessionId: "team-child", projectId: "p1" })
      expect((await readdir(sessionDir)).filter((name) => name.includes("session-project"))).toHaveLength(2)
      await broker.sync([])
      expect(get()).toBeUndefined()
    } finally { await coordinator.close() }
  })

  it("rejects inherited ownership cycles before waiting on ancestor operations", async () => {
    const { coordinator, broker } = await setup()
    try {
      await coordinator.create({ sessionId: "cycle-a", parentSession: "cycle-b", origin: "subagent" })
      await coordinator.create({ sessionId: "cycle-b", parentSession: "cycle-a", origin: "team" })
      await expect(broker.projectFor("cycle-a")).rejects.toThrow(/lineage/)
      await expect(broker.forSession("cycle-a")).rejects.toThrow(/lineage/)
      await expect(broker.bind("cycle-b")).rejects.toThrow(/lineage/)
    } finally { await coordinator.close() }
  })

  it("does not accept or expose a binding whose document failed to persist", async () => {
    const { coordinator, project, workspace } = await setup()
    const failed = { ...coordinator, putDocument: vi.fn(async () => {}) }
    const broker = createProjectScopeBroker(failed, workspace)
    try {
      await broker.configure(project)
      await expect(broker.bind("s1", "p1")).rejects.toThrow(/persist/)
      expect(await broker.projectFor("s1")).toBeUndefined()
      expect((await broker.forSession("s1"))()).toBeUndefined()
    } finally { await coordinator.close() }
  })
})
