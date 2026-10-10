import { expect, it } from "vitest"
import { collectProjectSessions, type WorkspaceSessionSnapshot } from "../src/renderer/shell/project-sessions.ts"

const folder = { id: "shared", label: "Shared folder", path: "D:/shared" }
const session = { id: "native-chat", title: "Shared history", live: false }
const snapshot = (projectId?: string): WorkspaceSessionSnapshot => ({ dashboard: { sessions: [session] }, navigation: { "native-chat": { pinned: false, unread: false, ...(projectId ? { projectId } : {}) } } })
const collect = (projectId: string | undefined, owner: string | undefined) => collectProjectSessions({
  workspaces: [folder], snapshots: { shared: snapshot(owner) }, projectId,
  memberWorkspaceIds: new Set(["shared"]), assignedWorkspaceIds: new Set(["shared"]), knownProjectIds: new Set(["A", "B"]),
})

it("groups existing history only by its confirmed saved project owner", () => {
  expect(collect("A", undefined)).toEqual([])
  expect(collect("B", undefined)).toEqual([])
  expect(collect("A", "B")).toEqual([])
  expect(collect("B", "B").map(row => row.source)).toEqual([{ workspaceId: "shared", sessionId: "native-chat", projectId: "B" }])
  expect(collect(undefined, undefined).map(row => row.source)).toEqual([{ workspaceId: "shared", sessionId: "native-chat" }])
  expect(collect(undefined, "removed").map(row => row.source)).toEqual([{ workspaceId: "shared", sessionId: "native-chat", projectId: "removed" }])
  expect(collect("removed", "removed")).toEqual([])
})

it("deduplicates source tuples while retaining identical native session IDs from different folders", () => {
  const other = { ...folder, id: "other", path: "D:/other" }
  const rows = collectProjectSessions({ workspaces: [folder, folder, other], snapshots: {
    shared: { ...snapshot("A"), dashboard: { sessions: [session, session] } }, other: snapshot("A"),
  }, projectId: "A", memberWorkspaceIds: new Set(["shared", "other"]), assignedWorkspaceIds: new Set(["shared", "other"]), knownProjectIds: new Set(["A"]) })
  expect(rows.map(row => ({ key: row.key, source: row.source }))).toEqual([
    { key: '["shared","native-chat"]', source: { workspaceId: "shared", sessionId: "native-chat", projectId: "A" } },
    { key: '["other","native-chat"]', source: { workspaceId: "other", sessionId: "native-chat", projectId: "A" } },
  ])
})

it("orders project conversations by actual activity across folders with pinned rows first and unknown dates retained", () => {
  const other = { ...folder, id: "other", path: "D:/other" }
  const rows = collectProjectSessions({ workspaces: [folder, other], snapshots: {
    shared: { dashboard: { sessions: [
      { id: "old", title: "Old", live: false, updatedAt: 1791594000000 },
      { id: "unknown", title: "Unknown", live: false },
      { id: "pinned", title: "Pinned", live: false, updatedAt: 1791507600000 },
    ] }, navigation: { old: { pinned: false, unread: false, projectId: "A" }, unknown: { pinned: false, unread: false, projectId: "A" }, pinned: { pinned: true, unread: false, projectId: "A" } } },
    other: { dashboard: { sessions: [
      { id: "recent", title: "Recent", live: false, updatedAt: 1791601200000 },
      { id: "invalid-time", title: "Invalid time", live: false, updatedAt: Number.NaN },
    ] }, navigation: { recent: { pinned: false, unread: false, projectId: "A" }, "invalid-time": { pinned: false, unread: false, projectId: "A" } } },
  }, projectId: "A", memberWorkspaceIds: new Set(["shared", "other"]), assignedWorkspaceIds: new Set(["shared", "other"]), knownProjectIds: new Set(["A"]) })
  expect(rows.map(row => row.source.sessionId)).toEqual(["pinned", "recent", "old", "unknown", "invalid-time"])
  expect(rows.find(row => row.source.sessionId === "unknown")!.session.updatedAt).toBeUndefined()
})
