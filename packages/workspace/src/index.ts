/**
 * Workspace registry (DSH workspace-controller parity, minimal viable set).
 *
 * A Workspace is a durable registration over an EXISTING directory (the path
 * is the user's workspace; registration never creates or deletes it) plus a
 * display title and the account of sessions attached to it. The registry is
 * one JSON document stored through the session coordinator's generic document
 * store (putDocument/getDocument, the subagent-snapshot pattern — M6): one
 * durable `workspace-registry` doc, `<root>/.doc` sidecar on the jsonl
 * backend.
 *
 * DSH names kept aligned (packages/workspace in the reference project):
 *   create (adopt a directory, idempotent by path) → { workspace, created },
 *   rename (unique non-blank title), attachSession (DSH `attachSession`,
 *   prepends), list/get. Registry rows carry workspaceId/path/title/
 *   sessionIds/createdAt/updatedAt — the WorkspaceView vocabulary.
 *   archiveSession (Task 3.2): the REGISTRY-GLOBAL archived id set (DSH
 *   workspaceDomainState.archivedSessionIds) layered over workspace
 *   accounting — an archived session KEEPS its sessionIds slot (the account
 *   never moves; unarchive restores the position), the set only hides the row
 *   from grouping surfaces. Built exactly like DSH: archiveSession(sessionId)
 *   takes no workspace id, accepts accounted AND unaccounted sessions, is
 *   idempotent, and REJECTS unknown ids (a session neither listed by
 *   persistence nor live → WorkspaceUnknownSessionError → session-not-found).
 *   DELIBERATE ADDITIVE EXTENSION vs DSH: `unarchiveSession` (restore) — DSH
 *   has no restore verb, but a one-way archive set without a way back is a
 *   footgun for the sidebar's 已存檔 section; the name/behavior (idempotent
 *   removal, no unknown-session channel) is the natural inverse.
 *
 * Deliberately DEFERRED (Task 3.1 controller ruling — seams noted in code,
 * not implemented):
 *   - `delete`: removing a registration without touching the directory;
 *     seam: DELETE /api/workspaces/:id in the host (route intentionally absent
 *     so it answers the generic JSON 404 until a later task adds it).
 *   - `insertBefore` / `insertSessionBefore` (registry + per-workspace display
 *     order): sessionIds here is append-first (attachSession unshifts, DSH
 *     order) but reordering APIs are out of the minimal set.
 *   - `follow` (reconnect baseline + ordered increments): the web host's list
 *     routes already serve a full baseline per request; the live stream is a
 *     later task.
 *   - `status` / directory liveness ('ok' | 'missing-dir'): the host route
 *     stats the path at create; liveness tracking is deferred.
 *
 * Errors carry the DSH failure codes ('bad-request', 'workspace-invalid-path',
 * 'workspace-not-found', 'workspace-name-conflict') so the host can map them
 * to HTTP statuses without string matching.
 */

import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type { SessionCoordinator } from "@i-harness/session-persistence"

// Task 5.4b: the bounded directory walk behind the @ reference picker
// (DSH fileReferences.list parity, simplified) — a pure node:fs function over
// a registered workspace directory. Separate module: the registry itself
// stays fs-free (its comments: "the registry has no fs") — this walker is
// the DSH file-reference provider the embedder composes over a workspace path.
export {
  DEFAULT_LIST_FILES_OPTIONS,
  DEFAULT_LIST_FILES_SKIP_NAMES,
  listWorkspaceFiles,
  type FileReferenceCandidate,
  type ListWorkspaceFilesOptions,
} from "./files.ts"

/** The coordinator document key holding the whole registry snapshot. */
export const WORKSPACE_DOC_KEY = "workspace-registry"

/** One durable Workspace record (the WorkspaceView shape in DSH terms). */
export interface Workspace {
  /** Stable generated id (uuid-ish), never the path — paths may be rewritten. */
  workspaceId: string
  /** Canonical directory path, resolved by the caller (host) at create. */
  path: string
  /** Display title; defaults to basename(path) at create. Duplicates allowed. */
  title: string
  /** Sessions accounted to this Workspace (attach prepends, DSH parity). */
  sessionIds: string[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last durable mutation. */
  updatedAt: string
}

/** Durable snapshot shape (subagent snapshot pattern: versioned whole-state doc). */
export interface WorkspaceSnapshot {
  formatVersion: 1
  workspaces: Workspace[]
  /**
   * Registry-global archive set (DSH parity — global, NOT per workspace:
   * archiveSession takes a session id only and the API value is the whole
   * `archivedSessionIds` array). Optional on disk: records written before
   * task 3.2 lack the field and load() defaults it to [] (DSH
   * ZodDefault parity: "Defaulted so records written before the field parse
   * unchanged").
   */
  archivedSessionIds?: string[]
}

/** The requested path is blank or malformed (DSH: workspace-invalid-path). */
export class WorkspaceInvalidPathError extends Error {
  readonly code = "workspace-invalid-path" as const
  constructor(message: string, readonly path: string) {
    super(message)
    this.name = "WorkspaceInvalidPathError"
  }
}

/** The request payload violates a semantic input constraint (DSH: bad-request). */
export class WorkspaceBadRequestError extends Error {
  readonly code = "bad-request" as const
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceBadRequestError"
  }
}

/** The referenced workspace record does not exist (DSH: workspace-not-found). */
export class WorkspaceNotFoundError extends Error {
  readonly code = "workspace-not-found" as const
  constructor(message: string, readonly workspaceId: string) {
    super(message)
    this.name = "WorkspaceNotFoundError"
  }
}

/** The proposed title duplicates another workspace's (DSH: workspace-name-conflict). */
export class WorkspaceNameConflictError extends Error {
  readonly code = "workspace-name-conflict" as const
  constructor(message: string, readonly name: string) {
    super(message)
    this.name = "WorkspaceNameConflictError"
  }
}

/**
 * archiveSession named a session neither listed by persistence nor live
 * (DSH: WorkspaceUnknownSessionError → the API layer maps it to
 * session-not-found). Refusing is a fail-loud guard: a typo'd hide request
 * must never silently record a dangling id in a DISPLAY set the user cannot
 * see enumerated.
 */
export class WorkspaceUnknownSessionError extends Error {
  readonly code = "session-not-found" as const
  constructor(message: string, readonly sessionId: string) {
    super(message)
    this.name = "WorkspaceUnknownSessionError"
  }
}

export interface WorkspaceRegistry {
  /** All workspaces, registry order (creation order; DSH reorder deferred). */
  list(): Promise<Workspace[]>
  /** One workspace by id, or undefined when unknown. */
  get(workspaceId: string): Promise<Workspace | undefined>
  /**
   * Create (adopt) a directory as a Workspace — idempotent by path: a second
   * create for the same canonical path resolves the existing record with
   * `created: false` (DSH resolveByPath parity).
   */
  create(path: string): Promise<{ workspace: Workspace; created: boolean }>
  /** Rename to a unique non-blank title (DSH rename parity). */
  rename(workspaceId: string, title: string): Promise<Workspace>
  /**
   * Attach a session to a workspace (DSH `attachSession`, prepends). Idempotent.
   * Simplified from DSH insertSessionBefore: no ordering control (deferred).
   * A previously ARCHIVED session keeps its archive slot (archive is a
   * display-set layer, not an account change — DSH parity).
   */
  attachSession(workspaceId: string, sessionId: string): Promise<Workspace>
  /** The complete registry-global archived session id set (DSH parity). */
  archivedSessionIds(): Promise<string[]>
  /**
   * Hide one session from grouping surfaces (DSH `archiveSession`): idempotent
   * add to the global archive set; workspace accounting is untouched.
   * Rejects an unknown session id with WorkspaceUnknownSessionError
   * (fail-loud — no dangling ids in a display set).
   */
  archiveSession(sessionId: string): Promise<string[]>
  /**
   * Restore one archived session (DELIBERATE extension vs DSH — DSH has no
   * restore verb; without it the 已存檔 section is one-way). Idempotent
   * removal; an unknown session id is a no-op (the set only shrinks).
   */
  unarchiveSession(sessionId: string): Promise<string[]>
}

/**
 * Registry over the SessionCoordinator document store. Mutations are
 * serialized on one promise chain (DSH operationTail parity): two concurrent
 * read-modify-write cycles on the shared doc must never interleave and lose
 * one's write. Reads join the chain too, so a list during a mutation observes
 * either the pre- or post-state, never a torn one.
 */
export function createWorkspaceRegistry(coordinator: SessionCoordinator): WorkspaceRegistry {
  let chain: Promise<void> = Promise.resolve()
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op)
    chain = run.then(() => {}, () => {}) // keep the tail alive after failures
    return run
  }

  async function load(): Promise<WorkspaceSnapshot> {
    const doc = await coordinator.getDocument(WORKSPACE_DOC_KEY)
    if (doc === undefined) return { formatVersion: 1, workspaces: [], archivedSessionIds: [] }
    if (
      typeof doc !== "object" || doc === null
      || !Array.isArray((doc as { workspaces?: unknown }).workspaces)
    ) {
      throw new Error(`workspace registry doc is corrupt: ${WORKSPACE_DOC_KEY}`)
    }
    const snap = doc as WorkspaceSnapshot
    // Task 3.2: pre-3.2 docs carry no archivedSessionIds (DSH ZodDefault
    // parity). Normalize on load so EVERY mutator writes the field back — a
    // mutation that touches only workspaces must not strip the archive set.
    if (!Array.isArray(snap.archivedSessionIds)) snap.archivedSessionIds = []
    return snap
  }

  return {
    list() {
      return serialize(async () => (await load()).workspaces)
    },
    get(workspaceId) {
      return serialize(async () => (await load()).workspaces.find(w => w.workspaceId === workspaceId))
    },
    create(path) {
      return serialize(async () => {
        const raw = typeof path === "string" ? path.trim() : ""
        if (raw === "") {
          throw new WorkspaceInvalidPathError("workspace path must be a non-blank string", raw)
        }
        // Pure normalization only — the caller (host route) realpaths the path
        // and stats the directory before calling here; the registry has no fs.
        const resolved = raw.replace(/[\\/]+$/, "")
        if (resolved === "") {
          throw new WorkspaceInvalidPathError("workspace path must not be a separator", raw)
        }
        const snap = await load()
        const existing = snap.workspaces.find(w => w.path === resolved)
        if (existing !== undefined) return { workspace: existing, created: false }
        const now = new Date().toISOString()
        const workspace: Workspace = {
          workspaceId: `ws-${randomUUID().slice(0, 8)}`,
          path: resolved,
          title: basename(resolved) || resolved,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        }
        snap.workspaces.push(workspace)
        await coordinator.putDocument(WORKSPACE_DOC_KEY, snap)
        return { workspace, created: true }
      })
    },
    rename(workspaceId, title) {
      return serialize(async () => {
        const next = typeof title === "string" ? title.trim() : ""
        if (next === "") {
          throw new WorkspaceBadRequestError("workspace title must be a non-blank string")
        }
        const snap = await load()
        const workspace = snap.workspaces.find(w => w.workspaceId === workspaceId)
        if (workspace === undefined) {
          throw new WorkspaceNotFoundError(`workspace not found: ${workspaceId}`, workspaceId)
        }
        if (snap.workspaces.some(w => w.workspaceId !== workspaceId && w.title === next)) {
          throw new WorkspaceNameConflictError(`workspace name '${next}' is already in use`, next)
        }
        workspace.title = next
        workspace.updatedAt = new Date().toISOString()
        await coordinator.putDocument(WORKSPACE_DOC_KEY, snap)
        return workspace
      })
    },
    attachSession(workspaceId, sessionId) {
      return serialize(async () => {
        const snap = await load()
        const workspace = snap.workspaces.find(w => w.workspaceId === workspaceId)
        if (workspace === undefined) {
          throw new WorkspaceNotFoundError(`workspace not found: ${workspaceId}`, workspaceId)
        }
        if (!workspace.sessionIds.includes(sessionId)) {
          workspace.sessionIds.unshift(sessionId) // DSH prepends new sessions
          workspace.updatedAt = new Date().toISOString()
          await coordinator.putDocument(WORKSPACE_DOC_KEY, snap)
        }
        return workspace
      })
    },
    archivedSessionIds() {
      return serialize(async () => [...(await load()).archivedSessionIds!])
    },
    archiveSession(sessionId) {
      return serialize(async () => {
        // DSH existence gate: the set is a DISPLAY layer, so a hidden id the
        // user can never see listed must not be recordable by typos — the
        // registry holds the persistence list (identical to the host route's
        // session account) and refuses unknown ids fail-loud.
        const known = await coordinator.list()
        if (!known.includes(sessionId)) {
          throw new WorkspaceUnknownSessionError(
            `cannot archive session '${sessionId}': it is not a known session`,
            sessionId,
          )
        }
        const snap = await load()
        if (snap.archivedSessionIds!.includes(sessionId)) return [...snap.archivedSessionIds!] // idempotent, no rewrite
        snap.archivedSessionIds!.push(sessionId)
        await coordinator.putDocument(WORKSPACE_DOC_KEY, snap)
        return [...snap.archivedSessionIds!]
      })
    },
    unarchiveSession(sessionId) {
      return serialize(async () => {
        const snap = await load()
        const without = snap.archivedSessionIds!.filter(id => id !== sessionId)
        if (without.length === snap.archivedSessionIds!.length) {
          return without // already restored / never archived — no rewrite
        }
        snap.archivedSessionIds = without
        await coordinator.putDocument(WORKSPACE_DOC_KEY, snap)
        return [...without]
      })
    },
  }
}
