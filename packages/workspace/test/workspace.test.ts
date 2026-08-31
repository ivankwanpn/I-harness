import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import {
  WORKSPACE_DOC_KEY,
  WorkspaceBadRequestError,
  WorkspaceNotFoundError,
  createWorkspaceRegistry,
  type WorkspaceRegistry,
} from "../src/index.ts"

async function withRegistry(run: (registry: WorkspaceRegistry, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "i-harness-workspace-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    await run(createWorkspaceRegistry(coordinator), root)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

describe("workspace registry", () => {
  it("create adopts a directory: id, path, basename title, empty account", async () => {
    await withRegistry(async (registry) => {
      const { workspace, created } = await registry.create("C:\\projects\\app")
      expect(created).toBe(true)
      expect(workspace.workspaceId).toMatch(/^ws-[0-9a-f]{8}$/)
      expect(workspace.path).toBe("C:\\projects\\app")
      expect(workspace.title).toBe("app")
      expect(workspace.sessionIds).toEqual([])
      expect(workspace.createdAt).toBeTruthy()
      expect(workspace.updatedAt).toBe(workspace.createdAt)
    })
  })

  it("create is idempotent by path (DSH resolveByPath parity)", async () => {
    await withRegistry(async (registry) => {
      const first = await registry.create("/srv/app")
      const again = await registry.create("/srv/app") // trailing separator normalizes
      expect(again.created).toBe(false)
      expect(again.workspace.workspaceId).toBe(first.workspace.workspaceId)
      const listed = await registry.list()
      expect(listed).toHaveLength(1)
    })
  })

  it("create rejects blank/separator-only paths with workspace-invalid-path", async () => {
    await withRegistry(async (registry) => {
      for (const bad of ["", "   ", "/", "\\\\", "   \\  "]) {
        await expect(registry.create(bad)).rejects.toMatchObject({
          name: "WorkspaceInvalidPathError",
          code: "workspace-invalid-path",
        })
      }
    })
  })

  it("rename sets a unique title; blank → bad-request; unknown → not-found; duplicate → name-conflict", async () => {
    await withRegistry(async (registry) => {
      const { workspace: app } = await registry.create("/srv/app")
      const { workspace: api } = await registry.create("/srv/api")

      const renamed = await registry.rename(app.workspaceId, "控制台")
      expect(renamed.title).toBe("控制台")

      await expect(registry.rename(app.workspaceId, "   ")).rejects.toBeInstanceOf(WorkspaceBadRequestError)
      await expect(registry.rename("ws-missing", "x")).rejects.toBeInstanceOf(WorkspaceNotFoundError)
      await expect(registry.rename(api.workspaceId, "控制台")).rejects.toMatchObject({
        code: "workspace-name-conflict",
        message: "workspace name '控制台' is already in use",
      })
    })
  })

  it("rename resolves without writing when the title is unchanged", async () => {
    await withRegistry(async (registry) => {
      const { workspace } = await registry.create("/srv/app")
      const same = await registry.rename(workspace.workspaceId, "app")
      expect(same.title).toBe("app")
    })
  })

  it("attachSession prepends (DSH) and is idempotent", async () => {
    await withRegistry(async (registry) => {
      const { workspace } = await registry.create("/srv/app")
      await registry.attachSession(workspace.workspaceId, "sess-a")
      const after = await registry.attachSession(workspace.workspaceId, "sess-b")
      expect(after.sessionIds).toEqual(["sess-b", "sess-a"])
      const again = await registry.attachSession(workspace.workspaceId, "sess-a")
      expect(again.sessionIds).toEqual(["sess-b", "sess-a"])
      await expect(registry.attachSession("ws-missing", "sess-z")).rejects.toBeInstanceOf(WorkspaceNotFoundError)
    })
  })

  it("persists durability: a fresh registry over the same store sees the state", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-workspace-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    try {
      const first = createWorkspaceRegistry(coordinator)
      const { workspace } = await first.create("/srv/app")
      await first.rename(workspace.workspaceId, "控制台")
      await first.attachSession(workspace.workspaceId, "sess-1")
      // New registry process sees the same doc (subagent snapshot pattern).
      const second = createWorkspaceRegistry(coordinator)
      const [view] = await second.list()
      expect(view!.workspaceId).toBe(workspace.workspaceId)
      expect(view!.title).toBe("控制台")
      expect(view!.sessionIds).toEqual(["sess-1"])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("stores the snapshot under the workspace-registry doc key", async () => {
    await withRegistry(async (registry, root) => {
      await registry.create("/srv/app")
      const coordinator = createSessionCoordinator(createJsonlBackend(root))
      const doc = await coordinator.getDocument(WORKSPACE_DOC_KEY)
      expect(doc).toMatchObject({ formatVersion: 1, workspaces: [{ path: "/srv/app", title: "app" }] })
    })
  })

  it("concurrent mutations are serialized (no lost read-modify-write)", async () => {
    await withRegistry(async (registry) => {
      const { workspace } = await registry.create("/srv/app")
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => registry.attachSession(workspace.workspaceId, `sess-${i}`)),
      )
      const [view] = await registry.list()
      expect(view!.sessionIds).toHaveLength(8)
    })
  })
})


describe("workspace registry archive (task 3.2, DSH archiveSession parity)", () => {
  // Test helper: a real session file must exist for archiveSession's
  // persistence-list gate (registry.archiveSession validates against the
  // REGISTRY's coordinator.list() — same store root, DSH unknown-session refusal).
  // (branch carried a workspaceId meta option here — web-region SessionMeta
  // extension that main's coordinator shape does not include / E does not adopt)
  const makeSession = (root: string): Promise<{ id: string }> => {
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    return coordinator.create()
  }

  it("archiveSession hides a session into the registry-GLOBAL set; the workspace account keeps the id (DSH)", async () => {
    await withRegistry(async (registry, root) => {
      const { workspace } = await registry.create("/srv/app")
      const { id } = await makeSession(root)
      await registry.attachSession(workspace.workspaceId, id)
      expect(await registry.archivedSessionIds()).toEqual([])
      expect(await registry.archiveSession(id)).toEqual([id])
      expect(await registry.archivedSessionIds()).toEqual([id])
      // Display-set layering: membership untouched — unarchive restores the slot.
      const [view] = await registry.list()
      expect(view!.sessionIds).toContain(id)
    })
  })

  it("archiveSession accepts an unaccounted session (no workspace) — DSH stray parity", async () => {
    await withRegistry(async (registry, root) => {
      const { id } = await makeSession(root)
      expect(await registry.archiveSession(id)).toEqual([id])
    })
  })

  it("archiveSession is idempotent — a repeat neither rewrites nor duplicates", async () => {
    await withRegistry(async (registry, root) => {
      const { id } = await makeSession(root)
      await registry.archiveSession(id)
      expect(await registry.archiveSession(id)).toEqual([id])
      expect(await registry.archivedSessionIds()).toEqual([id])
    })
  })

  it("archiveSession rejects an unknown session id fail-loud (session-not-found); nothing is written", async () => {
    await withRegistry(async (registry) => {
      await expect(registry.archiveSession("ghost")).rejects.toMatchObject({
        name: "WorkspaceUnknownSessionError",
        code: "session-not-found",
      })
      expect(await registry.archivedSessionIds()).toEqual([])
    })
  })

  it("unarchiveSession removes (idempotent; unknown/never-archived ids are no-ops)", async () => {
    await withRegistry(async (registry, root) => {
      const { id } = await makeSession(root)
      await registry.archiveSession(id)
      expect(await registry.unarchiveSession(id)).toEqual([])
      expect(await registry.unarchiveSession(id)).toEqual([]) // idempotent
      expect(await registry.unarchiveSession("ghost")).toEqual([]) // no-op, no unknown-session channel
      expect(await registry.archivedSessionIds()).toEqual([])
    })
  })

  it("persists across registries; a pre-3.2 doc (no archivedSessionIds) defaults to []  then writes the field back", async () => {
    const root = await mkdtemp(join(tmpdir(), "i-harness-workspace-"))
    const coordinator = createSessionCoordinator(createJsonlBackend(root))
    try {
      const first = createWorkspaceRegistry(coordinator)
      const { id } = await coordinator.create({})
      await first.archiveSession(id)
      const second = createWorkspaceRegistry(coordinator)
      expect(await second.archivedSessionIds()).toEqual([id])
      // Pre-3.2 doc shape on disk — the field is absent.
      await coordinator.putDocument("workspace-registry", { formatVersion: 1, workspaces: [] })
      const third = createWorkspaceRegistry(coordinator)
      expect(await third.archivedSessionIds()).toEqual([])
      await third.create("/srv/new")
      const doc = await coordinator.getDocument("workspace-registry")
      expect((doc as { archivedSessionIds?: unknown }).archivedSessionIds).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("concurrent archive mutations are serialized (archived ids never lost)", async () => {
    await withRegistry(async (registry, root) => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => makeSession(root)))
      await Promise.all(ids.map(async (s) => { await registry.archiveSession(s.id) }))
      expect(await registry.archivedSessionIds()).toEqual(ids.map((s) => s.id))
    })
  })
})
